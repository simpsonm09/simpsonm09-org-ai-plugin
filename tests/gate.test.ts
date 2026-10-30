import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  classifyResolver,
  contextLine,
  decideShell,
  denyCommand,
  gateShellEdit,
  isGovernedCommand,
  isPowerShell,
  nodeRunner,
  parseResolverOutput,
  powerShellQuote,
  repoFromCwd,
  shouldInject,
  tokenUsable,
} from "../gate.mjs";
import { observeCommand } from "../lib/intent.mjs";
import { canonicalCommand, programName } from "../lib/program.mjs";

const ws = resolve("workspace");
const reposRoot = join(ws, "projects", "repos");

// A read-only git port that answers only the remote queries the observer makes, so a gate
// test does not need a real clone on disk. Everything else is null, which leaves the
// observation unresolved.
/**
 * @param {string | null} url
 * @returns {(args: string[]) => string | null}
 */
function readerFor(url: string | null) {
  return (args) => {
    const key = args.join(" ");
    if (key === "remote") return "origin\nupstream";
    if (key.startsWith("remote get-url")) return url;
    return null;
  };
}

type GroupLocation = "outside" | "fleet";
type FiniteGroupCase = readonly [
  name: string,
  command: string,
  outsideAction: "pass" | "deny",
  fleetAction: "pass" | "deny",
  readOnly: boolean,
  ghWriteSignal: boolean,
  outsideCalls: number,
  fleetCalls: number,
];

function decideGroupCommand(
  command: string,
  cwd: string,
  location: GroupLocation,
  calls: import("../lib/observation.mjs").Observation[],
) {
  return decideShell(
    { command },
    {
      cwd,
      workspaceRoot: ws,
      lookup: () => ({ repo: location === "fleet" ? "demo-repo" : null }),
      git: () => readerFor("https://github.com/simpsonm09-org/demo-repo.git"),
      resolve: (_repo, observation) => {
        calls.push(observation);
        return {
          code: observation.readOnly ? 0 : 1,
          stdout: JSON.stringify({
            level: "propose",
            capability: observation.capability,
            allowed: observation.readOnly,
            kind:
              observation.readOnly && observation.destination
                ? "ignored"
                : "org",
            destination: observation.destination
              ? `${observation.destination.owner}/${observation.destination.repo}`
              : "simpsonm09-org/demo-repo",
          }),
        };
      },
      env: [],
    },
  );
}

function assertGroupCase(
  [
    name,
    command,
    outsideAction,
    fleetAction,
    readOnly,
    ghWriteSignal,
    outsideCalls,
    fleetCalls,
  ]: FiniteGroupCase,
  location: GroupLocation,
) {
  const calls: import("../lib/observation.mjs").Observation[] = [];
  const cwd =
    location === "fleet" ? join(reposRoot, "demo-repo") : join(ws, "elsewhere");
  const observation = observeCommand(command, {
    cwd,
    git: readerFor("https://github.com/simpsonm09-org/demo-repo.git"),
  });
  assert.equal(
    observation.readOnly,
    readOnly,
    `${location}: ${name}: readOnly`,
  );
  assert.equal(
    observation.ghWriteSignal,
    ghWriteSignal,
    `${location}: ${name}: ghWriteSignal`,
  );

  const decision = decideGroupCommand(command, cwd, location, calls);
  assert.equal(
    decision.action,
    location === "outside" ? outsideAction : fleetAction,
    `${location}: ${name}: ${command}`,
  );
  assert.equal(
    calls.length,
    location === "outside" ? outsideCalls : fleetCalls,
    `${location}: ${name}: resolver calls`,
  );
  if (calls.length)
    assert.equal(calls.at(-1)?.readOnly, readOnly, `${location}: ${name}`);
  if (name.includes("gh write") && location === "outside")
    assert.equal(
      calls.length,
      0,
      `${location}: ${name} must deny before resolver`,
    );
  if (name.includes("push") && !readOnly && location === "fleet")
    assert.equal(calls.at(-1)?.readOnly, false, `${location}: ${name}`);
}

test("decideShell closes finite group boundaries in and outside the fleet", () => {
  const table = [
    ["git read", "git fetch origin", "deny", "deny", true, false, 1, 1],
    [
      "brace ignored read",
      "{ git fetch https://github.com/simpsonm09/steam_wishlist_cleanup; }",
      "deny",
      "deny",
      true,
      false,
      0,
      0,
    ],
    [
      "wrapper brace ignored read",
      "command { git fetch https://github.com/simpsonm09/steam_wishlist_cleanup; }",
      "deny",
      "deny",
      true,
      false,
      0,
      0,
    ],
    ["git push", "git push origin main", "pass", "deny", false, false, 0, 1],
    [
      "subshell push",
      "(git push origin main)",
      "pass",
      "deny",
      false,
      false,
      0,
      1,
    ],
    [
      "spaced subshell push",
      "( git push origin main )",
      "pass",
      "deny",
      false,
      false,
      0,
      1,
    ],
    [
      "negated push",
      "! git push origin main",
      "pass",
      "deny",
      false,
      false,
      0,
      1,
    ],
    [
      "if then push",
      "if true; then git push origin main; fi",
      "pass",
      "deny",
      false,
      false,
      0,
      1,
    ],
    [
      "else push",
      "if false; then echo a; else git push origin main; fi",
      "pass",
      "deny",
      false,
      false,
      0,
      1,
    ],
    [
      "else gh write",
      "if false; then :; else gh pr merge 52 -R simpsonm09-org/demo-repo --merge; fi",
      "deny",
      "deny",
      false,
      true,
      0,
      1,
    ],
    [
      "else ignored read",
      "if false; then :; else git fetch https://github.com/simpsonm09/steam_wishlist_cleanup; fi",
      "deny",
      "deny",
      true,
      false,
      0,
      0,
    ],
    [
      "brace local git status",
      "{ git status; }",
      "pass",
      "pass",
      true,
      false,
      0,
      1,
    ],
    [
      "no-space subshell local git status",
      "(git status)",
      "pass",
      "pass",
      true,
      false,
      0,
      1,
    ],
    [
      "subshell local git status",
      "( git status )",
      "pass",
      "pass",
      true,
      false,
      0,
      1,
    ],
    [
      "brace local git log",
      "{ git log --oneline; }",
      "pass",
      "pass",
      true,
      false,
      0,
      1,
    ],
    [
      "brace local git add",
      "{ git add .; }",
      "pass",
      "pass",
      true,
      false,
      0,
      1,
    ],
    [
      "brace local git commit",
      "{ git commit -m x; }",
      "pass",
      "pass",
      true,
      false,
      0,
      1,
    ],
    [
      "local grouped git before governed",
      "if true; then git status; else git push origin main; fi",
      "pass",
      "deny",
      false,
      false,
      0,
      1,
    ],
    [
      "assignment only compound",
      "X=1; echo hi",
      "pass",
      "pass",
      true,
      false,
      0,
      1,
    ],
    [
      "opaque push then gh write",
      "{ git push origin main; }; gh pr merge 52 -R simpsonm09-org/demo-repo --merge",
      "deny",
      "deny",
      false,
      true,
      0,
      1,
    ],
    [
      "grouped push then grouped gh write",
      "{ git push origin main; }; { gh pr merge 52 -R simpsonm09-org/demo-repo --merge; }",
      "deny",
      "deny",
      false,
      true,
      0,
      1,
    ],
    [
      "grouped push then negated gh write",
      "{ git push origin main; }; ! gh pr merge 52 -R simpsonm09-org/demo-repo --merge",
      "deny",
      "deny",
      false,
      true,
      0,
      1,
    ],
    [
      "grouped push then command gh write",
      "{ git push origin main; }; command gh pr merge 52 -R simpsonm09-org/demo-repo --merge",
      "deny",
      "deny",
      false,
      true,
      0,
      1,
    ],
    [
      "grouped push then if-then gh write",
      "{ git push origin main; }; if true; then gh pr merge 52 -R simpsonm09-org/demo-repo --merge; fi",
      "deny",
      "deny",
      false,
      true,
      0,
      1,
    ],
    [
      "grouped push then subshell gh write",
      "{ git push origin main; }; ( gh pr merge 52 -R simpsonm09-org/demo-repo --merge )",
      "deny",
      "deny",
      false,
      true,
      0,
      1,
    ],
    [
      "grouped push then do gh write",
      "{ git push origin main; }; for x in a; do gh pr merge 52 -R simpsonm09-org/demo-repo --merge; done",
      "deny",
      "deny",
      false,
      true,
      0,
      1,
    ],
    [
      "grouped push then ignored read",
      "{ git push origin main; }; { git fetch https://github.com/simpsonm09/steam_wishlist_cleanup; }",
      "deny",
      "deny",
      true,
      false,
      0,
      0,
    ],
    [
      "grouped push then plain ignored gh read",
      "{ git push origin main; }; gh repo view acme/ignored",
      "deny",
      "deny",
      true,
      false,
      0,
      0,
    ],
    [
      "grouped push then plain ignored git read",
      "{ git push origin main; }; git fetch https://github.com/simpsonm09/steam_wishlist_cleanup",
      "deny",
      "deny",
      true,
      false,
      0,
      0,
    ],
    [
      "plain push then plain ignored gh read",
      "git push origin main; gh repo view acme/ignored",
      "deny",
      "deny",
      true,
      false,
      0,
      0,
    ],
    [
      "plain ignored gh read then grouped push",
      "gh repo view acme/ignored; { git push origin main; }",
      "deny",
      "deny",
      true,
      false,
      0,
      0,
    ],
    [
      "grouped merge then view",
      "{ gh pr merge 52 -R simpsonm09-org/demo-repo --merge; }; { gh pr view 52 -R simpsonm09-org/demo-repo; }",
      "deny",
      "deny",
      true,
      true,
      0,
      0,
    ],
    [
      "if then push then gh write",
      "if true; then git push origin main; fi; gh pr merge 52 -R simpsonm09-org/demo-repo --merge",
      "deny",
      "deny",
      false,
      true,
      0,
      1,
    ],
    [
      "subshell push then gh write",
      "( git push origin main ) && gh pr merge 52 -R simpsonm09-org/demo-repo --merge",
      "deny",
      "deny",
      false,
      true,
      0,
      1,
    ],
    [
      "else push then gh write",
      "if false; then echo a; else git push origin main; fi; gh pr merge 52 -R simpsonm09-org/demo-repo --merge",
      "deny",
      "deny",
      false,
      true,
      0,
      1,
    ],
    [
      "expanded assignment then gh write",
      "X=$(echo hi); gh pr merge 52 -R simpsonm09-org/demo-repo --merge",
      "deny",
      "deny",
      false,
      true,
      0,
      1,
    ],
    [
      "expanded assignment gh write",
      "X=$(gh pr merge 52 -R simpsonm09-org/demo-repo --merge)",
      "deny",
      "deny",
      false,
      true,
      0,
      1,
    ],
    [
      "for do push",
      "for x in a; do git push origin main; done",
      "pass",
      "deny",
      false,
      false,
      0,
      1,
    ],
    [
      "brace gh write",
      "{ gh pr merge 52 -R simpsonm09-org/demo-repo --merge; }",
      "deny",
      "deny",
      false,
      true,
      0,
      1,
    ],
    [
      "wrapper gh write",
      "command gh pr merge 52 -R simpsonm09-org/demo-repo --merge",
      "deny",
      "deny",
      false,
      true,
      0,
      1,
    ],
    [
      "wrapper gh read",
      "command gh pr view 52 -R simpsonm09-org/demo-repo",
      "deny",
      "deny",
      true,
      false,
      0,
      0,
    ],
    ["local control", "{ echo local; }", "pass", "pass", true, false, 0, 1],
  ] as const;

  for (const testCase of table satisfies readonly FiniteGroupCase[])
    for (const location of ["outside", "fleet"] as const)
      assertGroupCase(testCase, location);
});

test("opaque read and write aggregation is invariant to segment order", () => {
  const segments = [
    "{ git push origin main; }",
    "{ gh pr merge 52 -R simpsonm09-org/demo-repo --merge; }",
    "{ git fetch https://github.com/simpsonm09/steam_wishlist_cleanup; }",
    "{ gh pr view 52 -R simpsonm09-org/demo-repo; }",
  ];
  const permutations = [
    [0, 1, 2, 3],
    [0, 1, 3, 2],
    [0, 2, 1, 3],
    [0, 2, 3, 1],
    [0, 3, 1, 2],
    [0, 3, 2, 1],
    [1, 0, 2, 3],
    [1, 0, 3, 2],
    [1, 2, 0, 3],
    [1, 2, 3, 0],
    [1, 3, 0, 2],
    [1, 3, 2, 0],
    [2, 0, 1, 3],
    [2, 0, 3, 1],
    [2, 1, 0, 3],
    [2, 1, 3, 0],
    [2, 3, 0, 1],
    [2, 3, 1, 0],
    [3, 0, 1, 2],
    [3, 0, 2, 1],
    [3, 1, 0, 2],
    [3, 1, 2, 0],
    [3, 2, 0, 1],
    [3, 2, 1, 0],
  ];

  for (const order of permutations) {
    const command = order.map((index) => segments[index]).join("; ");
    const expectedRead = order.includes(2) || order.includes(3);
    const expectedGhWrite = order.includes(1);
    const observation = observeCommand(command, {
      cwd: join(ws, "elsewhere"),
      git: readerFor("https://github.com/simpsonm09-org/demo-repo.git"),
    });
    assert.equal(observation.readOnly, expectedRead, command);
    assert.equal(observation.ghWriteSignal, expectedGhWrite, command);

    for (const location of ["outside", "fleet"] as const) {
      const calls: import("../lib/observation.mjs").Observation[] = [];
      const cwd =
        location === "fleet"
          ? join(reposRoot, "demo-repo")
          : join(ws, "elsewhere");
      const decision = decideShell(
        { command },
        {
          cwd,
          workspaceRoot: ws,
          lookup: () => ({ repo: location === "fleet" ? "demo-repo" : null }),
          git: () =>
            readerFor("https://github.com/simpsonm09-org/demo-repo.git"),
          resolve: (_repo, intent) => {
            calls.push(intent);
            return {
              code: intent.readOnly ? 0 : 1,
              stdout: JSON.stringify({
                level: "propose",
                capability: intent.capability,
                allowed: intent.readOnly,
                kind: intent.readOnly && intent.destination ? "ignored" : "org",
                destination: "simpsonm09-org/demo-repo",
              }),
            };
          },
          env: [],
        },
      );
      assert.equal(decision.action, "deny", `${location}: ${command}`);
      assert.equal(
        calls.length,
        location === "fleet" && !expectedRead ? 1 : 0,
        `${location}: ${command}`,
      );
    }
  }
});

test("plain and grouped reads and writes fail closed in each segment order", () => {
  const segments = [
    "{ git push origin main; }",
    "git push origin main",
    "gh repo view acme/ignored",
    "{ git fetch https://github.com/simpsonm09/steam_wishlist_cleanup; }",
  ];
  const permutations = [
    [0, 1, 2, 3],
    [0, 2, 1, 3],
    [0, 3, 1, 2],
    [1, 0, 2, 3],
    [1, 2, 3, 0],
    [2, 0, 3, 1],
    [2, 1, 0, 3],
    [2, 3, 0, 1],
    [3, 0, 1, 2],
    [3, 1, 2, 0],
    [3, 2, 1, 0],
    [1, 3, 2, 0],
  ];

  for (const order of permutations) {
    const command = order.map((index) => segments[index]).join("; ");
    const observation = observeCommand(command, {
      cwd: join(ws, "elsewhere"),
      git: readerFor("https://github.com/simpsonm09-org/demo-repo.git"),
    });
    assert.equal(observation.readOnly, true, command);
    assert.equal(observation.ghWriteSignal, false, command);
    for (const location of ["outside", "fleet"] as const) {
      const calls: import("../lib/observation.mjs").Observation[] = [];
      const cwd =
        location === "fleet"
          ? join(reposRoot, "demo-repo")
          : join(ws, "elsewhere");
      const decision = decideShell(
        { command },
        {
          cwd,
          workspaceRoot: ws,
          lookup: () => ({ repo: location === "fleet" ? "demo-repo" : null }),
          git: () =>
            readerFor("https://github.com/simpsonm09-org/demo-repo.git"),
          resolve: (_repo, intent) => {
            calls.push(intent);
            return { code: intent.readOnly ? 0 : 1, stdout: "{}" };
          },
          env: [],
        },
      );
      assert.equal(decision.action, "deny", `${location}: ${command}`);
      assert.equal(calls.length, 0, `${location}: ${command}`);
    }
  }
});

test("repoFromCwd names the clone for a directory inside a repo", () => {
  assert.equal(
    repoFromCwd(join(reposRoot, "simpsonm09-org-ai-plugin"), ws),
    "simpsonm09-org-ai-plugin",
  );
  assert.equal(
    repoFromCwd(join(reposRoot, "simpsonm09-org-ai-plugin", "src", "deep"), ws),
    "simpsonm09-org-ai-plugin",
  );
});

test("repoFromCwd returns null outside projects/repos", () => {
  assert.equal(repoFromCwd(join(ws, "projects"), ws), null);
  assert.equal(repoFromCwd(ws, ws), null);
  assert.equal(repoFromCwd(reposRoot, ws), null);
  assert.equal(
    repoFromCwd(join(ws, "..", "elsewhere", "projects", "repos", "x"), ws),
    null,
  );
  assert.equal(repoFromCwd("", ws), null);
  assert.equal(repoFromCwd(reposRoot, ""), null);
});

test("shouldInject only matches a gh command", () => {
  assert.equal(shouldInject("gh pr create"), true);
  assert.equal(shouldInject("gh"), true);
  assert.equal(shouldInject("  gh pr list"), false);
  assert.equal(shouldInject("git status"), false);
  assert.equal(shouldInject("npx gh"), false);
});

test("classifyResolver maps exit codes to allow, deny, and unknown", () => {
  assert.equal(classifyResolver({ code: 0, stdout: "read\n" }), "allow");
  assert.equal(classifyResolver({ code: 1, stdout: "" }), "deny");
  assert.equal(classifyResolver({ code: 2, stdout: "" }), "unknown");
  assert.equal(classifyResolver({ code: 127, stdout: "" }), "unknown");
});

test("isGovernedCommand is the observer without a git port: writes and pushes yes, reads no", () => {
  assert.equal(isGovernedCommand("gh api -X POST /repos"), true);
  assert.equal(isGovernedCommand("git push origin main"), true);
  assert.equal(isGovernedCommand("gh pr merge 3"), true);
  assert.equal(isGovernedCommand("gh pr create --title x"), true);
  assert.equal(isGovernedCommand("ls -la"), false);
  assert.equal(isGovernedCommand("cat file"), false);
  assert.equal(isGovernedCommand("git status"), false);
  assert.equal(isGovernedCommand("gh pr view 1"), false);
  // A quoted mention is not a program word, so it is not a governed write.
  assert.equal(isGovernedCommand('echo "gh pr create"'), false);
  assert.equal(isGovernedCommand("gh.exe api -X POST /repos"), true);
});

test("a destination-bearing read checks explicit ignore before the public-read path", () => {
  const base = {
    cwd: join(reposRoot, "demo-repo"),
    workspaceRoot: ws,
    lookup: () => ({ repo: null }),
    git: () => null,
  };
  const ignored = decideShell(
    { command: "gh repo view -R acme/ignored" },
    {
      ...base,
      resolve: () => ({
        code: 0,
        stdout: JSON.stringify({
          level: "read",
          allowed: true,
          kind: "ignored",
        }),
      }),
    },
  );
  assert.equal(ignored.action, "deny");

  const unavailable = decideShell(
    { command: "gh repo view -R acme/public" },
    { ...base, resolve: () => ({ code: 2, stdout: "" }) },
  );
  assert.equal(unavailable.action, "deny");
});

test("compound ignored reads are denied while public compound reads retain baseline access", () => {
  const decide = (destination: string) =>
    decideShell(
      { command: `echo before && gh repo view ${destination}` },
      {
        cwd: join(reposRoot, "demo-repo"),
        workspaceRoot: ws,
        lookup: () => ({ repo: null }),
        git: () => null,
        resolve: (_repo, observation) => ({
          code: 0,
          stdout: JSON.stringify({
            level: "read",
            kind:
              observation.destination?.repo === "ignored"
                ? "ignored"
                : "public",
            allowed: true,
          }),
        }),
      },
    );
  assert.equal(decide("acme/ignored").action, "deny");
  assert.equal(decide("acme/public").action, "pass");
});

test("a missing git reader makes remote reads unsupported instead of throwing", () => {
  const result = decideShell(
    { command: "git fetch https://github.com/acme/repo" },
    {
      cwd: join(reposRoot, "demo-repo"),
      workspaceRoot: ws,
      lookup: () => ({ repo: null }),
      git: () => null,
      resolve: () => ({ code: 0, stdout: "{}" }),
    },
  );
  assert.equal(result.action, "deny");
});

test("the shared gate preserves merge capability and never grants admin or review writes", () => {
  const decide = (command: string) =>
    decideShell(
      { command },
      {
        cwd: join(reposRoot, "demo-repo"),
        workspaceRoot: ws,
        lookup: () => ({ repo: "demo-repo" }),
        git: () => null,
        resolve: (_repo, observation) => ({
          code: observation.capability === "mergePr" ? 0 : 1,
          stdout: JSON.stringify({
            level: "merge",
            capability: observation.capability,
            allowed: observation.capability === "mergePr",
          }),
        }),
      },
    );
  assert.equal(
    decide("gh pr merge 1 -m -R simpsonm09-org/demo-repo").action,
    "pass",
  );
  assert.equal(
    decide("gh pr merge 1 --admin -R simpsonm09-org/demo-repo").action,
    "deny",
  );
  assert.equal(
    decide("gh pr edit 1 --milestone 2 -R simpsonm09-org/demo-repo").action,
    "deny",
  );
  assert.equal(
    decide("gh api -X POST repos/simpsonm09-org/demo-repo/pulls/1/reviews")
      .action,
    "deny",
  );
});

test("denyCommand prints to stderr and exits non-zero in POSIX form", () => {
  const command = denyCommand("repo is read-only");
  assert.match(command, />&2/);
  assert.match(command, /exit 1/);
  assert.match(command, /agent-access: denied: repo is read-only/);
});

test("denyCommand quotes a reason that contains a single quote in POSIX form", () => {
  const command = denyCommand("it's locked");
  assert.match(command, /'agent-access: denied: it'\\''s locked'/);
});

test("denyCommand uses PowerShell syntax for a PowerShell shell", () => {
  const command = denyCommand("repo is read-only", "pwsh");
  assert.match(command, /^Write-Error '/);
  assert.match(command, /; exit 1$/);
  assert.match(command, /agent-access: denied: repo is read-only/);
  assert.doesNotMatch(command, />&2/);
});

test("denyCommand doubles an embedded single quote in PowerShell form", () => {
  const command = denyCommand("it's locked", "powershell");
  assert.match(
    command,
    /Write-Error 'agent-access: denied: it''s locked'; exit 1/,
  );
});

test("denyCommand keeps the POSIX form for an unknown shell", () => {
  const command = denyCommand("nope", "bash");
  assert.match(command, />&2/);
  assert.match(command, /agent-access: denied: nope/);
});

test("isPowerShell matches the PowerShell family only", () => {
  assert.equal(isPowerShell("pwsh"), true);
  assert.equal(isPowerShell("powershell"), true);
  assert.equal(isPowerShell("PowerShell.exe"), true);
  assert.equal(isPowerShell("pwsh.exe"), true);
  assert.equal(
    isPowerShell(
      "C:/Program Files/WindowsApps/Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe/pwsh.EXE",
    ),
    true,
  );
  assert.equal(
    isPowerShell("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"),
    true,
  );
  assert.equal(isPowerShell("bash"), false);
  assert.equal(isPowerShell("/bin/sh"), false);
  assert.equal(isPowerShell(""), false);
});

test("powerShellQuote doubles embedded single quotes", () => {
  assert.equal(powerShellQuote("plain"), "'plain'");
  assert.equal(powerShellQuote("it's"), "'it''s'");
});

test("nodeRunner never returns the OpenCode binary", () => {
  assert.equal(
    nodeRunner("C:/Users/x/AppData/Local/Programs/opencode-cli/opencode.exe"),
    "node",
  );
  assert.equal(
    nodeRunner("C:/Program Files/nodejs/node.exe"),
    "C:/Program Files/nodejs/node.exe",
  );
  assert.equal(nodeRunner("/usr/local/bin/node"), "/usr/local/bin/node");
  assert.equal(nodeRunner("/usr/local/bin/bun"), "/usr/local/bin/bun");
  assert.equal(nodeRunner(""), "node");
});

test("tokenUsable rejects an absent, malformed, or expiring cache", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(tokenUsable(null, now), false);
  assert.equal(
    tokenUsable({ token: "", expires_at: "2026-01-01T00:10:00Z" }, now),
    false,
  );
  assert.equal(
    tokenUsable({ token: "x", expires_at: "not-a-date" }, now),
    false,
  );
  assert.equal(
    tokenUsable({ token: "x", expires_at: "2026-01-01T00:02:00Z" }, now),
    false,
  );
  assert.equal(
    tokenUsable({ token: "x", expires_at: "2026-01-01T01:00:00Z" }, now),
    true,
  );
});

test("contextLine names the repository and its level", () => {
  assert.match(
    contextLine("simpsonm09-org-ai-plugin", "read"),
    /simpsonm09-org-ai-plugin/,
  );
  assert.match(contextLine("simpsonm09-org-ai-plugin", "read"), /"read"/);
});

test("parseResolverOutput reads the level, capability, destination, and auth route", () => {
  assert.deepEqual(
    parseResolverOutput(
      '{"level":"merge","capability":"mergePr","allowed":true,"kind":"org","destination":"simpsonm09-org/demo-repo","auth":{"route":"app","owner":"simpsonm09-org","repo":"demo-repo"}}',
    ),
    {
      level: "merge",
      capability: "mergePr",
      kind: "org",
      destination: "simpsonm09-org/demo-repo",
      auth: { route: "app", owner: "simpsonm09-org", repo: "demo-repo" },
    },
  );
  assert.deepEqual(
    parseResolverOutput('{"level":"read","capability":null,"allowed":true}'),
    {
      level: "read",
      capability: null,
      kind: null,
      destination: null,
      auth: null,
    },
  );
  assert.equal(parseResolverOutput(""), null);
  assert.equal(parseResolverOutput("read\n"), null);
  assert.equal(parseResolverOutput('{"capability":"x"}'), null);
});

const insideRepo = join(reposRoot, "demo-repo");
const outsideRepo = join(ws, "docs");

/**
 * The gate deps with a stub resolver. The observation the gate passes is the real observer's
 * output for the injected git port, so a test asserts the destination the observer saw.
 * @param {(repo: string, observation: import("../lib/observation.mjs").Observation) => { code: number, stdout: string }} resolve
 * @param {Record<string, unknown>} [extra]
 */
const stubDeps = (
  resolve: (
    repo: string,
    observation: import("../lib/observation.mjs").Observation,
  ) => { code: number; stdout: string },
  extra: Record<string, unknown> = {},
) => ({
  cwd: insideRepo,
  workspaceRoot: ws,
  resolve,
  git: () => readerFor("https://github.com/simpsonm09-org/demo-repo.git"),
  env: [],
  tokenFor: async () => "ghs_stub_token",
  ...extra,
});

const jsonFor = (level: string, capability: string | null = null) =>
  JSON.stringify({
    level,
    capability,
    allowed: true,
    kind: "org",
    destination: "simpsonm09-org/demo-repo",
    auth: { route: "app", owner: "simpsonm09-org", repo: "demo-repo" },
  });

test("gateShellEdit leaves a command outside a fleet clone alone", async () => {
  const input = { command: "git push" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(input, env, {
    ...stubDeps(() => ({ code: 0, stdout: jsonFor("merge") })),
    cwd: outsideRepo,
  });

  assert.equal(decision.action, "pass");
  assert.equal(decision.repo, null);
  assert.equal(input.command, "git push");
  assert.equal(env.GH_TOKEN, undefined);
});

test("gateShellEdit rewrites a denied command into the failing POSIX form", async () => {
  const input = { command: "git push origin main" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(
    input,
    env,
    stubDeps(() => ({ code: 1, stdout: jsonFor("read", "pushMain") })),
  );

  assert.equal(decision.action, "deny");
  assert.equal(decision.level, "read");
  assert.match(input.command, /exit 1/);
  assert.match(input.command, />&2/);
  assert.equal(env.GH_TOKEN, undefined);
});

test("gateShellEdit rewrites a denied command into PowerShell form when the shell is pwsh", async () => {
  const input = { command: "gh pr merge 1", shell: "pwsh" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(
    input,
    env,
    stubDeps(() => ({ code: 1, stdout: jsonFor("read", "mergePr") })),
  );

  assert.equal(decision.action, "deny");
  assert.match(input.command, /Write-Error '/);
  assert.match(input.command, /; exit 1$/);
  assert.doesNotMatch(input.command, />&2/);
  assert.equal(env.GH_TOKEN, undefined);
});

test("gateShellEdit injects GH_TOKEN for an allowed organization gh command", async () => {
  const input = { command: "gh pr list" };
  const env: Record<string, string | undefined> = {};
  const seen: Array<[string, string]> = [];
  const decision = await gateShellEdit(input, env, {
    ...stubDeps(() => ({ code: 0, stdout: jsonFor("propose") })),
    tokenFor: async (owner: string, repo: string) => {
      seen.push([owner, repo]);
      return "ghs_stub_token";
    },
  });

  assert.equal(decision.action, "inject");
  assert.equal(decision.level, "propose");
  assert.equal(env.GH_TOKEN, "ghs_stub_token");
  assert.equal(input.command, "gh pr list");
  assert.deepEqual(seen, [["simpsonm09-org", "demo-repo"]]);
});

test("gateShellEdit passes an allowed owned-fork gh command without minting a token", async () => {
  const input = { command: "gh pr create -R simpsonm09/pstack-max" };
  const env: Record<string, string | undefined> = {};
  let minted = 0;
  const decision = await gateShellEdit(input, env, {
    ...stubDeps(() => ({
      code: 0,
      stdout: JSON.stringify({
        level: "read",
        capability: "openPr",
        allowed: true,
        kind: "owned-fork",
        destination: "simpsonm09/pstack-max",
        auth: { route: "ambient", owner: null, repo: null },
      }),
    })),
    tokenFor: async () => {
      minted += 1;
      return "never";
    },
  });

  assert.equal(decision.action, "pass");
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(minted, 0, "an ambient destination never mints an App token");
  assert.equal(input.command, "gh pr create -R simpsonm09/pstack-max");
});

test("gateShellEdit fails closed on an unknown resolver for a write", async () => {
  const input = { command: "git push origin main" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(
    input,
    env,
    stubDeps(() => ({ code: 2, stdout: "" })),
  );

  assert.equal(decision.action, "deny");
  assert.match(
    decision.reason ?? "",
    /access resolver could not answer for demo-repo; check that the catalog and resolver are available before running this write/,
  );
  assert.match(input.command, /exit 1/);
});

test("gateShellEdit passes an unknown resolver for a read", async () => {
  const input = { command: "ls -la" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(
    input,
    env,
    stubDeps(() => ({ code: 2, stdout: "" })),
  );

  assert.equal(decision.action, "pass");
  assert.equal(input.command, "ls -la");
});

test("gateShellEdit fails closed when a gh command cannot mint a token", async () => {
  const input = { command: "gh pr create --fill" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(input, env, {
    ...stubDeps(() => ({ code: 0, stdout: jsonFor("propose") })),
    tokenFor: async () => null,
  });

  assert.equal(decision.action, "deny");
  assert.match(input.command, /exit 1/);
  assert.equal(env.GH_TOKEN, undefined);
});

test("the gate hands the observer's destination to the resolver, not a remote name", async () => {
  const seen: import("../lib/observation.mjs").Observation[] = [];
  const input = { command: "git push --dry-run origin main" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(input, env, {
    ...stubDeps((_repo, observation) => {
      seen.push(observation);
      return { code: 1, stdout: jsonFor("propose", "pushMain") };
    }),
    git: () =>
      readerFor("https://github.com/simpsonm09/simpsonm09-repo-standard.git"),
  });

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].destination, {
    host: "github.com",
    owner: "simpsonm09",
    repo: "simpsonm09-repo-standard",
  });
  assert.equal(seen[0].capability, "pushMain");
  assert.equal(decision.action, "deny");
  assert.match(input.command, /exit 1/);
});

test("gateShellEdit resolves the organization remote and denies the org main push", async () => {
  const seen: string[] = [];
  const input = { command: "git push --dry-run upstream main" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(input, env, {
    ...stubDeps((_repo, observation) => {
      seen.push(observation.destination?.owner ?? "");
      return { code: 1, stdout: jsonFor("propose", "pushMain") };
    }),
    git: () =>
      readerFor(
        "https://github.com/simpsonm09-org/simpsonm09-repo-standard.git",
      ),
  });

  assert.deepEqual(seen, ["simpsonm09-org"]);
  assert.equal(decision.action, "deny");
  assert.match(input.command, /exit 1/);
});

test("gateShellEdit passes no destination when git cannot resolve the remote", async () => {
  const seen: Array<string | null> = [];
  const input = { command: "git push origin main" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(input, env, {
    ...stubDeps((_repo, observation) => {
      seen.push(observation.destination?.repo ?? null);
      return { code: 1, stdout: jsonFor("propose", "pushMain") };
    }),
    git: () => readerFor(null),
  });

  assert.deepEqual(seen, [null]);
  assert.equal(decision.action, "deny");
});

test("gateShellEdit asks the resolver for a local command and passes it unchanged", async () => {
  let lookups = 0;
  const input = { command: "npm test" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(input, env, {
    ...stubDeps(() => {
      lookups += 1;
      return { code: 0, stdout: jsonFor("propose") };
    }),
  });

  // The resolver is asked (the level is informational), but the observation is local: nothing
  // is injected and the command is not rewritten.
  assert.equal(decision.action, "pass");
  assert.equal(input.command, "npm test");
  assert.equal(lookups, 1);
});

test("programName gives the plain program name for every executable spelling", () => {
  for (const word of [
    "gh",
    "GH",
    "gh.exe",
    "Gh.EXE",
    "gh.cmd",
    "/usr/bin/gh",
    "./gh",
    ".\\gh.exe",
    "C:\\Program Files\\GitHub CLI\\gh.exe",
    '"C:\\Program Files\\GitHub CLI\\gh.exe"',
  ]) {
    assert.equal(programName(word), "gh", word);
  }
  assert.equal(programName("gh.exe.bak"), "gh.exe.bak");
  assert.equal(programName("ghx"), "ghx");
  assert.equal(programName("gh/"), "");
  assert.equal(programName(""), "");
});

test("canonicalCommand changes only the first word, and only when it names gh or git", () => {
  assert.equal(canonicalCommand("gh.exe pr view 1"), "gh pr view 1");
  assert.equal(canonicalCommand("GH.EXE  pr   view 1"), "gh  pr   view 1");
  assert.equal(
    canonicalCommand('"C:\\Program Files\\GitHub CLI\\gh.exe" pr merge 1'),
    "gh pr merge 1",
  );
  assert.equal(canonicalCommand("'gh' pr list"), "gh pr list");
  assert.equal(
    canonicalCommand("GIT.exe push origin main"),
    "git push origin main",
  );
  assert.equal(canonicalCommand("gh.exe pr list | jq ."), "gh pr list | jq .");
  assert.equal(
    canonicalCommand("cd x && git.exe push"),
    "cd x && git.exe push",
  );
  assert.equal(canonicalCommand("FOO=1 git.exe push"), "FOO=1 git.exe push");
  assert.equal(canonicalCommand("npm.exe test"), "npm.exe test");
  assert.equal(canonicalCommand(" gh.exe pr list"), " gh pr list");
  assert.equal(canonicalCommand("gh pr list"), "gh pr list");
  assert.equal(canonicalCommand(""), "");
});

test("shouldInject matches every executable spelling of gh, as the plain name", () => {
  for (const spelling of [
    "gh.exe",
    "GH",
    "Gh.EXE",
    "/usr/bin/gh",
    "./gh",
    '"C:\\Program Files\\GitHub CLI\\gh.exe"',
    "'C:/Program Files/GitHub CLI/gh.exe'",
  ]) {
    assert.equal(
      shouldInject(`${spelling} pr create --title x`),
      true,
      spelling,
    );
  }
  assert.equal(shouldInject("gh.exe.bak pr list"), false);
  assert.equal(shouldInject("ghx pr list"), false);
  assert.equal(shouldInject("npx gh.exe"), false);
});

test("gateShellEdit decides a gh.exe call as the plain gh call and keeps the typed command", async () => {
  const seen: string[] = [];
  const input = { command: "gh.exe pr create --fill" };
  const env: Record<string, string | undefined> = {};
  const decision = await gateShellEdit(input, env, {
    ...stubDeps((_repo, observation) => {
      seen.push(`${observation.operation}:${observation.capability}`);
      return { code: 0, stdout: jsonFor("propose", "openPr") };
    }),
  });

  assert.equal(decision.action, "inject");
  assert.equal(env.GH_TOKEN, "ghs_stub_token");
  assert.equal(
    input.command,
    "gh.exe pr create --fill",
    "the command that runs keeps the spelling the caller typed",
  );
  assert.deepEqual(
    seen,
    ["openPr:openPr"],
    "the observer reads the plain name",
  );
});
