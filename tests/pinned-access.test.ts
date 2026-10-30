import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  defaultScripts,
  gitReader,
  loadAccessApi,
  observeShellCommand,
  resolveAccess,
} from "../access.mjs";
import { decideShell, gateShellEdit } from "../gate.mjs";
import { handleAntigravity } from "../hooks/lib/antigravity.mjs";
import { handlePreToolUse } from "../hooks/lib/claude.mjs";
import { handlePreToolUse as handleCodexPreToolUse } from "../hooks/lib/codex.mjs";
import { handlePreToolUse as handleCopilotPreToolUse } from "../hooks/lib/copilot.mjs";
import { handleCursor } from "../hooks/lib/cursor.mjs";
import {
  hasPinnedAccessApi,
  hasSupportedPinMetadata,
  loadPinnedAccessApi,
  pinMetadata,
  RESOLVER_PIN,
} from "../lib/pinned-access.mjs";
import type {
  ToolCallContext,
  ToolCallEvent,
  ToolCallResult,
} from "../pi/index.ts";
import { install as installPi } from "../pi/index.ts";
import {
  buildWorkspace,
  removeDir,
  tempDir,
} from "./support/fixture-workspace.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const apiShape = {
  loadCommittedCatalog() {},
  loadCommittedOwnedForks() {},
  loadCommittedOwnedRepositories() {},
  loadCommittedIgnore() {},
  resolveLevel() {},
  resolveDestination() {},
  decideTarget() {},
};

test("the packaged resolver pin names the reviewed artifact and API contract", () => {
  assert.equal(
    RESOLVER_PIN.repository,
    "simpsonm09-org/simpsonm09-repo-standard",
  );
  assert.equal(RESOLVER_PIN.commit, "c036a58763dec27e597871abff9ae9804f2c3f3a");
  assert.equal(RESOLVER_PIN.sourcePath, "scripts/agent-access.mjs");
  assert.match(RESOLVER_PIN.sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    RESOLVER_PIN.sha256,
    "54d099acaa7d166a9f3650211b94082a5c45d19268746507a728d116fd6e6342",
  );
  assert.equal(RESOLVER_PIN.apiVersion, 5);
  assert.equal(hasPinnedAccessApi(apiShape), true);
  // Every destination export is required: an older bundle without them cannot load.
  for (const missing of [
    "loadCommittedOwnedForks",
    "loadCommittedOwnedRepositories",
    "loadCommittedIgnore",
    "resolveDestination",
    "decideTarget",
  ]) {
    const partial = { ...apiShape };
    delete partial[/** @type {keyof typeof apiShape} */ (missing)];
    assert.equal(hasPinnedAccessApi(partial), false, missing);
  }
  assert.equal(
    hasPinnedAccessApi({ resolveLevel() {}, decideTarget() {} }),
    false,
  );
  assert.equal(hasSupportedPinMetadata(pinMetadata()), true);
  assert.equal(
    hasSupportedPinMetadata({ ...pinMetadata(), apiVersion: 1 }),
    false,
  );
});

test("pin provenance in the readme and docs manifest matches the runtime", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const manifest = JSON.parse(
    readFileSync(join(root, "docs", "manifest.json"), "utf8"),
  );
  assert.ok(readme.includes(RESOLVER_PIN.commit));
  assert.ok(readme.includes(RESOLVER_PIN.sha256));
  assert.deepEqual(manifest.features, [
    "docs/features/pinned-gate-resolver.md",
    "docs/features/owned-fork-observer.md",
    "docs/features/standalone-owned-gate.md",
  ]);
  for (const feature of manifest.features)
    assert.ok(existsSync(join(root, ...feature.split("/"))), feature);
});

test("missing or corrupt packaged resolver bytes cannot load an API", async () => {
  const dir = tempDir("pinned-resolver-corrupt-");
  try {
    const missing = join(dir, "missing.mjs");
    assert.equal(await loadPinnedAccessApi(missing), null);
    const corrupt = join(dir, "agent-access.mjs");
    writeFileSync(
      corrupt,
      "export function decide() { return { allowed: true }; }\n",
    );
    assert.equal(await loadPinnedAccessApi(corrupt), null);
    assert.deepEqual(
      resolveAccess(
        null,
        dir,
        "demo-repo",
        observeShellCommand(dir, "gh pr create"),
      ),
      { code: 2, stdout: "" },
    );
  } finally {
    removeDir(dir);
  }
});

test("the packaged resolver uses committed catalog data for an organization destination", async () => {
  const dir = tempDir("pinned-resolver-workspace-");
  try {
    const { workspace, cwd } = buildWorkspace(dir, { level: "propose" });
    const scripts = defaultScripts(workspace);
    const api = await loadAccessApi(scripts.access);
    assert.ok(api);

    const demo = cwd("projects/repos/demo-repo");
    const pushMain = observeShellCommand(demo, "git push origin main");
    const pushBranch = observeShellCommand(demo, "git push origin feat/x");
    const createPr = observeShellCommand(demo, "gh pr create");

    assert.equal(
      resolveAccess(api, scripts.catalog, "demo-repo", pushMain).code,
      1,
    );
    assert.equal(
      resolveAccess(api, scripts.catalog, "demo-repo", pushBranch).code,
      0,
    );
    assert.equal(
      resolveAccess(api, scripts.catalog, "demo-repo", createPr).code,
      0,
    );

    // A full worktree edit cannot raise the committed propose level.
    writeFileSync(
      join(scripts.catalog, "repos.json"),
      JSON.stringify({
        repos: [{ name: "demo-repo", tier: "standard", agentAccess: "full" }],
      }),
    );
    assert.equal(
      resolveAccess(api, scripts.catalog, "demo-repo", pushMain).code,
      1,
    );

    const source = join(
      workspace,
      "projects",
      "repos",
      "simpsonm09-repo-standard",
      "scripts",
      "agent-access.mjs",
    );
    writeFileSync(source, "export const decide = () => ({ allowed: true });\n");
    assert.equal(
      resolveAccess(api, scripts.catalog, "demo-repo", pushMain).code,
      1,
    );
  } finally {
    removeDir(dir);
  }
});

test("API 5 pinned consumer reads committed ignore before public-read decisions", async () => {
  const source = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "agent-access-api5-published.source",
  );
  const bytes = readFileSync(source);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    RESOLVER_PIN.sha256,
    "exercise the exact published resolver source bytes",
  );
  const api = await loadPinnedAccessApi();
  assert.ok(api);
  assert.equal(typeof api.loadCommittedIgnore, "function");

  const dir = tempDir("api5-ignore-consumer-");
  try {
    const { workspace } = buildWorkspace(dir, { level: "full" });
    const catalog = defaultScripts(workspace).catalog;
    const ignoredReads = [
      "simpsonm09/pdf_field_automation_acrobat",
      "simpsonm09-org/pdf_field_automation_acrobat",
      "simpsonm09/steam_wishlist_cleanup",
      "simpsonm09-org/steam_wishlist_cleanup",
      "simpsonm09/The_Gaming_Index_Video_Game_Database_Final_Capstone",
      "simpsonm09-org/The_Gaming_Index_Video_Game_Database_Final_Capstone",
      "simpsonm09/steam_wishlist_cleanup",
    ].map((destination) =>
      observeShellCommand(
        join(workspace, "projects", "repos", "demo-repo"),
        `gh repo view -R ${destination}`,
      ),
    );
    const publicRead = observeShellCommand(
      join(workspace, "projects", "repos", "demo-repo"),
      "gh repo view -R acme/public-repo",
    );
    const issueCreate = observeShellCommand(
      join(workspace, "projects", "repos", "demo-repo"),
      "gh issue create --title fixture -R simpsonm09-org/demo-repo",
    );
    const reviewApproval = observeShellCommand(
      join(workspace, "projects", "repos", "demo-repo"),
      "gh pr review 1 --approve -R simpsonm09-org/demo-repo",
    );
    const restReview = observeShellCommand(
      join(workspace, "projects", "repos", "demo-repo"),
      "gh api -X POST repos/simpsonm09-org/demo-repo/pulls/1/reviews -f event=APPROVE",
    );
    const ignoredClone = observeShellCommand(
      join(workspace, "projects", "repos", "demo-repo"),
      "git clone https://github.com/simpsonm09-org/steam_wishlist_cleanup.git",
    );
    const demo = join(workspace, "projects", "repos", "demo-repo");
    const rewrittenUrlCommand =
      "git -c url.https://github.com/simpsonm09/steam_wishlist_cleanup.insteadOf=https://github.com/acme/public-repo ls-remote https://github.com/acme/public-repo";
    const rewrittenUrlRead = observeShellCommand(demo, rewrittenUrlCommand);
    assert.equal(rewrittenUrlRead.destination?.owner, "simpsonm09");
    assert.equal(rewrittenUrlRead.destination?.repo, "steam_wishlist_cleanup");
    const ignoredRecurseReads = [
      `git fetch --recurse-submodules https://github.com/simpsonm09/steam_wishlist_cleanup`,
      `git pull --recurse-submodules https://github.com/simpsonm09/steam_wishlist_cleanup`,
      `git clone --recurse-submodules https://github.com/simpsonm09/steam_wishlist_cleanup demo`,
      `echo x && git fetch --recurse-submodules https://github.com/simpsonm09/steam_wishlist_cleanup`,
    ].map((command) => observeShellCommand(demo, command));
    const ignoredFork = observeShellCommand(
      demo,
      "gh repo fork simpsonm09/steam_wishlist_cleanup",
    );
    const thirdPartyFork = observeShellCommand(
      demo,
      "gh repo fork acme/ordinary-repo",
    );
    const directoryChangingRead = observeShellCommand(
      demo,
      "cd ../other && git fetch origin",
    );
    const positionalIgnored = observeShellCommand(
      join(workspace, "projects", "repos", "demo-repo"),
      "gh repo view https://github.com/simpsonm09/steam_wishlist_cleanup",
    );
    const publicLsRemote = observeShellCommand(
      join(workspace, "projects", "repos", "demo-repo"),
      "git ls-remote https://github.com/acme/public-repo.git",
    );
    for (const ignoredRead of ignoredReads)
      assert.equal(
        resolveAccess(api, catalog, "demo-repo", ignoredRead).code,
        1,
      );
    assert.equal(resolveAccess(api, catalog, "demo-repo", publicRead).code, 0);
    assert.equal(resolveAccess(api, catalog, "demo-repo", issueCreate).code, 0);
    assert.equal(
      resolveAccess(api, catalog, "demo-repo", reviewApproval).code,
      1,
    );
    assert.equal(resolveAccess(api, catalog, "demo-repo", restReview).code, 1);
    assert.equal(
      resolveAccess(api, catalog, "demo-repo", ignoredClone).code,
      1,
    );
    assert.equal(
      resolveAccess(api, catalog, "demo-repo", rewrittenUrlRead).code,
      1,
      "the command-scoped insteadOf target reaches the committed ignore check",
    );
    for (const read of ignoredRecurseReads.slice(0, 3))
      assert.equal(resolveAccess(api, catalog, "demo-repo", read).code, 1);
    assert.equal(resolveAccess(api, catalog, "demo-repo", ignoredFork).code, 1);
    assert.equal(
      resolveAccess(api, catalog, "demo-repo", thirdPartyFork).code,
      1,
      "the source identity does not broaden the policy for an unlisted repository",
    );
    assert.equal(directoryChangingRead.kind, "unsupported");
    assert.equal(
      resolveAccess(api, catalog, "demo-repo", positionalIgnored).code,
      1,
    );
    assert.equal(
      resolveAccess(api, catalog, "demo-repo", publicLsRemote).code,
      0,
    );
    const decide = (command: string) =>
      decideShell(
        { command },
        {
          cwd: demo,
          workspaceRoot: workspace,
          lookup: () => ({ repo: "demo-repo" }),
          resolve: (repo, observation) =>
            resolveAccess(api, catalog, repo, observation),
          git: (cwd) => gitReader(cwd),
        },
      );
    assert.equal(
      decide("gh issue create --title fixture -R simpsonm09-org/demo-repo")
        .action,
      "inject",
    );
    assert.equal(
      decide("gh pr review 1 --approve -R simpsonm09-org/demo-repo").action,
      "deny",
    );
    assert.equal(
      decide(
        "gh api -X POST repos/simpsonm09-org/demo-repo/pulls/1/reviews -f event=APPROVE",
      ).action,
      "deny",
    );
    assert.equal(decide(rewrittenUrlCommand).action, "deny");
    for (const command of [
      `git fetch --recurse-submodules https://github.com/simpsonm09/steam_wishlist_cleanup`,
      `git pull --recurse-submodules https://github.com/simpsonm09/steam_wishlist_cleanup`,
      `git clone --recurse-submodules https://github.com/simpsonm09/steam_wishlist_cleanup demo`,
      `echo x && git fetch --recurse-submodules https://github.com/simpsonm09/steam_wishlist_cleanup`,
      "gh repo fork simpsonm09/steam_wishlist_cleanup",
      "cd ../other && git fetch origin",
    ])
      assert.equal(decide(command).action, "deny", command);
    assert.equal(
      decide("gh pr merge 1 --admin -R simpsonm09-org/demo-repo").action,
      "deny",
    );
    assert.equal(
      decide("gh repo view -R simpsonm09-org/steam_wishlist_cleanup").action,
      "deny",
    );
    assert.equal(
      decide("echo before && gh repo view simpsonm09/steam_wishlist_cleanup")
        .action,
      "deny",
    );
  } finally {
    removeDir(dir);
  }
});

test("API 5 denies destination decisions when committed ignore policy is invalid", async (t) => {
  const scenarios = [
    { name: "missing ignore.json", content: null },
    { name: "corrupt ignore.json", content: "{" },
    {
      name: "ignore.json with unknown top-level field",
      content: JSON.stringify({ ignore: [], schema: 1 }),
    },
  ];
  const decisions = [
    {
      name: "ignored destination read",
      command: "gh repo view -R simpsonm09/steam_wishlist_cleanup",
    },
    {
      name: "public destination read",
      command: "gh repo view -R acme/public-repo",
    },
    {
      name: "organization write",
      command:
        "gh pr create -R simpsonm09-org/demo-repo --base main --head feat/x",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const dir = tempDir("pinned-resolver-invalid-ignore-");
      try {
        const { workspace } = buildWorkspace(dir, { level: "full" });
        const catalog = defaultScripts(workspace).catalog;
        const ignorePath = join(catalog, "ignore.json");
        if (scenario.content === null) {
          execFileSync("git", ["-C", catalog, "rm", "--quiet", "ignore.json"], {
            windowsHide: true,
            stdio: "ignore",
          });
        } else {
          writeFileSync(ignorePath, `${scenario.content}\n`);
          execFileSync("git", ["-C", catalog, "add", "ignore.json"], {
            windowsHide: true,
            stdio: "ignore",
          });
        }
        execFileSync(
          "git",
          [
            "-C",
            catalog,
            "commit",
            "--quiet",
            "--no-verify",
            "-m",
            "invalid ignore fixture",
          ],
          {
            windowsHide: true,
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: "fixture",
              GIT_AUTHOR_EMAIL: "fixture@example.invalid",
              GIT_COMMITTER_NAME: "fixture",
              GIT_COMMITTER_EMAIL: "fixture@example.invalid",
            },
            stdio: "ignore",
          },
        );
        execFileSync(
          "git",
          ["-C", catalog, "update-ref", "refs/remotes/upstream/main", "HEAD"],
          { windowsHide: true, stdio: "ignore" },
        );

        const pinnedApi = await loadAccessApi(defaultScripts(workspace).access);
        assert.ok(pinnedApi);
        const cwd = join(workspace, "projects", "repos", "demo-repo");
        // These command strings are inputs to the observer only; no shell command is run.
        for (const { name, command } of decisions) {
          const observation = observeShellCommand(cwd, command);
          assert.notEqual(
            resolveAccess(pinnedApi, catalog, "demo-repo", observation).code,
            0,
            `${scenario.name}: ${name}: ${command}`,
          );
        }
      } finally {
        removeDir(dir);
      }
    });
  }
});

test("a missing committed catalog denies writes even when its working file grants full", async () => {
  const dir = tempDir("pinned-resolver-no-catalog-");
  try {
    const catalog = join(dir, "catalog");
    mkdirSync(catalog, { recursive: true });
    writeFileSync(
      join(catalog, "repos.json"),
      JSON.stringify({
        repos: [{ name: "demo-repo", tier: "standard", agentAccess: "full" }],
      }),
    );
    const api = await loadAccessApi(defaultScripts(dir).access);
    assert.ok(api);
    assert.deepEqual(
      resolveAccess(
        api,
        catalog,
        "demo-repo",
        observeShellCommand(dir, "gh pr create"),
      ),
      { code: 2, stdout: "", catalogMissing: true },
    );
  } finally {
    removeDir(dir);
  }
});

test("standard checkout edits and branch changes do not replace the pinned resolver", async () => {
  const dir = tempDir("pinned-resolver-standard-git-");
  try {
    const { workspace, cwd } = buildWorkspace(dir, { level: "propose" });
    const standard = join(
      workspace,
      "projects",
      "repos",
      "simpsonm09-repo-standard",
    );
    const source = join(standard, "scripts", "agent-access.mjs");
    writeFileSync(
      source,
      "export const decide = () => ({ capability: null, allowed: true });\n",
    );
    const git = (args: string[]) =>
      execFileSync("git", ["-C", standard, ...args], {
        windowsHide: true,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    git(["init", "--quiet", "-b", "main"]);
    git(["add", "scripts/agent-access.mjs"]);
    git(["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
    git(["checkout", "--quiet", "-b", "alternate"]);

    const scripts = defaultScripts(workspace);
    const api = await loadAccessApi(scripts.access);
    assert.ok(api);
    const merge = observeShellCommand(
      cwd("projects/repos/demo-repo"),
      "gh pr merge 1",
    );
    assert.equal(
      resolveAccess(api, scripts.catalog, "demo-repo", merge).code,
      1,
    );
    writeFileSync(
      source,
      "export const decide = () => ({ capability: null, allowed: true });\n",
    );
    assert.equal(
      resolveAccess(api, scripts.catalog, "demo-repo", merge).code,
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the exact standalone target is gated from committed policy across shipped adapters", async () => {
  const dir = tempDir("pinned-resolver-owned-repository-");
  try {
    const { workspace, cwd } = buildWorkspace(dir, { level: "propose" });
    const scripts = defaultScripts(workspace);
    const catalog = scripts.catalog;
    const clone = cwd("projects/repos/demo-repo");
    execFileSync(
      "git",
      [
        "-C",
        clone,
        "remote",
        "set-url",
        "origin",
        "https://github.com/simpsonm09/simpsonm09.git",
      ],
      { windowsHide: true },
    );
    writeFileSync(
      join(catalog, "owned-repositories.json"),
      JSON.stringify({
        repositories: [
          { repository: "simpsonm09/simpsonm09", agentAccess: "propose" },
        ],
      }),
    );
    const api = await loadAccessApi(scripts.access);
    assert.ok(api);
    assert.equal(
      resolveAccess(
        api,
        catalog,
        "demo-repo",
        observeShellCommand(clone, "git push origin feat/x"),
      ).code,
      1,
      "an uncommitted standalone policy cannot grant the target",
    );
    const fixtureGit = (args: string[]) =>
      execFileSync("git", ["-C", catalog, ...args], {
        windowsHide: true,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    writeFileSync(
      join(catalog, "owned-repositories.json"),
      JSON.stringify({
        repositories: [
          { repository: "simpsonm09/simpsonm09", agentAccess: "propose" },
        ],
      }),
    );
    fixtureGit(["add", "owned-repositories.json"]);
    fixtureGit([
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture owned repository policy",
    ]);
    fixtureGit(["update-ref", "refs/remotes/upstream/main", "HEAD"]);
    const cases = [
      ["branch push", "git push origin feat/x", true],
      [
        "same-repository PR",
        "gh pr create -R simpsonm09/simpsonm09 --base main --head feat/x",
        true,
      ],
      ["main push", "git push origin main", false],
      ["force push", "git push --force origin feat/x", false],
      ["deletion", "git push origin :main", false],
      ["tag push", "git push origin v1", false],
      [
        "cross-repository PR",
        "gh pr create -R simpsonm09/simpsonm09 --base acme/other:main --head feat/x",
        false,
      ],
      [
        "owner-only PR identity",
        "gh pr create -R simpsonm09/simpsonm09 --base michael-denyer:main --head feat/x",
        false,
      ],
      ["merge", "gh pr merge 1 -R simpsonm09/simpsonm09", false],
      ["administration", "gh repo delete simpsonm09/simpsonm09 --yes", false],
      [
        "third-party target",
        "git push https://github.com/acme/other.git feat/x",
        false,
      ],
      [
        "unknown target",
        "git push https://github.com/acme/unlisted.git feat/x",
        false,
      ],
    ] as const;
    for (const [name, command, allowed] of cases) {
      const observed = observeShellCommand(clone, command);
      const result = resolveAccess(api, catalog, "demo-repo", observed);
      assert.equal(result.code === 0, allowed, `${name}: resolver result`);
      const deps = {
        cwd: clone,
        workspaceRoot: workspace,
        resolve: (_repo: string, intent: typeof observed) =>
          resolveAccess(api, catalog, "demo-repo", intent),
        env: [],
        git: (path: string) => gitReader(path),
      };
      assert.equal(
        decideShell({ command }, deps).action !== "deny",
        allowed,
        `${name}: shared gate`,
      );
      const edit = { command };
      const openCode = await gateShellEdit(
        edit,
        {},
        { ...deps, tokenFor: async () => null },
      );
      assert.equal(
        openCode.action !== "deny",
        allowed,
        `${name}: OpenCode adapter`,
      );
      const claude = await handlePreToolUse(
        { tool_name: "Bash", tool_input: { command }, cwd: clone },
        {
          workspaceRoot: workspace,
          env: { CLAUDE_CODE_GIT_BASH_PATH: process.execPath },
        },
      );
      assert.equal(
        claude?.hookSpecificOutput?.permissionDecision !== "deny",
        allowed,
        `${name}: Claude adapter`,
      );
    }

    const adapterCases = [
      cases[0],
      cases[1],
      cases[2],
      cases[6],
      cases[8],
      cases[9],
    ];
    let piHandler:
      | ((
          event: ToolCallEvent,
          ctx: ToolCallContext,
        ) => Promise<ToolCallResult>)
      | undefined;
    installPi(
      {
        on(_event, handler) {
          piHandler = handler;
        },
      },
      { workspaceRoot: workspace },
    );
    assert.ok(piHandler);
    for (const [name, command, allowed] of adapterCases) {
      const copilot = await handleCopilotPreToolUse(
        {
          sessionId: "fixture-session",
          timestamp: 1791497823900,
          cwd: clone,
          toolName: "bash",
          toolArgs: { command, description: "fixture command" },
        },
        {
          workspaceRoot: workspace,
          env: { CLAUDE_CODE_GIT_BASH_PATH: process.execPath },
        },
      );
      assert.equal(
        copilot?.permissionDecision !== "deny",
        allowed,
        `${name}: Copilot adapter`,
      );

      const cursor = await handleCursor(
        { command, cwd: clone, shell: "bash" },
        { workspaceRoot: workspace },
      );
      assert.equal(
        cursor?.permission !== "deny",
        allowed,
        `${name}: Cursor shared-hook adapter`,
      );

      const antigravity = await handleAntigravity(
        {
          hook_event_name: "PreToolUse",
          toolCall: {
            name: "run_command",
            args: { CommandLine: command, Cwd: clone, Shell: "bash" },
          },
        },
        { workspaceRoot: workspace },
      );
      assert.equal(
        antigravity?.decision !== "deny",
        allowed,
        `${name}: Antigravity shared-hook adapter`,
      );

      const pi = await piHandler(
        { toolName: "bash", input: { command } },
        { cwd: clone, hasUI: false },
      );
      assert.equal(
        pi?.block !== true,
        allowed,
        `${name}: Pi extension entry point`,
      );

      const codex = await handleCodexPreToolUse(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          cwd: clone,
          tool_input: { command },
        },
        {
          workspaceRoot: workspace,
          env: { CLAUDE_CODE_GIT_BASH_PATH: process.execPath },
        },
      );
      assert.equal(
        codex?.hookSpecificOutput?.permissionDecision,
        "deny",
        `${name}: Codex adapter keeps its documented deny-all-writes policy`,
      );
    }
  } finally {
    removeDir(dir);
  }
});
