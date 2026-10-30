// The shared decision (gate.mjs decideShell and gateShellEdit) with the resolver's answer
// injected, and the adapter-side access functions (access.mjs) that feed it. These are the
// rules both harnesses use, so each is asserted directly, not only through a harness.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  levelFor,
  observeCommand,
  resolveAccess,
  tokenFor,
} from "../access.mjs";
import {
  decideShell,
  denyCommand,
  denyMessage,
  fileName,
  gateShellEdit,
  isPowerShell,
  isWorktreePath,
  shouldInject,
} from "../gate.mjs";
import { removeDir, tempDir } from "./support/fixture-workspace.mjs";

const ws = resolve("ws-root");
const cwd = join(ws, "projects", "repos", "demo-repo");

// The stub resolver ignores the observation and returns the given result; the observation is
// still recorded so a test can assert what the observer saw.
function deps(
  result: { code: number; stdout: string },
  extra: Record<string, unknown> = {},
) {
  const calls: Array<{
    repo: string;
    observation: import("../lib/observation.mjs").Observation;
  }> = [];
  return {
    calls,
    deps: {
      cwd,
      workspaceRoot: ws,
      resolve: (
        repo: string,
        observation: import("../lib/observation.mjs").Observation,
      ) => {
        calls.push({ repo, observation });
        return result;
      },
      git: () => (args: string[]) => {
        const query = args.join(" ");
        if (query === "remote") return "origin";
        if (query === "remote get-url origin")
          return "https://github.com/simpsonm09-org/demo-repo.git";
        return null;
      },
      env: [],
      ...extra,
    },
  };
}

test("a directory outside the fleet passes without asking the resolver", () => {
  const spy = deps({ code: 1, stdout: JSON.stringify({ level: "read" }) });
  const decision = decideShell(
    { command: "git push origin main" },
    { ...spy.deps, cwd: join(ws, "elsewhere") },
  );
  assert.equal(decision.action, "pass");
  assert.equal(decision.repo, null);
  assert.equal(spy.calls.length, 0);
});

test("a resolver denial is a deny with the level it resolved", () => {
  const decision = decideShell(
    { command: "gh pr merge 1" },
    deps({
      code: 1,
      stdout: JSON.stringify({
        level: "read",
        capability: "mergePr",
        allowed: false,
        kind: "org",
      }),
    }).deps,
  );
  assert.deepEqual(decision, {
    action: "deny",
    repo: "demo-repo",
    level: "read",
    reason: 'demo-repo denies this command at level "read"',
  });
});

test("a non-organization denial names the destination and the capability", () => {
  const decision = decideShell(
    { command: "gh pr merge 1" },
    deps({
      code: 1,
      stdout: JSON.stringify({
        level: "read",
        capability: "mergePr",
        allowed: false,
        kind: "owned-fork",
        destination: "simpsonm09/pstack-max",
      }),
    }).deps,
  );
  assert.equal(decision.action, "deny");
  assert.match(decision.reason ?? "", /simpsonm09\/pstack-max denies mergePr/);
});

test("a resolver that cannot answer denies a write and passes a read", () => {
  const unknown = { code: 2, stdout: "" };
  assert.equal(
    decideShell({ command: "git push origin main" }, deps(unknown).deps).action,
    "deny",
  );
  assert.equal(
    decideShell({ command: "git status" }, deps(unknown).deps).action,
    "pass",
  );
});

test("an allowed gh call is an inject, and an allowed non-gh call is a pass", () => {
  const ok = {
    code: 0,
    stdout: JSON.stringify({
      level: "propose",
      capability: null,
      allowed: true,
      kind: "org",
      auth: { route: "app", owner: "simpsonm09-org", repo: "demo-repo" },
    }),
  };
  assert.equal(
    decideShell({ command: "gh pr view 1" }, deps(ok).deps).action,
    "inject",
  );
  assert.equal(
    decideShell({ command: "npm test" }, deps(ok).deps).action,
    "pass",
  );
});

test("an allowed gh call to an ambient destination passes without injecting", () => {
  const decision = decideShell(
    { command: "gh pr create -R simpsonm09/pstack-max" },
    deps({
      code: 0,
      stdout: JSON.stringify({
        level: "read",
        capability: "openPr",
        allowed: true,
        kind: "owned-fork",
        destination: "simpsonm09/pstack-max",
        auth: { route: "ambient", owner: null, repo: null },
      }),
    }).deps,
  );
  assert.equal(decision.action, "pass");
});

test("the shared decision reads an executable spelling of gh and git as the plain name", () => {
  const ok = {
    code: 0,
    stdout: JSON.stringify({
      level: "propose",
      capability: null,
      allowed: true,
      kind: "org",
      auth: { route: "app", owner: "simpsonm09-org", repo: "demo-repo" },
    }),
  };
  assert.equal(
    decideShell(
      { command: '"C:\\Program Files\\GitHub CLI\\gh.exe" pr view 1' },
      deps(ok).deps,
    ).action,
    "inject",
  );
  const spy = deps(ok);
  decideShell({ command: "GIT.exe push origin main" }, spy.deps);
  assert.deepEqual(
    spy.calls.map((call) => call.observation.operation),
    ["push"],
    "the observer reads the plain name",
  );
});

test("a leading space keeps a gh call out of the injection, as HEAD did", () => {
  assert.equal(shouldInject(" gh pr view 1"), false);
  assert.equal(
    decideShell(
      { command: " gh pr view 1" },
      deps({
        code: 0,
        stdout: JSON.stringify({
          level: "propose",
          capability: null,
          allowed: true,
          kind: "org",
          auth: { route: "app", owner: "simpsonm09-org", repo: "demo-repo" },
        }),
      }).deps,
    ).action,
    "pass",
  );
});

test("the resolver is asked for every fleet command, with the observer's observation", () => {
  const spy = deps({ code: 0, stdout: JSON.stringify({ level: "propose" }) });
  decideShell({ command: "git push origin main" }, spy.deps);
  decideShell({ command: "git status" }, spy.deps);
  assert.equal(spy.calls.length, 2);
  assert.equal(spy.calls[0].observation.operation, "push");
  assert.equal(spy.calls[1].observation.kind, "local");
});

test("a directory the lookup cannot resolve is a denied write and a passed read, with no resolver call", () => {
  const spy = deps({ code: 0, stdout: JSON.stringify({ level: "propose" }) });
  const write = decideShell(
    { command: "git push origin main" },
    { ...spy.deps, lookup: () => ({ repo: null, unresolved: true }) },
  );
  assert.equal(write.action, "deny");
  assert.match(
    write.reason ?? "",
    /could not be resolved to a fleet repository for this write/,
  );
  const read = decideShell(
    { command: "git status" },
    { ...spy.deps, lookup: () => ({ repo: null, unresolved: true }) },
  );
  assert.equal(read.action, "pass");
  assert.equal(spy.calls.length, 0);
});

test("a gh write from a directory the lookup cannot resolve is a denied write", () => {
  const decision = decideShell(
    { command: "gh pr create --title x" },
    {
      ...deps({ code: 0, stdout: JSON.stringify({ level: "propose" }) }).deps,
      lookup: () => ({ repo: null, unresolved: true }),
    },
  );
  assert.equal(decision.action, "deny");
});

test("an unresolved directory denies a governed write and passes a local command", () => {
  const unresolved = {
    ...deps({ code: 0, stdout: JSON.stringify({ level: "propose" }) }).deps,
    lookup: () => ({ repo: null, unresolved: true }),
  };
  for (const command of [
    "git push origin main",
    "gh pr merge 1",
    "cd x && git push origin main",
  ]) {
    assert.equal(decideShell({ command }, unresolved).action, "deny", command);
  }
  // A quoted mention is not a program word: the observer reads the program, so these pass.
  for (const command of [
    `node -e "console.log('gh pr merge 1')"`,
    `powershell -Command "git push origin main"`,
    "git status",
    "npm test",
  ]) {
    assert.equal(decideShell({ command }, unresolved).action, "pass", command);
  }
});

test("an inherited destination-changing variable denies a governed write and passes a read without a token", () => {
  const ok = {
    code: 0,
    stdout: JSON.stringify({
      level: "propose",
      capability: null,
      allowed: true,
      kind: "org",
      auth: { route: "app", owner: "simpsonm09-org", repo: "demo-repo" },
    }),
  };
  const withEnv = { ...deps(ok, { env: ["GH_REPO"] }).deps };
  const write = decideShell({ command: "git push origin main" }, withEnv);
  assert.equal(write.action, "deny");
  assert.match(write.reason ?? "", /GH_REPO changes which repository/);
  const read = decideShell({ command: "gh pr view 1" }, withEnv);
  assert.equal(read.action, "pass");

  const clean = deps(ok).deps;
  assert.notEqual(
    decideShell({ command: "git push origin main" }, clean).action,
    "deny",
  );
});

test("an inline repository assignment is unsupported, while a benign one stays local", () => {
  const unresolved = {
    ...deps({ code: 0, stdout: JSON.stringify({ level: "propose" }) }).deps,
    lookup: () => ({ repo: null, unresolved: true }),
  };
  assert.equal(
    decideShell({ command: "GIT_DIR=/tmp/x git push origin main" }, unresolved)
      .action,
    "deny",
    "an inline repository assignment is a governed write",
  );
  assert.equal(
    decideShell({ command: "FOO=bar git status" }, unresolved).action,
    "pass",
  );
});

test("a repository missing from the catalog gets an actionable write denial", () => {
  const decision = decideShell(
    { command: "git push origin main" },
    {
      ...deps({ code: 2, stdout: "" }).deps,
      resolve: () => ({ code: 2, stdout: "", catalogMissing: true }),
    },
  );
  assert.equal(decision.action, "deny");
  assert.match(
    decision.reason ?? "",
    /demo-repo is not in the fleet catalog \(simpsonm09-org\/simpsonm09-repo-catalog, repo-catalog\/repos\.json\); add it there before agents can write to it/,
  );
});

test("PowerShell is recognized from a Windows-style path on any platform", () => {
  assert.equal(
    isPowerShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe"),
    true,
  );
  assert.equal(isPowerShell("/opt/microsoft/powershell/7/pwsh"), true);
  assert.equal(
    isPowerShell(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ),
    true,
  );
  assert.equal(isPowerShell("/bin/bash"), false);
  assert.equal(fileName("C:\\a\\b.exe"), "b.exe");
});

test("the injected repository lookup decides which repository a directory is", () => {
  const spy = deps({ code: 1, stdout: JSON.stringify({ level: "read" }) });
  const decision = decideShell(
    { command: "gh pr merge 1" },
    { ...spy.deps, cwd: "anywhere", lookup: () => ({ repo: "other-repo" }) },
  );
  assert.equal(decision.repo, "other-repo");
  assert.equal(spy.calls[0].repo, "other-repo");
});

test("gateShellEdit rewrites a denial and leaves the environment alone", async () => {
  const input: { command: string; shell?: string } = {
    command: "gh pr merge 1",
  };
  const env: Record<string, string> = {};
  await gateShellEdit(input, env, {
    ...deps({
      code: 1,
      stdout: JSON.stringify({
        level: "read",
        capability: "mergePr",
        allowed: false,
        kind: "org",
      }),
    }).deps,
    tokenFor: async () => "never",
  });
  assert.equal(
    input.command,
    denyCommand('demo-repo denies this command at level "read"'),
  );
  assert.deepEqual(env, {});
});

test("gateShellEdit denies an allowed gh call when no token can be minted", async () => {
  const input: { command: string; shell?: string } = {
    command: "gh pr view 1",
  };
  const env: Record<string, string> = {};
  const decision = await gateShellEdit(input, env, {
    ...deps({
      code: 0,
      stdout: JSON.stringify({
        level: "propose",
        capability: null,
        allowed: true,
        kind: "org",
        auth: { route: "app", owner: "simpsonm09-org", repo: "demo-repo" },
      }),
    }).deps,
    tokenFor: async () => null,
  });
  assert.equal(decision.action, "deny");
  assert.equal(
    input.command,
    denyCommand("demo-repo could not mint a token for a gh command"),
  );
  assert.equal(env.GH_TOKEN, undefined);
});

test("gateShellEdit sets GH_TOKEN for an allowed gh call", async () => {
  const input: { command: string } = { command: "gh pr view 1" };
  const env: Record<string, string> = {};
  const decision = await gateShellEdit(input, env, {
    ...deps({
      code: 0,
      stdout: JSON.stringify({
        level: "propose",
        capability: null,
        allowed: true,
        kind: "org",
        auth: { route: "app", owner: "simpsonm09-org", repo: "demo-repo" },
      }),
    }).deps,
    tokenFor: async () => "fixture-token",
  });
  assert.equal(decision.action, "inject");
  assert.equal(input.command, "gh pr view 1");
  assert.equal(env.GH_TOKEN, "fixture-token");
});

test("denyMessage is the reason line both harnesses print", () => {
  assert.equal(denyMessage("x"), "agent-access: denied: x");
});

test("isWorktreePath recognizes a folder under projects/worktrees only", () => {
  assert.equal(
    isWorktreePath(join(ws, "projects", "worktrees", "w"), ws),
    true,
  );
  assert.equal(isWorktreePath(join(ws, "projects", "worktrees"), ws), false);
  assert.equal(isWorktreePath(join(ws, "projects", "repos", "w"), ws), false);
});

test("the access adapter keeps one token per destination", async () => {
  const minted: string[] = [];
  const api = {
    mintForRepo: async (owner: string, repo: string) => {
      minted.push(`${owner}/${repo}`);
      return { token: `token-for-${repo}`, expires_at: "2099-01-01T00:00:00Z" };
    },
  };
  assert.equal(
    await tokenFor(api, "", "simpsonm09-org", "alpha-repo"),
    "token-for-alpha-repo",
  );
  assert.equal(
    await tokenFor(api, "", "simpsonm09-org", "beta-repo"),
    "token-for-beta-repo",
    "a repo never gets another repo's token",
  );
  assert.equal(
    await tokenFor(api, "", "simpsonm09-org", "alpha-repo"),
    "token-for-alpha-repo",
  );
  // The same repository under another owner is a different destination, so it is minted.
  assert.equal(
    await tokenFor(api, "", "simpsonm09", "alpha-repo"),
    "token-for-alpha-repo",
  );
  assert.deepEqual(minted, [
    "simpsonm09-org/alpha-repo",
    "simpsonm09-org/beta-repo",
    "simpsonm09/alpha-repo",
  ]);
});

test("a broker that fails or returns no token yields no token", async () => {
  const failing = { mintForRepo: async () => Promise.reject(new Error("401")) };
  const empty = { mintForRepo: async () => ({ token: "", expires_at: "" }) };
  assert.equal(
    await tokenFor(failing, "", "simpsonm09-org", "gamma-repo"),
    null,
  );
  assert.equal(await tokenFor(empty, "", "simpsonm09-org", "delta-repo"), null);
});

test("a broker script that only ships a CLI mints its token in a Node child process", async () => {
  const dir = tempDir("broker-cli-");
  try {
    const script = join(dir, "agent-token.mjs");
    writeFileSync(
      script,
      'process.stdout.write(JSON.stringify({ token: "cli-token", expires_at: "2099-01-01T00:00:00Z" }));\n',
    );
    assert.equal(
      await tokenFor(null, script, "simpsonm09-org", "cli-repo"),
      "cli-token",
    );
  } finally {
    removeDir(dir);
  }
});

test("a resolver module that throws is an unknown answer, not a crash", () => {
  const api = {
    loadCommittedCatalog: () => {
      throw new Error("no catalog");
    },
    loadCommittedOwnedForks: () => null,
    loadCommittedOwnedRepositories: () => null,
    loadCommittedIgnore: () => null,
    resolveLevel: () => ({}),
    resolveDestination: () => ({ kind: "unknown" }),
    decideTarget: () => ({ capability: null, allowed: true }),
  };
  assert.deepEqual(
    resolveAccess(
      api,
      "unused",
      "demo-repo",
      observeCommand("git push origin main", {}),
    ),
    { code: 2, stdout: "", catalogMissing: false },
  );
});

test("an unknown answer says catalog missing only after a readable catalog confirms it", () => {
  const observation = observeCommand("git push origin main", {});
  const catalogMissing = resolveAccess(
    {
      loadCommittedCatalog: () => ({ repos: [] }),
      loadCommittedOwnedForks: () => null,
      loadCommittedOwnedRepositories: () => null,
      loadCommittedIgnore: () => ({}),
      resolveLevel: () => ({ level: "read", source: "unknown" }),
      resolveDestination: () => ({ kind: "unknown" }),
      decideTarget: () => {
        throw new Error("resolver unavailable");
      },
    },
    undefined,
    "demo-repo",
    observation,
  );
  assert.equal(catalogMissing.catalogMissing, true);

  const unreadable = resolveAccess(
    {
      loadCommittedCatalog: () => null,
      loadCommittedOwnedForks: () => null,
      loadCommittedOwnedRepositories: () => null,
      loadCommittedIgnore: () => ({}),
      resolveLevel: () => ({ level: "read", source: "unknown" }),
      resolveDestination: () => ({ kind: "unknown" }),
      decideTarget: () => ({ capability: null, allowed: false }),
    },
    undefined,
    "demo-repo",
    observation,
  );
  assert.equal(unreadable.catalogMissing, true);
  assert.equal(unreadable.code, 2);
});

test("a missing resolver script is an unknown answer, and the level falls back to read", () => {
  assert.deepEqual(
    resolveAccess(
      null,
      join(ws, "missing.mjs"),
      "demo-repo",
      observeCommand("git push", {}),
    ),
    { code: 2, stdout: "" },
  );
  assert.equal(levelFor(null, "demo-repo"), "read");
});

// A fake resolver whose destination policy level differs from the local clone's roster level.
// The verdict is the destination's, so the reported level and a denial built from it must name
// the destination's level, with the local clone's level kept beside it as the context level.
function destinationLevelApi() {
  return {
    loadCommittedCatalog: () => ({
      org: "simpsonm09-org",
      repos: [{ name: "demo-repo", tier: "standard", agentAccess: "read" }],
    }),
    loadCommittedOwnedForks: () => null,
    loadCommittedOwnedRepositories: () => null,
    loadCommittedIgnore: () => ({}),
    resolveLevel: (_catalog: unknown, name: string) => ({
      repo: name,
      level: "read",
      source: "override",
    }),
    resolveDestination: () => ({
      kind: "org",
      owner: "simpsonm09-org",
      repo: "other-repo",
      level: "full",
      source: "org",
    }),
    decideTarget: () => ({ capability: "mergePr", allowed: false }),
  };
}

test("the reported level is the destination policy level, with the context level beside it", () => {
  const result = resolveAccess(
    destinationLevelApi(),
    "unused",
    "demo-repo",
    observeCommand("gh pr merge 1 -R simpsonm09-org/other-repo", {}),
  );
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.level, "full");
  assert.equal(parsed.contextLevel, "read");
  assert.equal(parsed.destination, "simpsonm09-org/other-repo");
  assert.equal(parsed.kind, "org");
});

test("a cross-repository denial names the destination level, not the local clone's", () => {
  const api = destinationLevelApi();
  const decision = decideShell(
    { command: "gh pr merge 1 -R simpsonm09-org/other-repo" },
    {
      cwd,
      workspaceRoot: ws,
      resolve: (
        repo: string,
        observation: import("../lib/observation.mjs").Observation,
      ) => resolveAccess(api, "unused", repo, observation),
      git: () => null,
      env: [],
    },
  );
  assert.equal(decision.action, "deny");
  assert.equal(decision.level, "full");
  assert.match(decision.reason ?? "", /denies this command at level "full"/);
});

test("an ambiguous gh destination is denied with the -R hint, never an unknown-repository claim", () => {
  const api = {
    ...destinationLevelApi(),
    resolveDestination: () => ({
      kind: "unknown",
      owner: null,
      repo: null,
      level: "none",
      source: "unknown",
    }),
    decideTarget: () => ({ capability: "openPr", allowed: false }),
  };
  const decision = decideShell(
    { command: "gh pr create --title x" },
    {
      cwd,
      workspaceRoot: ws,
      resolve: (
        repo: string,
        observation: import("../lib/observation.mjs").Observation,
      ) => resolveAccess(api, "unused", repo, observation),
      git: () => null,
      env: [],
    },
  );
  assert.equal(decision.action, "deny");
  assert.match(
    decision.reason ?? "",
    /specify -R owner\/repo for a new operation/,
  );
  assert.doesNotMatch(decision.reason ?? "", /unknown/i);
});
