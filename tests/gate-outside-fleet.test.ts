// Explicit GitHub destinations remain governed outside fleet clones. These tests use the real
// fleet lookup and hash-verified resolver; the temporary caller is a git repository outside the fleet.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import {
  defaultScripts,
  gitReader,
  loadAccessApi,
  resolveAccess,
} from "../access.mjs";
import { decideShell } from "../gate.mjs";
import {
  REPOSITORY_ENV,
  REPOSITORY_ENV_PREFIXES,
} from "../lib/environment.mjs";
import { fleetLookup } from "../lib/fleet.mjs";
import type { Observation } from "../lib/observation.mjs";
import {
  buildWorkspace,
  removeDir,
  tempDir,
  writeCatalogLevels,
} from "./support/fixture-workspace.mjs";

let workspace = "";
let outside = "";
let catalog = "";
/** @type {Awaited<ReturnType<typeof loadAccessApi>>} */
let api = null;
let resolverRepo = "unset";

function decide(
  command: string,
  options: {
    shell?: "bash" | "powershell";
    runtime?: "codex";
    cwd?: string;
    env?: string[];
  } = {},
) {
  const cwd = options.cwd ?? outside;
  return decideShell(
    { command, ...options },
    {
      cwd,
      workspaceRoot: workspace,
      lookup: (dir: string) => fleetLookup(dir, workspace),
      resolve: (repo: string, observation: Observation) => {
        resolverRepo = repo;
        return resolveAccess(api, catalog, repo, observation);
      },
      git: gitReader,
      env: options.env ?? [],
    },
  );
}

before(async () => {
  workspace = tempDir("gate-outside-fleet-workspace-");
  outside = tempDir("gate-outside-fleet-caller-");
  execFileSync("git", ["init", "--quiet", outside], { windowsHide: true });
  buildWorkspace(workspace, { level: "read" });
  writeCatalogLevels(workspace, {
    "demo-repo": "propose",
    "two-remote-repo": "merge",
  });
  const scripts = defaultScripts(workspace);
  catalog = scripts.catalog;
  api = await loadAccessApi(scripts.access);
  assert.ok(api, "the pinned resolver did not load");
});

after(() => {
  if (workspace) removeDir(workspace);
  if (outside) removeDir(outside);
});

test("outside-fleet admin writes use the explicitly pinned organization destination", () => {
  for (const command of [
    "gh label create gate-probe -R simpsonm09-org/simpsonm09-gate-probe-missing",
    "gh pr merge 1 -R simpsonm09-org/simpsonm09-repo-catalog --admin",
    "gh repo delete simpsonm09-org/simpsonm09-repo-catalog --yes",
  ]) {
    const decision = decide(command);
    assert.equal(decision.action, "deny", command);
    assert.match(decision.reason ?? "", /simpsonm09-org\/.*level/, command);
    assert.match(
      decision.reason ?? "",
      new RegExp(`at level "${decision.level}"`),
      command,
    );
    assert.equal(decision.repo, null);
    assert.equal(
      resolverRepo,
      "",
      "resolver must receive no local clone identity",
    );
  }
});

test("outside-fleet ordinary merge follows the destination access level", () => {
  const command = "gh pr merge 52 -R simpsonm09-org/two-remote-repo -m --merge";
  writeCatalogLevels(workspace, {
    "demo-repo": "propose",
    "two-remote-repo": "merge",
  });
  const allowed = decide(command);
  assert.equal(allowed.action, "pass");
  assert.equal(allowed.level, "merge");
  assert.equal(
    allowed.auth,
    undefined,
    "outside-fleet commands use ambient auth",
  );

  writeCatalogLevels(workspace, {
    "demo-repo": "propose",
    "two-remote-repo": "propose",
  });
  const denied = decide(command);
  assert.equal(denied.action, "deny");
  assert.equal(denied.level, "propose");
  assert.match(
    denied.reason ?? "",
    /simpsonm09-org\/two-remote-repo denies .* at level "propose"/,
  );
});

test("an organization repository missing from the catalog is denied outside the fleet", () => {
  const decision = decide(
    "gh pr merge 1 -R simpsonm09-org/not-in-catalog --admin",
  );
  assert.equal(decision.action, "deny");
  assert.match(decision.reason ?? "", /simpsonm09-org\/not-in-catalog/);
});

test("a third-party repository pinned outside the fleet is denied as unknown", () => {
  const decision = decide("gh pr merge 1 -R third-party/repo --admin");
  assert.equal(decision.action, "deny");
  assert.match(decision.reason ?? "", /third-party\/repo/);
});

test("an explicitly pinned read passes outside the fleet", () => {
  const decision = decide("gh pr view 1 -R simpsonm09-org/demo-repo");
  assert.equal(decision.action, "pass");
  assert.equal(decision.auth, undefined);
});

test("unresolved and unsupported gh writes fail closed outside the fleet", () => {
  writeCatalogLevels(workspace, {
    "demo-repo": "propose",
    "two-remote-repo": "merge",
  });
  const commands = [
    "gh api -X DELETE repos/simpsonm09-org/simpsonm09-repo-catalog",
    "gh pr merge https://github.com/simpsonm09-org/two-remote-repo/pull/1",
    "gh issue close https://github.com/simpsonm09-org/two-remote-repo/issues/1",
    "gh repo edit simpsonm09-org/two-remote-repo --description x",
    "gh repo rename simpsonm09-org/two-remote-repo",
    "gh repo archive simpsonm09-org/two-remote-repo --yes",
    "gh repo unarchive simpsonm09-org/two-remote-repo --yes",
    "gh repo delete simpsonm09-org/two-remote-repo --yes",
    "gh repo sync simpsonm09-org/two-remote-repo",
    "gh secret set NAME --body x -R simpsonm09-org/two-remote-repo",
    "gh secret delete NAME -R simpsonm09-org/two-remote-repo",
    "gh variable set NAME --body x -R simpsonm09-org/two-remote-repo",
    "gh variable delete NAME -R simpsonm09-org/two-remote-repo",
    "gh workflow run ci.yml -F name=x -R simpsonm09-org/two-remote-repo",
    "gh workflow run ci.yml --json -R simpsonm09-org/two-remote-repo",
    "gh pr merge 1 -R simpsonm09-org/demo-repo -R simpsonm09-org/two-remote-repo",
    "gh repo delete simpsonm09-org/two-remote-repo --yes; echo done",
    "GH_REPO=simpsonm09-org/two-remote-repo gh pr merge 1",
    "gh pr merge 1 --admin",
  ];
  for (const command of commands) {
    const decision = decide(command);
    if (command.includes("github.com/simpsonm09-org/two-remote-repo/pull/")) {
      assert.equal(decision.action, "pass", command);
      continue;
    }
    assert.equal(decision.action, "deny", command);
    assert.match(
      decision.reason ?? "",
      command.startsWith("gh api -X DELETE")
        ? /simpsonm09-org\/simpsonm09-repo-catalog/
        : /fleet clone|pin -R OWNER\/REPO|simpsonm09-org\//,
      command,
    );
  }
  const inherited = decide("gh pr merge 1 --admin", {
    env: ["GH_REPO"],
  });
  assert.equal(inherited.action, "deny");
  assert.match(inherited.reason ?? "", /GH_REPO/);
  for (const name of [
    ...REPOSITORY_ENV,
    ...REPOSITORY_ENV_PREFIXES.map((prefix) => `${prefix}0`),
  ]) {
    const overridden = decide("gh pr merge 1 --admin", { env: [name] });
    assert.equal(overridden.action, "deny", name);
    assert.match(overridden.reason ?? "", new RegExp(name), name);
  }
  const powershell = decide(
    "& gh repo delete simpsonm09-org/two-remote-repo --yes; Write-Output done",
    { shell: "powershell" },
  );
  assert.equal(powershell.action, "deny");
  assert.match(powershell.reason ?? "", /fleet clone|pin -R OWNER\/REPO/);
  const powershellAssignment = decide(
    "$env:GH_REPO='simpsonm09-org/two-remote-repo'; & gh pr merge 1",
    { shell: "powershell" },
  );
  assert.equal(powershellAssignment.action, "deny");
  assert.match(
    powershellAssignment.reason ?? "",
    /fleet clone|pin -R OWNER\/REPO/,
  );
  for (const command of [
    "& gh pr merge https://github.com/simpsonm09-org/two-remote-repo/pull/1",
    "& gh issue close https://github.com/simpsonm09-org/two-remote-repo/issues/1",
    "& gh repo edit simpsonm09-org/two-remote-repo --description x",
    "& gh secret set NAME --body x -R simpsonm09-org/two-remote-repo",
    "& gh workflow run ci.yml --json -R simpsonm09-org/two-remote-repo",
    "& gh pr merge 1 -R simpsonm09-org/demo-repo -R simpsonm09-org/two-remote-repo",
  ]) {
    const decision = decide(command, { shell: "powershell" });
    if (command.includes("github.com/simpsonm09-org/two-remote-repo/pull/")) {
      assert.equal(decision.action, "pass", command);
      continue;
    }
    assert.equal(decision.action, "deny", command);
    assert.match(
      decision.reason ?? "",
      /simpsonm09-org\/|fleet clone|pin -R OWNER\/REPO/,
      command,
    );
  }
});

test("API endpoint destinations are authoritative and GET endpoint reads pass", () => {
  const read = decide("gh api repos/simpsonm09-org/two-remote-repo");
  assert.equal(read.action, "pass");
  const apiWrite = decide(
    "gh api -X DELETE repos/simpsonm09-org/two-remote-repo",
  );
  assert.equal(apiWrite.action, "deny");
  assert.match(apiWrite.reason ?? "", /simpsonm09-org\/two-remote-repo/);
  const conflict = decide(
    "gh api -R simpsonm09-org/demo-repo -X POST repos/simpsonm09-org/two-remote-repo/issues",
  );
  assert.equal(conflict.action, "deny");
  assert.match(conflict.reason ?? "", /fleet clone|pin -R OWNER\/REPO/);
});

test("fleet API endpoint writes are judged against their endpoint repository", () => {
  writeCatalogLevels(workspace, {
    "demo-repo": "full",
    "two-remote-repo": "merge",
  });
  const clone = `${workspace}\\projects\\repos\\demo-repo`;
  const otherRepo = decide(
    "gh api -X POST repos/simpsonm09-org/two-remote-repo/issues",
    { cwd: clone },
  );
  assert.equal(otherRepo.action, "deny");
  assert.equal(otherRepo.level, "merge");
  assert.match(otherRepo.reason ?? "", /simpsonm09-org\/two-remote-repo/);
  const conflict = decide(
    "gh api -R simpsonm09-org/demo-repo -X POST repos/simpsonm09-org/two-remote-repo/issues",
    { cwd: clone },
  );
  assert.equal(conflict.action, "deny");
});

test("a non-fleet git repository still denies an unpinned write", () => {
  const decision = decide("gh pr create --title x");
  assert.equal(decision.action, "deny");
  assert.match(decision.reason ?? "", /fleet clone|pin -R OWNER\/REPO/);
});

test("an explicit allowed write outside the fleet passes at merge", () => {
  writeCatalogLevels(workspace, {
    "demo-repo": "propose",
    "two-remote-repo": "merge",
  });
  const decision = decide(
    "gh pr merge 52 -R simpsonm09-org/two-remote-repo -m --merge",
  );
  assert.equal(decision.action, "pass");
  assert.equal(decision.level, "merge");
  assert.equal(decision.auth, undefined);
});

test("PowerShell explicit destinations are resolved outside the fleet", () => {
  const decision = decide(
    "& gh pr merge 1 -R simpsonm09-org/simpsonm09-repo-catalog --admin",
    { shell: "powershell" },
  );
  assert.equal(decision.action, "deny");
  assert.match(
    decision.reason ?? "",
    /simpsonm09-org\/simpsonm09-repo-catalog/,
  );
});

test("Codex continues to deny every governed outside-fleet write", () => {
  const decision = decide(
    "gh pr merge 52 -R simpsonm09-org/two-remote-repo --admin --merge",
    { runtime: "codex" },
  );
  assert.equal(decision.action, "deny");
  assert.match(decision.reason ?? "", /Codex/);
});
