import assert from "node:assert/strict";
import { test } from "node:test";
import { decideShell } from "../gate.mjs";

function decision(command: string, shell: "bash" | "powershell" = "bash") {
  let resolverCalls = 0;
  const gitCalls: string[][] = [];
  const result = decideShell(
    { command, shell },
    {
      cwd: "/synthetic/outside-fleet",
      lookup: () => ({ repo: null }),
      resolve: () => {
        resolverCalls += 1;
        return { code: 2, stdout: "" };
      },
      git: () => (args: string[]) => {
        gitCalls.push(args);
        if (args.join(" ") === "remote") return "origin";
        if (args.join(" ") === "config --get alias.fixture") return "push";
        if (args.join(" ") === "remote get-url --push --all origin")
          return "https://github.com/example-org/fixture-repo.git";
        return null;
      },
      env: [],
    },
  );
  return { decision: result, resolverCalls, gitCalls };
}

test("unsupported governed compounds deny from outside the fleet", () => {
  for (const [shell, command] of [
    ["bash", "cd fixture-repo && git fixture origin topic"],
    ["powershell", "Set-Location fixture-repo; git fixture origin topic"],
  ] as const) {
    const result = decision(command, shell);
    assert.equal(result.decision.action, "deny", command);
    assert.match(
      result.decision.reason ?? "",
      /unsupported|compound/i,
      command,
    );
    assert.ok(
      result.gitCalls.some(
        (args) => args.join(" ") === "config --get alias.fixture",
      ),
      "observer should use the fake git port to recognize the write alias",
    );
    assert.equal(
      result.resolverCalls,
      0,
      "unknown repos must not call the resolver",
    );
  }
});

test("unsupported single-command Bash shapes deny from outside the fleet", () => {
  for (const command of [
    "cat <<EOF",
    "git fixture origin topic",
    "GIT_DIR=/x git push origin main",
  ]) {
    const result = decision(command);
    assert.equal(result.decision.action, "deny", command);
    assert.match(result.decision.reason ?? "", /denied/i, command);
    assert.equal(result.resolverCalls, 0, command);
  }
});

test("modeled non-fleet reads pass and unsupported Git global options deny", () => {
  for (const [shell, command] of [
    ["bash", "cd fixture-repo && echo local"],
    ["powershell", "Set-Location fixture-repo; Write-Output local"],
  ] as const) {
    assert.equal(decision(command, shell).decision.action, "pass", command);
  }
  for (const command of [
    "git status",
    "git --git-dir=.git status",
    "git --work-tree=. status",
    "git --git-dir=.git --work-tree=. status",
    "npm test",
  ]) {
    const expected =
      command === "git status" || command === "npm test" ? "pass" : "deny";
    assert.equal(decision(command).decision.action, expected, command);
  }
});
