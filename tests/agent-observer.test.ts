// The command observer (lib/intent.mjs and its domain modules lib/gitpush.mjs,
// lib/ghcommand.mjs, lib/observation.mjs, over lib/gitstate.mjs, with the flag, refspec,
// option, argv, and shell-scan modules they factor out) against real temporary git
// repositories. The remotes are only names and github URLs in a fixture's git config: nothing
// here reaches the network, runs `git push`, or calls gh. The observation must name the
// destination from real git plumbing, so these tests build real clones, worktrees, pushurls,
// and push-remote configuration, and read the observer's normalized output rather than a
// copy of its own rules.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  observationDestination,
  observeCommand,
  observeShellCommand,
  toResolverIntent,
} from "../access.mjs";
import { parseGithubRepo, parseRepoArgument } from "../lib/gitstate.mjs";
import { OBSERVATION_KINDS } from "../lib/observation.mjs";

const OWNED_FORK = "https://github.com/simpsonm09/pstack-max.git";
const THIRD_PARTY = "https://github.com/michael-denyer/pstack-claude.git";
const ORG_REPO = "https://github.com/simpsonm09-org/demo-repo.git";

let root = "";

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    windowsHide: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * @param {string} path
 * @param {string} [branch]
 */
function initRepo(path: string, branch = "main"): void {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "--quiet", "-b", branch]);
  git(path, ["commit", "--quiet", "--allow-empty", "-m", "init"]);
}

/**
 * @param {string} path
 * @param {string} name
 * @param {string} url
 * @param {string[]} [pushUrls]
 */
function addRemote(
  path: string,
  name: string,
  url: string,
  pushUrls: string[] = [],
): void {
  git(path, ["remote", "add", name, url]);
  for (const push of pushUrls)
    git(path, ["remote", "set-url", "--add", "--push", name, push]);
}

// Point the remote-tracking HEAD at a branch, the only local evidence of the default branch.
/**
 * @param {string} path
 * @param {string} remote
 * @param {string} branch
 */
function setRemoteHead(path: string, remote: string, branch: string): void {
  git(path, ["update-ref", `refs/remotes/${remote}/${branch}`, "HEAD"]);
  git(path, [
    "symbolic-ref",
    `refs/remotes/${remote}/HEAD`,
    `refs/remotes/${remote}/${branch}`,
  ]);
}

/**
 * @param {string} name
 * @returns {string}
 */
function clone(name: string): string {
  return join(root, name);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "agent-observer-"));
  // An empty global config and no system config, so the observation does not depend on the
  // machine's git configuration (push.default, remote.pushDefault, an identity, ...).
  const config = join(root, "empty-gitconfig");
  writeFileSync(config, "");
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_AUTHOR_NAME = "fixture";
  process.env.GIT_AUTHOR_EMAIL = "fixture@example.invalid";
  process.env.GIT_COMMITTER_NAME = "fixture";
  process.env.GIT_COMMITTER_EMAIL = "fixture@example.invalid";

  // The owned-fork clone the design names: origin is the personal fork, upstream is the
  // recorded third-party parent.
  const owned = clone("owned-fork");
  initRepo(owned);
  addRemote(owned, "origin", OWNED_FORK);
  addRemote(owned, "upstream", THIRD_PARTY);
  git(owned, ["branch", "feat/x"]);
  git(owned, ["tag", "v1"]);
  setRemoteHead(owned, "origin", "main");
  mkdirSync(join(owned, "nested", "deep"), { recursive: true });

  // A worktree of the owned-fork clone, so the identity has to come from the common dir.
  git(owned, [
    "worktree",
    "add",
    "--quiet",
    "-b",
    "wt-owned",
    clone("owned-worktree"),
  ]);

  // One github destination: a gh command's cwd repo is then authoritative.
  const single = clone("single-clone");
  initRepo(single);
  addRemote(single, "origin", ORG_REPO);
  setRemoteHead(single, "origin", "main");
  git(single, ["branch", "feat/x"]);

  // Two github destinations: a gh command with no -R is ambiguous, because gh resolves the
  // default through the API and a fork's pull request targets its parent.
  const fork = clone("fork-clone");
  initRepo(fork);
  addRemote(fork, "origin", "https://github.com/simpsonm09/fork-demo.git");
  addRemote(
    fork,
    "upstream",
    "https://github.com/simpsonm09-org/demo-repo.git",
  );
  setRemoteHead(fork, "origin", "main");

  // A remote whose pushurl is the fork and whose fetch URL is the organization repository.
  const pushurl = clone("pushurl-clone");
  initRepo(pushurl);
  addRemote(pushurl, "origin", ORG_REPO, [
    "https://github.com/simpsonm09/pushurl-fork.git",
  ]);
  setRemoteHead(pushurl, "origin", "main");

  // Two push URLs: the destination is ambiguous and a governed write fails closed.
  const multi = clone("multi-pushurl-clone");
  initRepo(multi);
  addRemote(multi, "origin", ORG_REPO, [
    "https://github.com/simpsonm09/one.git",
    "https://github.com/simpsonm09/two.git",
  ]);

  // The default push remote precedence: branch.<b>.pushRemote, remote.pushDefault,
  // branch.<b>.remote, then origin. Each remote reaches a different destination, so the
  // observed destination names the one git chose.
  const precedence = clone("precedence-clone");
  initRepo(precedence);
  for (const name of ["a", "b", "c", "origin"])
    addRemote(precedence, name, `https://github.com/acme/${name}.git`);
  setRemoteHead(precedence, "origin", "main");
  git(precedence, ["config", "branch.main.remote", "b"]);
  git(precedence, ["config", "remote.pushDefault", "c"]);
  git(precedence, ["config", "branch.main.pushRemote", "a"]);

  // push.default and remote.<name>.push coverage.
  const defaults = clone("defaults-clone");
  initRepo(defaults);
  addRemote(defaults, "origin", OWNED_FORK);
  setRemoteHead(defaults, "origin", "main");

  // A remote whose default branch is not "main", so the default branch has to be resolved.
  const trunk = clone("trunk-clone");
  initRepo(trunk, "trunk");
  addRemote(trunk, "origin", OWNED_FORK);
  setRemoteHead(trunk, "origin", "trunk");

  // No remote-tracking HEAD at all: the default branch cannot be resolved from git.
  const noHead = clone("no-head-clone");
  initRepo(noHead);
  addRemote(noHead, "origin", OWNED_FORK);
  git(noHead, ["branch", "feat/x"]);
});

after(() => {
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

// ---------------------------------------------------------------------------------------
// the destination from git state
// ---------------------------------------------------------------------------------------

test("a branch push reports the named remote's destination and ref", () => {
  const observed = observeShellCommand(
    clone("owned-fork"),
    "git push origin feat/x",
  );
  assert.equal(observed.kind, "write");
  assert.equal(observed.operation, "push");
  assert.equal(observed.capability, "pushBranch");
  assert.equal(observed.resolved, true);
  assert.deepEqual(observationDestination(observed), {
    host: "github.com",
    destination: "simpsonm09/pstack-max",
  });
  assert.deepEqual(observed.refs, [
    { kind: "branch", name: "feat/x", isDefault: false },
  ]);
});

test("a push to the third-party upstream is observed as that destination", () => {
  const observed = observeShellCommand(
    clone("owned-fork"),
    "git push upstream feat/x",
  );
  assert.deepEqual(observationDestination(observed), {
    host: "github.com",
    destination: "michael-denyer/pstack-claude",
  });
  assert.equal(observed.refs[0].kind, "branch");
});

test("the default branch is denied as pushMain, not pushBranch", () => {
  for (const command of [
    "git push origin main",
    "git push origin refs/heads/main",
    "git push origin HEAD:main",
    "git push origin main:main",
  ]) {
    const observed = observeShellCommand(clone("owned-fork"), command);
    assert.equal(observed.capability, "pushMain", command);
    assert.equal(observed.refs[0].isDefault, true, command);
  }
});

test("a tag push is a tag ref, named or bare, and needs pushMain", () => {
  for (const command of [
    "git push origin refs/tags/v1",
    "git push origin v1",
  ]) {
    const observed = observeShellCommand(clone("owned-fork"), command);
    assert.equal(observed.refs[0].kind, "tag", command);
    assert.equal(observed.capability, "pushMain", command);
  }
});

test("HEAD resolves to the current branch and its default-branch state", () => {
  const observed = observeShellCommand(
    clone("owned-fork"),
    "git push origin HEAD",
  );
  assert.deepEqual(observed.refs, [
    { kind: "branch", name: "main", isDefault: true },
  ]);
  assert.equal(observed.capability, "pushMain");
});

test("deletion, bulk, and force flags are observed as such", () => {
  const cases: Array<[string, string, boolean, boolean]> = [
    ["git push origin :main", "pushMain", false, true],
    ["git push origin --delete feat/x", "pushMain", false, true],
    ["git push origin --tags", "pushMain", false, false],
    ["git push origin --all", "pushMain", false, false],
    ["git push origin --mirror", "pushMain", true, false],
    ["git push origin --follow-tags feat/x", "pushMain", false, false],
    ["git push --force-with-lease origin feat/x", "pushBranch", true, false],
    ["git push -f origin feat/x", "pushBranch", true, false],
    ["git push origin +feat/x", "pushBranch", true, false],
  ];
  for (const [command, capability, force, deletion] of cases) {
    const observed = observeShellCommand(clone("owned-fork"), command);
    assert.equal(observed.capability, capability, command);
    assert.equal(observed.force, force, command);
    assert.equal(observed.delete, deletion, command);
  }
});

test("--no-verify is an ordinary flag and does not stop the observation", () => {
  const observed = observeShellCommand(
    clone("owned-fork"),
    "git push --no-verify origin feat/x",
  );
  assert.equal(observed.kind, "write");
  assert.equal(observed.capability, "pushBranch");
});

test("a bare push resolves git's default push remote and the current branch", () => {
  const observed = observeShellCommand(clone("single-clone"), "git push");
  assert.equal(observed.destinationSource, "git-default");
  assert.deepEqual(observationDestination(observed), {
    host: "github.com",
    destination: "simpsonm09-org/demo-repo",
  });
  assert.deepEqual(observed.refs, [
    { kind: "branch", name: "main", isDefault: true },
  ]);
});

test("the real default push remote precedence is pushRemote, pushDefault, branch.remote, origin", () => {
  const path = clone("precedence-clone");
  const repository = (command: string) =>
    observationDestination(observeShellCommand(path, command))?.destination;

  assert.equal(repository("git push"), "acme/a", "branch.pushRemote wins");
  git(path, ["config", "--unset", "branch.main.pushRemote"]);
  assert.equal(repository("git push"), "acme/c", "remote.pushDefault is next");
  git(path, ["config", "--unset", "remote.pushDefault"]);
  git(path, ["config", "push.default", "current"]);
  assert.equal(repository("git push"), "acme/b", "branch.remote is next");
  git(path, ["config", "--unset", "branch.main.remote"]);
  assert.equal(repository("git push"), "acme/origin", "origin is the fallback");
  git(path, ["config", "--unset", "push.default"]);
});

test("an interchangeable remote URL is reported as the pushurl", () => {
  const observed = observeShellCommand(
    clone("pushurl-clone"),
    "git push origin feat/x",
  );
  assert.equal(observed.destinationSource, "pushurl");
  assert.deepEqual(observationDestination(observed), {
    host: "github.com",
    destination: "simpsonm09/pushurl-fork",
  });
});

test("two push URLs leave the destination unresolved", () => {
  const observed = observeShellCommand(
    clone("multi-pushurl-clone"),
    "git push origin feat/x",
  );
  assert.equal(observed.destination, null);
  assert.equal(observed.resolved, false);
  assert.equal(observed.kind, "ambiguous");
});

test("a worktree and a nested subdirectory observe as the clone", () => {
  for (const path of [
    clone("owned-worktree"),
    join(clone("owned-fork"), "nested", "deep"),
  ]) {
    const observed = observeShellCommand(path, "git push origin feat/x");
    assert.deepEqual(observationDestination(observed), {
      host: "github.com",
      destination: "simpsonm09/pstack-max",
    });
  }
});

test("git -C observes the directory the command itself names", () => {
  const observed = observeShellCommand(
    root,
    `git -C "${clone("owned-fork")}" push origin feat/x`,
  );
  assert.deepEqual(observationDestination(observed), {
    host: "github.com",
    destination: "simpsonm09/pstack-max",
  });
});

test("a remote whose default branch is not main is resolved from git", () => {
  const observed = observeShellCommand(
    clone("trunk-clone"),
    "git push origin trunk",
  );
  assert.deepEqual(observed.refs, [
    { kind: "branch", name: "trunk", isDefault: true },
  ]);
  assert.equal(observed.capability, "pushMain");
});

test("a branch push with no resolvable default branch is denied for a non-organization destination", () => {
  const branch = observeShellCommand(
    clone("no-head-clone"),
    "git push origin feat/x",
  );
  assert.equal(branch.capability, "pushBranch");
  assert.equal(branch.refs[0].isDefault, null);
  assert.equal(branch.resolved, true);

  const convention = observeShellCommand(
    clone("no-head-clone"),
    "git push origin main",
  );
  assert.equal(convention.capability, "pushMain");
  assert.equal(convention.refs[0].isDefault, true);
});

test("remote.<name>.push supplies the refspecs of a bare push", () => {
  const path = clone("defaults-clone");
  git(path, [
    "config",
    "remote.origin.push",
    "refs/heads/feat/x:refs/heads/feat/x",
  ]);
  const observed = observeShellCommand(path, "git push origin");
  assert.equal(observed.capability, "pushBranch");
  assert.deepEqual(observed.refs, [
    { kind: "branch", name: "feat/x", isDefault: false },
  ]);
  git(path, ["config", "--unset", "remote.origin.push"]);
});

test("push.default matching is a multi-ref write and nothing is a write with nothing", () => {
  const path = clone("defaults-clone");
  git(path, ["config", "push.default", "matching"]);
  const matching = observeShellCommand(path, "git push");
  assert.equal(matching.capability, "pushMain");
  git(path, ["config", "push.default", "nothing"]);
  const nothing = observeShellCommand(path, "git push");
  assert.equal(nothing.resolved, false);
  git(path, ["config", "--unset", "push.default"]);
});

test("a push with an unparseable or unresolved remote fails closed", () => {
  for (const command of [
    "git push /tmp/local-bare.git feat/x",
    "git push origin does-not-exist",
  ]) {
    const observed = observeShellCommand(clone("owned-fork"), command);
    assert.equal(observed.resolved, false, command);
  }
});

test("the first positional is the repository, so an unknown one is never a refspec", () => {
  const owned = clone("owned-fork");
  // `git push [<repository> [<refspec>...]]`: the first positional is always the repository.
  // feat/x is a local branch in this clone and not a remote, so git reads it as a repository
  // path; the observation must stay unresolved rather than fall back to the default remote.
  for (const command of [
    "git push feat/x",
    "git push does-not-exist",
    "git push feat/x feat/x",
    "git push /tmp/local-bare.git feat/x",
  ]) {
    const observed = observeShellCommand(owned, command);
    assert.equal(observed.destination, null, command);
    assert.equal(observed.resolved, false, command);
    assert.equal(observed.kind, "ambiguous", command);
    assert.equal(observed.readOnly, false, command);
  }
  // No repository token was taken, so git's default refspec selection (remote.<r>.push,
  // push.default, the current branch) does not apply: the refs are the named ones only, and
  // the misread cannot report the default branch as the target.
  assert.deepEqual(observeShellCommand(owned, "git push feat/x").refs, []);
  assert.deepEqual(
    observeShellCommand(owned, "git push does-not-exist").refs,
    [],
  );
  assert.deepEqual(
    observeShellCommand(owned, "git push /tmp/local-bare.git feat/x").refs,
    [{ kind: "branch", name: "feat/x", isDefault: null }],
  );
});

test("a named remote, an explicit URL, and a bare push still name their destination", () => {
  const owned = clone("owned-fork");

  const named = observeShellCommand(owned, "git push origin feat/x");
  assert.equal(named.destinationSource, "remote");
  assert.deepEqual(observationDestination(named), {
    host: "github.com",
    destination: "simpsonm09/pstack-max",
  });

  // The explicit-URL path, which no earlier test reached: the URL itself is the destination,
  // and its default branch is resolved when the URL is also a configured remote.
  const url = observeShellCommand(
    owned,
    "git push https://github.com/simpsonm09/pstack-max.git feat/x",
  );
  assert.equal(url.destinationSource, "url");
  assert.equal(url.resolved, true);
  assert.deepEqual(observationDestination(url), {
    host: "github.com",
    destination: "simpsonm09/pstack-max",
  });
  assert.deepEqual(url.refs, [
    { kind: "branch", name: "feat/x", isDefault: false },
  ]);

  // A URL no remote names: the destination is known, the default branch is not, and the
  // resolver's push rule requires isDefault === false, so a branch push stays denied.
  const unconfigured = observeShellCommand(
    owned,
    "git push https://github.com/simpsonm09/other-repo.git feat/x",
  );
  assert.equal(unconfigured.resolved, true);
  assert.deepEqual(observationDestination(unconfigured), {
    host: "github.com",
    destination: "simpsonm09/other-repo",
  });
  assert.equal(unconfigured.refs[0].isDefault, null);

  // No positional at all is the one form that uses git's default push remote.
  const bare = observeShellCommand(clone("single-clone"), "git push");
  assert.equal(bare.destinationSource, "git-default");
  assert.deepEqual(observationDestination(bare), {
    host: "github.com",
    destination: "simpsonm09-org/demo-repo",
  });
});

test("--prune is a multi-ref write, alone and with a refspec", () => {
  const owned = clone("owned-fork");
  for (const command of [
    "git push origin --prune",
    "git push origin --prune feat/x",
    "git push origin --prune --tags",
    "git push origin --prune refs/heads/*:refs/heads/*",
    "git push --prune origin feat/x",
  ]) {
    const observed = observeShellCommand(owned, command);
    assert.equal(observed.capability, "pushMain", command);
  }
  // The contrast: without --prune the same refspec is a single non-default branch push.
  const without = observeShellCommand(owned, "git push origin feat/x");
  assert.equal(without.capability, "pushBranch");
});

test("an empty destination refspec is unresolved, never normalized to the source", () => {
  const owned = clone("owned-fork");
  // git 2.55 refuses `git push origin feat/x:` with "fatal: invalid refspec" (verified with a
  // local --dry-run against a new bare repository), so it is neither a push of the source nor
  // a deletion. It stays unresolved, which denies it, rather than being read as feat/x.
  for (const command of [
    "git push origin feat/x:",
    "git push origin main:",
    "git push origin does-not-exist:",
  ]) {
    const observed = observeShellCommand(owned, command);
    assert.equal(observed.resolved, false, command);
    assert.equal(observed.kind, "ambiguous", command);
    assert.equal(observed.refs[0].kind, "unknown", command);
    assert.equal(observed.delete, false, command);
  }
  // An empty *source* is the documented deletion form and keeps its meaning.
  const deletion = observeShellCommand(owned, "git push origin :feat/x");
  assert.equal(deletion.delete, true);
  assert.equal(deletion.resolved, true);
  assert.equal(deletion.capability, "pushBranch");
  assert.deepEqual(deletion.refs, [
    { kind: "branch", name: "feat/x", isDefault: false },
  ]);
  const defaultDeletion = observeShellCommand(owned, "git push origin :main");
  assert.equal(defaultDeletion.delete, true);
  assert.equal(defaultDeletion.capability, "pushMain");
});

// ---------------------------------------------------------------------------------------
// gh
// ---------------------------------------------------------------------------------------

test("gh -R is read as a global flag and as a command flag", () => {
  for (const command of [
    "gh pr create -R simpsonm09/pstack-max",
    "gh -R simpsonm09/pstack-max pr create",
    "gh pr create --repo=simpsonm09/pstack-max",
    "gh pr create -Rsimpsonm09/pstack-max",
  ]) {
    const observed = observeShellCommand(clone("owned-fork"), command);
    assert.equal(observed.capability, "openPr", command);
    assert.deepEqual(observationDestination(observed), {
      host: "github.com",
      destination: "simpsonm09/pstack-max",
    });
    assert.equal(observed.resolved, true, command);
  }
});

test("gh pr create reads the head and base sides", () => {
  const observed = observeShellCommand(
    clone("owned-fork"),
    "gh pr create -R simpsonm09/pstack-max -B main -H feat/x",
  );
  assert.deepEqual(observed.base, { owner: null, repo: null, branch: "main" });
  assert.deepEqual(observed.head, {
    owner: null,
    repo: null,
    branch: "feat/x",
  });
  const crossOwner = observeShellCommand(
    clone("owned-fork"),
    "gh pr create -R simpsonm09/pstack-max --base michael-denyer:main",
  );
  assert.deepEqual(crossOwner.base, {
    owner: "michael-denyer",
    repo: null,
    branch: "main",
  });
});

test("gh writes carry their policy operation and capability", () => {
  const cases: Array<[string, string, string]> = [
    ["gh pr merge 1 -R simpsonm09/pstack-max", "mergePr", "mergePr"],
    ["gh pr merge 1 -m -R simpsonm09/pstack-max", "mergePr", "mergePr"],
    ["gh pr merge 1 --admin -R simpsonm09/pstack-max", "admin", "forbidden"],
    ["gh release create v1 -R simpsonm09/pstack-max", "admin", "admin"],
    ["gh workflow run ci.yml -R simpsonm09/pstack-max", "admin", "admin"],
    ["gh secret set X -R simpsonm09/pstack-max", "admin", "admin"],
    ["gh repo edit --description y -R simpsonm09/pstack-max", "admin", "admin"],
    ["gh issue create -R simpsonm09/pstack-max", "openPr", "openPr"],
    [
      "gh pr edit 1 --add-label ready -R simpsonm09/pstack-max",
      "openPr",
      "openPr",
    ],
    [
      "gh pr edit 1 --add-reviewer octocat --add-assignee monalisa --remove-label stale -R simpsonm09/pstack-max",
      "openPr",
      "openPr",
    ],
    ["gh pr close 1 -R simpsonm09/pstack-max", "openPr", "openPr"],
    ["gh pr reopen 1 -R simpsonm09/pstack-max", "openPr", "openPr"],
    ["gh pr ready 1 --undo -R simpsonm09/pstack-max", "openPr", "openPr"],
    ["gh pr review 1 --approve -R simpsonm09/pstack-max", "admin", "forbidden"],
    [
      "gh pr review-comment 1 --body x -R simpsonm09/pstack-max",
      "admin",
      "forbidden",
    ],
    [
      "gh milestone create --title x -R simpsonm09/pstack-max",
      "admin",
      "admin",
    ],
    [
      "gh milestone edit 1 --due-date 2026-11-01 -R simpsonm09/pstack-max",
      "admin",
      "admin",
    ],
    ["gh milestone delete 1 -R simpsonm09/pstack-max", "admin", "admin"],
    ["gh issue edit 1 -m 2 -R simpsonm09/pstack-max", "admin", "admin"],
    [
      "gh issue edit 1 --title fixed --body-file notes.md --milestone 2 --add-label ready --add-assignee monalisa --add-project Roadmap --remove-project Old -R simpsonm09/pstack-max",
      "admin",
      "admin",
    ],
    [
      "gh pr edit 1 --add-label ready --milestone 2 -R simpsonm09/pstack-max",
      "admin",
      "admin",
    ],
    [
      "gh issue create --title bug --milestone 2 -R simpsonm09/pstack-max",
      "admin",
      "admin",
    ],
    [
      "gh pr create --title change --milestone 2 -R simpsonm09/pstack-max",
      "admin",
      "admin",
    ],
  ];
  for (const [command, operation, capability] of cases) {
    const observed = observeShellCommand(clone("owned-fork"), command);
    assert.equal(observed.capability, capability, command);
    assert.equal(observed.operation, operation, command);
  }
});

test("positional gh repo view and clone identify the requested repo, not clone directory", () => {
  for (const command of [
    "gh repo view simpsonm09/steam_wishlist_cleanup",
    "gh repo view https://github.com/simpsonm09/steam_wishlist_cleanup",
    "gh repo clone simpsonm09/steam_wishlist_cleanup local-copy",
  ]) {
    const observed = observeShellCommand(clone("owned-fork"), command);
    assert.deepEqual(
      observed.destination,
      {
        host: "github.com",
        owner: "simpsonm09",
        repo: "steam_wishlist_cleanup",
      },
      command,
    );
    assert.equal(observed.readOnly, true, command);
  }
});

test("repo fork checks its named source and malformed view URLs do not fall back to cwd", () => {
  const ignoredFork = observeShellCommand(
    clone("owned-fork"),
    "gh repo fork simpsonm09/steam_wishlist_cleanup",
  );
  assert.equal(ignoredFork.capability, "admin");
  assert.equal(ignoredFork.destination?.repo, "steam_wishlist_cleanup");
  assert.equal(ignoredFork.destinationSource, "explicit");

  const otherFork = observeShellCommand(
    clone("owned-fork"),
    "gh repo fork acme/ordinary-repo",
  );
  assert.equal(otherFork.capability, "admin");
  assert.equal(otherFork.destination?.owner, "acme");
  assert.equal(otherFork.destination?.repo, "ordinary-repo");

  for (const command of [
    "gh repo view https://github.com/simpsonm09/steam_wishlist_cleanup/tree/main",
    "gh repo clone https://github.com/simpsonm09/steam_wishlist_cleanup/tree/main local",
    "gh repo view simpsonm09/steam_wishlist_cleanup/extra",
  ]) {
    const observed = observeCommand(command, {
      cwd: "/fake/worktree",
      git: ownedForkPort,
    });
    assert.equal(observed.destination, null, command);
    assert.equal(observed.resolved, false, command);
    assert.equal(observed.kind, "unsupported", command);
    assert.equal(observed.readOnly, true, command);
  }
  assert.equal(
    observeShellCommand(
      clone("owned-fork"),
      "gh repo view https://github.com/acme/ordinary-repo",
    ).destination?.repo,
    "ordinary-repo",
  );
});

test("malformed URL-like gh repo positionals never fall back to cwd for writes", () => {
  for (const command of [
    "gh repo fork https://github.com/simpsonm09/steam_wishlist_cleanup/tree/main",
    "gh repo edit https://github.com/simpsonm09/steam_wishlist_cleanup/tree/main --description x",
    "gh repo rename https://github.com/simpsonm09/steam_wishlist_cleanup/tree/main renamed",
    "gh repo archive https://github.com/simpsonm09/steam_wishlist_cleanup/tree/main --yes",
    "gh repo unarchive https://github.com/simpsonm09/steam_wishlist_cleanup/tree/main --yes",
    "gh repo sync https://github.com/simpsonm09/steam_wishlist_cleanup/tree/main",
    "gh repo delete https://github.com/simpsonm09/steam_wishlist_cleanup/tree/main --yes",
  ]) {
    const observed = observeCommand(command, {
      cwd: "/fake/worktree",
      git: ownedForkPort,
    });
    assert.equal(observed.destination, null, command);
    assert.equal(observed.destinationSource, "explicit", command);
    assert.equal(observed.resolved, false, command);
    assert.equal(observed.readOnly, false, command);
    assert.equal(observed.capability, "admin", command);
  }
});

test("REST and GraphQL review writes are never-granted", () => {
  for (const command of [
    "gh api -X POST repos/acme/demo/pulls/1/reviews -f event=APPROVE",
    "gh api --unknown-option repos/acme/demo/pulls/1/reviews -X POST",
    "gh api repos/acme/demo/pulls/1/reviews/2/dismissals -X PUT -f message=x",
    "gh api -X POST repos/acme/demo/pulls/1/comments?per_page=10#recent",
    "gh api -X POST https://api.github.com/repos/acme/demo/pulls/1/reviews?x=1#top -f event=APPROVE",
    "gh api -X POST https://api.github.com/repos/acme/demo/pulls/1/comments?x=1",
    `gh api graphql -f 'query=mutation { addPullRequestReview(input: {}) { clientMutationId } }'`,
    "gh api --unknown-opt graphql -f query='mutation { updatePullRequestReview(input: {}) { clientMutationId } }'",
    "gh api graphql -f query='mutation { updatePullRequestReviewComment(input: {}) { clientMutationId } }'",
    "gh api graphql -f query='mutation { deletePullRequestReview(input: {}) { clientMutationId } }'",
    "gh api graphql -f query='mutation { deletePullRequestReviewComment(input: {}) { clientMutationId } }'",
    "gh api graphql -f query='mutation { resolveReviewThread(input: {}) { thread { id } } }'",
    "gh api graphql -f query='mutation { unresolveReviewThread(input: {}) { thread { id } } }'",
  ]) {
    const observed = observeShellCommand(clone("owned-fork"), command);
    assert.equal(observed.capability, "forbidden", command);
  }
  for (const command of [
    "gh api https://api.github.com/repos/acme/demo/issues/1 -X POST",
    "gh api graphql -f query='mutation { closeIssue(input: {}) { issue { id } } }'",
  ])
    assert.equal(
      observeShellCommand(clone("owned-fork"), command).capability,
      "admin",
      command,
    );
  const unsupportedUrl = observeShellCommand(
    clone("owned-fork"),
    "gh api -X POST http://api.github.com/repos/acme/demo/pulls/1/reviews",
  );
  assert.equal(unsupportedUrl.resolved, false);
  assert.equal(unsupportedUrl.capability, "forbidden");
});

test("review-comment item mutations and ambiguous review paths are forbidden", () => {
  for (const command of [
    "gh api -X PATCH repos/acme/demo/pulls/comments/5 -f body=x",
    "gh api -X DELETE repos/acme/demo/pulls/comments/5",
    "gh api -X POST repos/acme/demo/pulls/1/%72eviews -f event=APPROVE",
    "gh api -X POST repos/acme/demo/pulls//1/reviews -f event=APPROVE",
  ]) {
    assert.equal(
      observeCommand(command, { cwd: "/fake/worktree", git: ownedForkPort })
        .capability,
      "forbidden",
      command,
    );
  }
  const get = observeCommand("gh api -X GET repos/acme/demo/pulls/comments/5", {
    cwd: "/fake/worktree",
    git: ownedForkPort,
  });
  assert.equal(get.capability, null);
  assert.equal(get.readOnly, true);
  assert.equal(
    observeCommand("gh api -X POST repos/acme/demo/issues/1/comments", {
      cwd: "/fake/worktree",
      git: ownedForkPort,
    }).capability,
    "admin",
  );
});

test("single-destination git reads expose canonical GitHub identities for ignore checks", () => {
  const cwd = clone("owned-fork");
  const cases: Array<[string, string, string]> = [
    ["git clone https://github.com/acme/demo.git demo", "acme", "demo"],
    ["git fetch upstream", "michael-denyer", "pstack-claude"],
    ["git pull origin main", "simpsonm09", "pstack-max"],
    ["git ls-remote https://github.com/acme/demo.git", "acme", "demo"],
  ];
  for (const [command, owner, repo] of cases) {
    const observed = observeShellCommand(cwd, command);
    assert.equal(observed.readOnly, true, command);
    assert.deepEqual(observed.destination, {
      host: "github.com",
      owner,
      repo,
    });
  }
  assert.equal(
    observeShellCommand(cwd, "git fetch --all").kind,
    OBSERVATION_KINDS.unsupported,
  );
  assert.equal(
    observeShellCommand(cwd, "git fetch").kind,
    OBSERVATION_KINDS.unsupported,
  );
});

test("ambiguous GitHub-like read URLs and unresolved remotes are unsupported reads", () => {
  const urls = [
    "https://github.com/simpsonm09/demo-fork/../steam_wishlist_cleanup",
    "https://github.com./simpsonm09/steam_wishlist_cleanup",
    "https://github.com/simpsonm09/steam%5Fwishlist_cleanup",
  ];
  for (const url of urls) {
    const observed = observeCommand(`git fetch ${url}`, {
      cwd: "/fake/worktree",
      git: (args) =>
        args.slice(-3, -1).join(" ") === "ls-remote --get-url"
          ? (args.at(-1) ?? null)
          : null,
    });
    assert.equal(observed.kind, "unsupported", url);
    assert.equal(observed.readOnly, true, url);
    assert.equal(observed.destination, null, url);
  }
  const unresolvedRemote = observeCommand("git fetch origin", {
    cwd: "/fake/worktree",
    git: () => null,
  });
  assert.equal(unresolvedRemote.kind, "unsupported");
  assert.equal(unresolvedRemote.readOnly, true);
});

test("git read flags keep recurse-submodules URLs in the positional stream", () => {
  const ignored = "https://github.com/simpsonm09/steam_wishlist_cleanup";
  for (const command of [
    `git fetch --recurse-submodules ${ignored}`,
    `git pull --recurse-submodules ${ignored}`,
    `git clone --recurse-submodules ${ignored} demo`,
    `echo x && git fetch --recurse-submodules ${ignored}`,
  ]) {
    const observed = observeShellCommand(clone("owned-fork"), command);
    const reads = observed.destinationReads ?? [observed];
    assert.ok(
      reads.some(
        (read) =>
          read.destination?.owner === "simpsonm09" &&
          read.destination.repo === "steam_wishlist_cleanup",
      ),
      command,
    );
  }
  for (const command of [
    `git fetch --recurse-submodules=on-demand ${ignored}`,
    `git fetch ${ignored}`,
  ]) {
    const observed = observeShellCommand(clone("owned-fork"), command);
    assert.equal(observed.kind, "read", command);
    assert.equal(observed.destination?.repo, "steam_wishlist_cleanup", command);
  }
});

test("raw git read URLs use the command-scoped offline insteadOf result", () => {
  const command =
    "git -C . -c url.https://github.com/acme/rewritten.insteadOf=https://github.com/acme/original ls-remote https://github.com/acme/original";
  const calls: string[][] = [];
  const observed = observeCommand(command, {
    cwd: "/nowhere",
    git: (args) => {
      calls.push(args);
      if (args.at(-3) === "ls-remote" && args.at(-2) === "--get-url")
        return "https://github.com/acme/rewritten";
      return null;
    },
  });
  assert.equal(observed.destination?.repo, "rewritten");
  assert.ok(
    calls.some(
      (args) =>
        args[0] === "-C" &&
        args[1] === "." &&
        args[2] === "-c" &&
        args[3].startsWith(
          "url.https://github.com/acme/rewritten.insteadOf=",
        ) &&
        args.slice(-3).join(" ") ===
          "ls-remote --get-url https://github.com/acme/original",
    ),
  );
});

test("compound directory changes with reads remain unsupported", () => {
  for (const command of [
    "cd /elsewhere && git fetch origin",
    "chdir /elsewhere && git pull origin main",
    "pushd /elsewhere && git ls-remote origin",
    "popd && git fetch origin",
  ])
    assert.equal(
      observeShellCommand(clone("owned-fork"), command).kind,
      "unsupported",
      command,
    );
  for (const command of [
    "Set-Location /elsewhere; git fetch origin",
    "sl /elsewhere; git pull origin main",
    "Push-Location /elsewhere; git ls-remote origin",
    "Pop-Location; git fetch origin",
  ])
    assert.equal(
      observeShellCommand(clone("owned-fork"), command, { shell: "powershell" })
        .kind,
      "unsupported",
      command,
    );
  assert.equal(
    observeShellCommand(clone("owned-fork"), "echo ok && git fetch origin")
      .kind,
    "local",
  );
});

test("gh api reads GET and HEAD, and everything else is a conservative write", () => {
  const read = [
    "gh api repos/o/r",
    "gh api -X GET repos/o/r",
    "gh api -XGET repos/o/r",
    "gh api -X=GET repos/o/r",
    "gh api -X HEAD repos/o/r",
  ];
  for (const command of read) {
    const observed = observeShellCommand(clone("single-clone"), command);
    assert.equal(observed.capability, null, command);
    assert.equal(observed.readOnly, true, command);
  }
  const write = [
    "gh api -X POST repos/o/r",
    "gh api -XDELETE repos/o/r",
    "gh api --method=PATCH repos/o/r",
    "gh api -X OPTIONS repos/o/r",
    "gh api -XPOSTED repos/o/r",
    "gh api -f name=value repos/o/r",
    "gh api --input - repos/o/r",
    "gh api graphql -f query=mutation",
  ];
  for (const command of write) {
    const observed = observeShellCommand(clone("single-clone"), command);
    assert.equal(observed.capability, "admin", command);
  }
});

test("every gh api body spelling is a write, including the attached short form", () => {
  // gh (cobra/pflag) accepts a short option's value attached (`-fVALUE`), joined with `=`
  // (`-f=VALUE`), or separate (`-f VALUE`). A body flag in any of those spellings sends a
  // body, so it is an admin write in every one of them; a miss would report a governed write
  // as a read.
  const write = [
    "gh api -f query=mutation repos/o/r",
    "gh api -f=query=mutation repos/o/r",
    "gh api -fquery=mutation repos/o/r",
    "gh api graphql -fquery=mutation",
    "gh api -fkey=value repos/o/r",
    "gh api -Fkey=@file repos/o/r",
    "gh api -F key=@file repos/o/r",
    "gh api --field=key=value repos/o/r",
    "gh api --field key=value repos/o/r",
    "gh api --raw-field=key=value repos/o/r",
    "gh api --raw-field key=value repos/o/r",
    "gh api --input=body.json repos/o/r",
    "gh api --input body.json repos/o/r",
    "gh api -X POST -fkey=value repos/o/r",
    "gh api -XGET -fquery=mutation repos/o/r",
    // The method gh uses is the last one, so an earlier read method cannot hide the write.
    "gh api -X GET -X DELETE repos/o/r",
  ];
  for (const command of write) {
    const observed = observeShellCommand(clone("single-clone"), command);
    assert.equal(observed.capability, "admin", command);
    assert.equal(observed.operation, "admin", command);
    assert.equal(observed.readOnly, false, command);
    assert.equal(observed.kind, "write", command);
  }
  // A "-f" inside a positional is not a body flag: only a token that *is* the option, or
  // begins with it, is one.
  const read = [
    "gh api repos/o/r",
    "gh api repos/o/r/contents/notes-fx",
    "gh api -X GET repos/o/r/contents/branch-files",
  ];
  for (const command of read) {
    const observed = observeShellCommand(clone("single-clone"), command);
    assert.equal(observed.capability, null, command);
    assert.equal(observed.readOnly, true, command);
  }
});

test("a known gh read and a local gh group are not writes", () => {
  for (const command of [
    "gh pr view 1",
    "gh pr checks",
    "gh run view 1",
    "gh repo view",
    "gh config get x",
    "gh alias list",
  ]) {
    const observed = observeShellCommand(clone("owned-fork"), command);
    assert.equal(observed.capability, null, command);
    assert.equal(observed.readOnly, true, command);
  }
});

test("a gh write with no -R is authoritative only when git names one destination", () => {
  const single = observeShellCommand(clone("single-clone"), "gh pr create");
  assert.equal(single.resolved, true);
  assert.deepEqual(observationDestination(single), {
    host: "github.com",
    destination: "simpsonm09-org/demo-repo",
  });

  const fork = observeShellCommand(clone("fork-clone"), "gh pr create");
  assert.equal(fork.destination, null);
  assert.equal(fork.resolved, false);
  assert.equal(fork.capability, "openPr");
  assert.equal(fork.kind, "ambiguous");
});

test("an unparseable -R leaves the gh destination unresolved", () => {
  const observed = observeShellCommand(
    clone("owned-fork"),
    "gh pr create -R not-a-repo",
  );
  assert.equal(observed.destination, null);
  assert.equal(observed.resolved, false);
});

test("two -R flags leave the gh destination unresolved", () => {
  const observed = observeShellCommand(
    clone("owned-fork"),
    "gh pr create -R simpsonm09/pstack-max -R simpsonm09-org/other",
  );
  assert.equal(observed.destination, null);
  assert.equal(observed.resolved, false);
  assert.equal(observed.capability, "openPr");
});

// ---------------------------------------------------------------------------------------
// the option grammar: a value is never another option's flag
// ---------------------------------------------------------------------------------------

test("an option's value cannot be read as the repo, base, or head flag", () => {
  const single = clone("single-clone");
  const other = "simpsonm09-org/other-repo";
  // pflag hands the token after --title to --title, so a value that begins with "-R" is a
  // title, not the repository. The destination is then the clone's own, never the value.
  for (const command of [
    `gh pr create --title -R${other}`,
    `gh pr create --title -R ${other}`,
    `gh pr create --title --repo=${other}`,
    `gh pr create --title=-R${other}`,
    `gh pr create --body -Hmichael-denyer:main`,
  ]) {
    const observed = observeShellCommand(single, command);
    const destination = observationDestination(observed);
    assert.notEqual(destination?.destination, other, command);
    assert.deepEqual(
      destination,
      { host: "github.com", destination: "simpsonm09-org/demo-repo" },
      command,
    );
  }

  // A value that looks like --base/--head is the option's value, not a side.
  const sides = observeShellCommand(
    single,
    "gh pr create --title -Bmain --head feat/x",
  );
  assert.equal(sides.base, null);
  assert.deepEqual(sides.head, { owner: null, repo: null, branch: "feat/x" });

  const body = observeShellCommand(
    single,
    "gh pr create --body -Hmichael-denyer:main",
  );
  assert.equal(body.head, null);

  // A real -R is still authoritative, wherever it appears after the model's options.
  const explicit = observeShellCommand(
    single,
    `gh pr create --title x -R ${other}`,
  );
  assert.equal(explicit.destinationSource, "explicit");
  assert.deepEqual(observationDestination(explicit), {
    host: "github.com",
    destination: other,
  });
});

test("an unknown write option leaves the destination unresolved rather than guessed", () => {
  const observed = observeShellCommand(
    clone("single-clone"),
    "gh pr create --some-unmodeled-option value -R simpsonm09-org/other-repo",
  );
  assert.equal(observed.destination, null);
  assert.equal(observed.resolved, false);
  assert.equal(observed.kind, "ambiguous");
});

test("a repeated base or head with two different values is unresolved, not the first value", () => {
  const observed = observeShellCommand(
    clone("single-clone"),
    "gh pr create --base main --base other --head feat/x",
  );
  assert.equal(observed.resolved, false);
});

test("an inherited destination-changing variable is observed by name, never by value", () => {
  const observed = observeShellCommand(
    clone("single-clone"),
    "git push origin feat/x",
    { env: ["GH_REPO", "GIT_DIR"] },
  );
  assert.deepEqual(observed.environment, ["GH_REPO", "GIT_DIR"]);
  const clean = observeShellCommand(
    clone("single-clone"),
    "git push origin feat/x",
  );
  assert.deepEqual(clean.environment, []);
  // An inline assignment is the command's own decision and is unsupported, distinct from an
  // inherited variable.
  assert.equal(
    observeShellCommand(
      clone("single-clone"),
      "GH_REPO=x git push origin feat/x",
    ).kind,
    "unsupported",
  );
});

// ---------------------------------------------------------------------------------------
// forms that are not covered
// ---------------------------------------------------------------------------------------

test("quoted text is not a program word: the past false positives stay local", () => {
  for (const command of [
    `echo "gh pr create"`,
    `git commit -m "gh pr create docs"`,
    `npm test 2>&1 | grep "git push origin main"`,
    "git status",
    "npm test",
    `git commit -m "a | b && gh pr create"`,
  ]) {
    const observed = observeShellCommand(clone("owned-fork"), command);
    assert.equal(observed.kind, "local", command);
    assert.equal(observed.readOnly, true, command);
  }
});

test("a compound command with a governed write is unresolved, not granted", () => {
  for (const command of [
    "echo hi && git push origin main",
    "git push origin feat/x; git push upstream main",
    "git fetch && gh pr merge 1",
  ]) {
    const observed = observeShellCommand(clone("owned-fork"), command);
    assert.equal(observed.kind, "unsupported", command);
    assert.equal(observed.readOnly, command.startsWith("git fetch"), command);
    assert.equal(observed.capability, null, command);
  }
});

test("compound reads preserve every destination for the ignore check", () => {
  const observation = observeShellCommand(
    clone("owned-fork"),
    "echo before && git ls-remote https://github.com/simpsonm09/steam_wishlist_cleanup",
  );
  assert.equal(observation.kind, "local");
  assert.deepEqual(
    observation.destinationReads?.map((read) => read.destination),
    [
      {
        host: "github.com",
        owner: "simpsonm09",
        repo: "steam_wishlist_cleanup",
      },
    ],
  );
  assert.equal(
    observeShellCommand(clone("owned-fork"), "echo ok && git fetch --unknown")
      .kind,
    "unsupported",
  );
});

test("bounded opaque-prefix premise table fails closed and keeps local controls", () => {
  const table: Array<[string, string, string]> = [
    [
      "brace read",
      "{ git fetch https://github.com/acme/demo; }",
      "unsupported",
    ],
    ["brace cwd group", "{ cd /other; git fetch origin; }", "unsupported"],
    ["brace write", "{ git push origin main; }", "unsupported"],
    ["brace local control", "{ echo local; }", "local"],
    [
      "command read",
      "command git fetch https://github.com/acme/demo",
      "unsupported",
    ],
    ["env read", "env git fetch https://github.com/acme/demo", "unsupported"],
    [
      "env changed-config read",
      "env GIT_DIR=/other git fetch origin",
      "unsupported",
    ],
    [
      "env split-string read",
      "env -S 'git fetch https://github.com/acme/demo'",
      "unsupported",
    ],
    ["env split-string write", "env -S 'git push origin main'", "unsupported"],
    ["time read", "time git fetch https://github.com/acme/demo", "unsupported"],
    ["exec read", "exec git fetch https://github.com/acme/demo", "unsupported"],
    [
      "nohup read",
      "nohup git fetch https://github.com/acme/demo",
      "unsupported",
    ],
    ["command write", "command git push origin main", "unsupported"],
    ["env write", "env git push origin main", "unsupported"],
    ["time write", "time git push origin main", "unsupported"],
    ["exec write", "exec git push origin main", "unsupported"],
    ["nohup write", "nohup git push origin main", "unsupported"],
    ["local executable", "npm test", "local"],
    ["local git control", "git status", "local"],
    ["quoted command text", 'echo "gh pr create"', "local"],
  ];
  for (const [name, command, expected] of table) {
    const observed = observeCommand(command, {
      cwd: "/fake/worktree",
      git: () => null,
    });
    assert.equal(observed.kind, expected, `${name}: ${command}`);
    if (expected === "unsupported" && !name.startsWith("brace"))
      assert.equal(observed.readOnly, !/push/.test(command), name);
  }
});

test("else arms stay opaque while grouped local git and static assignments stay local", () => {
  const table: Array<[string, string, string]> = [
    [
      "else git push",
      "if false; then echo a; else git push origin main; fi",
      "unsupported",
    ],
    [
      "else gh write",
      "if false; then :; else gh pr merge 52 -R simpsonm09-org/demo-repo --merge; fi",
      "unsupported",
    ],
    [
      "else ignored read",
      "if false; then :; else git fetch https://github.com/simpsonm09/steam_wishlist_cleanup; fi",
      "unsupported",
    ],
    ["brace status", "{ git status; }", "local"],
    ["no-space subshell status", "(git status)", "local"],
    ["subshell status", "( git status )", "local"],
    ["brace log", "{ git log --oneline; }", "local"],
    ["brace add", "{ git add .; }", "local"],
    ["brace commit", "{ git commit -m x; }", "local"],
    ["assignment-only segment", "X=1; echo hi", "local"],
    [
      "assignment with substitution remains unsupported",
      "X=$(echo hi); echo hi",
      "unsupported",
    ],
  ];
  for (const [name, command, expected] of table) {
    const observed = observeCommand(command, {
      cwd: "/fake/worktree",
      git: () => null,
    });
    assert.equal(observed.kind, expected, `${name}: ${command}`);
    if (name === "else git push") assert.equal(observed.readOnly, false, name);
    if (name === "else gh write")
      assert.equal(observed.ghWriteSignal, true, name);
    if (name === "else ignored read")
      assert.equal(observed.readOnly, true, name);
  }
});

test("a wrapper or interpreter is local, which is the documented escape", () => {
  for (const command of [
    `bash -c 'git push origin main'`,
    `iex "git push origin main"`,
    "Start-Process git -ArgumentList push",
    "xargs -n1 git push origin",
  ]) {
    const observed = observeShellCommand(clone("owned-fork"), command);
    assert.equal(observed.kind, "local", command);
  }
});

test("a PowerShell call operator with a literal program name is still observed", () => {
  const observed = observeShellCommand(
    clone("owned-fork"),
    "& 'git' push origin main",
    { shell: "powershell" },
  );
  assert.equal(observed.capability, "pushMain");
  assert.deepEqual(observationDestination(observed), {
    host: "github.com",
    destination: "simpsonm09/pstack-max",
  });
});

test("an unmodeled git form is unsupported rather than granted", () => {
  for (const command of [
    "git --git-dir=/tmp/other push origin main",
    "git push --upload-pack=/tmp/x origin main",
    "git push --repo",
    "GIT_DIR=/tmp/other git push origin main",
  ]) {
    const observed = observeShellCommand(clone("owned-fork"), command);
    assert.equal(observed.kind, "unsupported", command);
    assert.equal(observed.readOnly, false, command);
  }
});

test("a local git command with a benign environment prefix stays local", () => {
  const observed = observeShellCommand(
    clone("owned-fork"),
    "FOO=bar git status",
  );
  assert.equal(observed.kind, "local");
});

test("a git alias that stands for a push is unsupported, and a harmless alias stays local", () => {
  const path = clone("defaults-clone");
  git(path, ["config", "alias.st", "status"]);
  try {
    assert.equal(observeShellCommand(path, "git st").kind, "local");
    git(path, ["config", "alias.p", "push"]);
    assert.equal(
      observeShellCommand(path, "git p origin main").kind,
      "unsupported",
    );
    assert.equal(
      observeShellCommand(path, "echo hi && git p origin main").kind,
      "unsupported",
    );
    git(path, ["config", "alias.sh", "!git push origin main"]);
    assert.equal(observeShellCommand(path, "git sh").kind, "unsupported");
  } finally {
    for (const name of ["alias.st", "alias.p", "alias.sh"])
      git(path, ["config", "--unset", name]);
  }
});

// ---------------------------------------------------------------------------------------
// the resolver boundary
// ---------------------------------------------------------------------------------------

test("toResolverIntent carries only the fields the resolver validates", () => {
  const observed = observeShellCommand(
    clone("owned-fork"),
    "git push origin feat/x",
  );
  assert.deepEqual(toResolverIntent(observed), {
    operation: "push",
    capability: "pushBranch",
    readOnly: false,
    resolved: true,
    refs: [{ kind: "branch", name: "feat/x", isDefault: false }],
    force: false,
    delete: false,
  });
});

test("toResolverIntent omits absent branch-only identities and preserves partial identities", () => {
  const branchOnly = observeShellCommand(
    clone("owned-fork"),
    "gh pr create -R simpsonm09/simpsonm09 --base main --head feat/x",
  );
  assert.deepEqual(toResolverIntent(branchOnly).base, { branch: "main" });
  assert.deepEqual(toResolverIntent(branchOnly).head, { branch: "feat/x" });

  const ownerOnly = observeShellCommand(
    clone("owned-fork"),
    "gh pr create -R simpsonm09/simpsonm09 --base michael-denyer:main --head feat/x",
  );
  assert.deepEqual(toResolverIntent(ownerOnly).base, {
    owner: "michael-denyer",
    repo: null,
    branch: "main",
  });

  const crossRepository = observeShellCommand(
    clone("owned-fork"),
    "gh pr create -R simpsonm09/simpsonm09 --base acme/other:main --head feat/x",
  );
  assert.deepEqual(toResolverIntent(crossRepository).base, {
    owner: "acme",
    repo: "other",
    branch: "main",
  });
});

test("the injected git port is the only source of git state", () => {
  const calls: string[][] = [];
  const observed = observeCommand("git push origin feat/x", {
    cwd: "/nowhere",
    git: (args) => {
      calls.push(args);
      if (args[0] === "remote" && args[1] === "get-url") return THIRD_PARTY;
      if (args[0] === "remote") return "origin";
      return null;
    },
  });
  assert.deepEqual(observationDestination(observed), {
    host: "github.com",
    destination: "michael-denyer/pstack-claude",
  });
  assert.ok(calls.length > 0);
});

// The owned-fork clone's git state as a read-only port, so the tokenizer regressions below do
// not need a real repository: origin is the owned fork, its remote HEAD is main, and feat/x is
// a non-default branch.
/**
 * @param {string[]} args
 * @returns {string | null}
 */
function ownedForkPort(args: string[]): string | null {
  const key = args.join(" ");
  if (key === "remote") return "origin";
  if (key === "remote get-url --push --all origin") return OWNED_FORK;
  if (key === "remote get-url origin") return OWNED_FORK;
  if (key === "symbolic-ref --quiet refs/remotes/origin/HEAD")
    return "refs/remotes/origin/main";
  if (key === "symbolic-ref --quiet --short HEAD") return "feat/x";
  if (key === "show-ref --verify refs/heads/feat/x") return "1111111";
  if (key === "show-ref --verify refs/heads/main") return "2222222";
  return null;
}

test("shell redirections are not refspecs", () => {
  for (const command of [
    "git push origin feat/x 2>&1",
    "git push origin feat/x > out.txt",
    "git push origin feat/x 2> err.txt",
    "git push origin feat/x >> out.txt",
    "git push origin feat/x &> out.txt",
    "git push origin feat/x &>> out.txt",
    "git push origin feat/x < in.txt",
    "git push origin feat/x 2< in.txt",
    "git push origin feat/x >out.txt",
    "git push origin feat/x 2>>err.txt",
    "git push origin feat/x <in.txt",
    "git push origin feat/x >&2",
    "git push origin feat/x > out.txt 2>&1",
  ]) {
    const observed = observeCommand(command, {
      cwd: "/nowhere",
      git: ownedForkPort,
    });
    assert.equal(observed.capability, "pushBranch", command);
    assert.equal(observed.resolved, true, command);
  }
});

test("a quoted redirection-looking word stays an argument", () => {
  const observed = observeCommand('git push origin feat/x "2>&1"', {
    cwd: "/nowhere",
    git: ownedForkPort,
  });
  assert.equal(observed.capability, "pushMain");
  assert.equal(observed.resolved, false);
});

test("a redirection does not change a default-branch push", () => {
  const observed = observeCommand("git push origin main 2>&1", {
    cwd: "/nowhere",
    git: ownedForkPort,
  });
  assert.equal(observed.capability, "pushMain");
  assert.equal(observed.resolved, true);
});

test("a command observed with no git port cannot resolve a governed write", () => {
  const observed = observeCommand("git push origin feat/x", {
    cwd: "/nowhere",
  });
  assert.equal(observed.resolved, false);
  assert.equal(observationDestination(observed), null);
});

const OWNED_FORKS = {
  forks: [
    {
      repository: "simpsonm09/pstack-max",
      upstream: "michael-denyer/pstack-claude",
      agentAccess: "propose",
    },
  ],
};

/**
 * @param {string} level
 * @returns {{ org: string, repos: Array<{ name: string, tier: string, agentAccess: string }> }}
 */
function rosterAt(level: string) {
  return {
    org: "simpsonm09-org",
    repos: [{ name: "demo-repo", tier: "standard", agentAccess: level }],
  };
}

// The pinned, packaged resolver (runtime/agent-access.mjs) is imported through the same
// hash-verified loader the gate uses, so this is the bytes the hosts run, not a mutable
// source clone. The public observer's observation is driven through the real
// resolveDestination/decideTarget, and the whole destination policy matrix is asserted here.
// There is no workspace fallback and no skip.
test("the packaged resolver reaches the intended verdict for the whole policy matrix", async () => {
  const { loadPinnedAccessApi } = await import("../lib/pinned-access.mjs");
  const core = await loadPinnedAccessApi();
  assert.ok(core, "the packaged resolver must load from its pin");
  assert.equal(typeof core.resolveDestination, "function");
  assert.equal(typeof core.decideTarget, "function");

  const owned = clone("owned-fork");
  const single = clone("single-clone");

  /**
   * Observe one command with the public seam, then resolve it the way the adapter does: the
   * observation names the destination and the intent, and the pinned resolver decides. A
   * governed write with no observed destination is denied before the resolver runs.
   * @param {string} cwd
   * @param {string} localRepo
   * @param {unknown} roster
   * @param {string} command
   */
  function verdictFor(
    cwd: string,
    localRepo: string,
    roster: unknown,
    command: string,
  ) {
    const observed = observeShellCommand(cwd, command);
    const destination = observationDestination(observed);
    if (destination === null && !observed.readOnly)
      return {
        allowed: false,
        capability: observed.capability,
        kind: null,
        reason:
          "the adapter denies a governed write with no observed destination",
      };
    const target = core.resolveDestination({
      roster,
      ownedForks: OWNED_FORKS,
      ignore: { ignore: [] },
      localRepo,
      host: destination?.host ?? "github.com",
      destination: destination?.destination ?? "unknown/unknown",
    });
    return {
      ...core.decideTarget(target, toResolverIntent(observed)),
      kind: target.kind,
    };
  }

  // An owned-fork destination. `localRepo` is not the roster name here, so the clone's own
  // fork does not collapse into the organization level and the owned-fork capability table
  // applies: read, pushBranch, and openPr, and nothing else.
  const ownedCases: Array<[string, boolean]> = [
    ["git push origin feat/x", true],
    ["git push origin main", false],
    ["git push origin refs/tags/v1", false],
    ["git push origin v1", false],
    ["git push origin HEAD:main", false],
    ["git push origin :main", false],
    ["git push origin :feat/x", false],
    ["git push origin --force-with-lease feat/x", false],
    ["git push origin --prune", false],
    ["git push origin --prune feat/x", false],
    ["git push origin --tags", false],
    ["git push origin --all", false],
    ["git push origin feat/x:", false],
    ["git push feat/x", false],
    ["git push does-not-exist", false],
    ["git push upstream feat/x", false],
    ["git push upstream main", false],
    ["gh pr create -R simpsonm09/pstack-max -B main -H feat/x", true],
    ["gh pr create -R simpsonm09/pstack-max", true],
    ["gh pr create -R simpsonm09/pstack-max --base michael-denyer:main", false],
    ["gh pr create -R michael-denyer/pstack-claude", false],
    ["gh pr merge 1 -R simpsonm09/pstack-max", false],
    ["gh release create v1 -R simpsonm09/pstack-max", false],
    ["gh workflow run ci.yml -R simpsonm09/pstack-max", false],
    ["gh secret set X -R simpsonm09/pstack-max", false],
    ["gh repo edit --description y -R simpsonm09/pstack-max", false],
    [
      "gh api -X POST repos/simpsonm09/pstack-max -R simpsonm09/pstack-max",
      false,
    ],
    ["gh api -fquery=mutation -R simpsonm09/pstack-max", false],
    ["gh api repos/o/r -R simpsonm09/pstack-max", true],
    ["gh pr view 1 -R simpsonm09/pstack-max", true],
    ["gh pr checks -R simpsonm09/pstack-max", true],
    ["git status", true],
    ["npm test", true],
  ];
  for (const [command, allowed] of ownedCases) {
    const verdict = verdictFor(
      owned,
      "not-the-roster-name",
      { org: "simpsonm09-org", repos: [] },
      command,
    );
    assert.equal(verdict.allowed, allowed, command);
  }
  // The origin of the owned-fork clone is the owned fork; its `upstream` remote and the
  // recorded third-party repository are the read-only upstream kind.
  const emptyRoster = { org: "simpsonm09-org", repos: [] };
  assert.equal(
    verdictFor(
      owned,
      "not-the-roster-name",
      emptyRoster,
      "git push origin feat/x",
    ).kind,
    "owned-fork",
  );
  assert.equal(
    verdictFor(
      owned,
      "not-the-roster-name",
      emptyRoster,
      "git push upstream feat/x",
    ).kind,
    "upstream",
  );
  assert.equal(
    verdictFor(
      owned,
      "not-the-roster-name",
      emptyRoster,
      "gh pr create -R michael-denyer/pstack-claude",
    ).kind,
    "upstream",
  );

  // A gh write whose destination the observer cannot pin is denied before the resolver.
  for (const command of [
    "gh pr create",
    "gh pr merge 1",
    "git push origin --prune",
  ]) {
    // `owned` names two github destinations (origin and upstream), so a gh write with no -R is
    // ambiguous; the adapter denies it regardless of the resolver.
    const verdict = verdictFor(
      owned,
      "not-the-roster-name",
      { org: "simpsonm09-org", repos: [] },
      command,
    );
    assert.equal(verdict.allowed, false, command);
  }

  // The organization kind: the roster level decides, and `--prune` is a pushMain capability,
  // so it stays in the organization's existing pushMain bucket rather than inheriting the
  // branch push's pushBranch; the published resolver allows it only for a default branch or tag.
  const orgCases: Array<[string, string, boolean]> = [
    ["git push origin feat/x", "propose", true],
    ["git push origin main", "propose", false],
    ["git push origin main", "full", true],
    ["git push origin --prune feat/x", "propose", false],
    // `full` grants pushMain, while the published resolver limits that capability to default
    // branch and tag refs; a feature ref combined with --prune is therefore still denied.
    ["git push origin --prune feat/x", "full", false],
    [
      "gh pr create -R simpsonm09-org/demo-repo --base main --head feat/x",
      "propose",
      true,
    ],
    ["gh pr merge 1", "propose", false],
    ["gh pr merge 1", "full", true],
    ["gh api -X POST repos/simpsonm09-org/demo-repo", "propose", false],
    ["gh api -X POST repos/simpsonm09-org/demo-repo", "full", true],
    ["gh pr view 1", "read", true],
    ["git status", "read", true],
    ["npm test", "read", true],
  ];
  for (const [command, level, allowed] of orgCases) {
    const verdict = verdictFor(single, "demo-repo", rosterAt(level), command);
    assert.equal(verdict.allowed, allowed, `${command} @ ${level}`);
    if (command !== "git status" && command !== "npm test")
      assert.equal(verdict.kind, "org", `${command} @ ${level}`);
  }

  // A body flag in the attached short form is admin, not a read: admin is granted only at
  // full, so the same command is denied at propose and allowed at full. Before the fix the
  // observation was a read and every level allowed it.
  const mutation = "gh api -fquery=mutation -R simpsonm09-org/demo-repo";
  assert.equal(
    verdictFor(single, "demo-repo", rosterAt("propose"), mutation).capability,
    "admin",
  );
  assert.equal(
    verdictFor(single, "demo-repo", rosterAt("propose"), mutation).allowed,
    false,
  );
  assert.equal(
    verdictFor(single, "demo-repo", rosterAt("full"), mutation).allowed,
    true,
  );
});

test("the observation vocabulary is the documented set", () => {
  assert.deepEqual(Object.values(OBSERVATION_KINDS), [
    "local",
    "read",
    "write",
    "unsupported",
    "ambiguous",
  ]);
});

// ---------------------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------------------

test("parseGithubRepo reads the documented remote URL forms and nothing else", () => {
  assert.deepEqual(
    parseGithubRepo("https://github.com/simpsonm09/pstack-max.git"),
    {
      host: "github.com",
      owner: "simpsonm09",
      repo: "pstack-max",
    },
  );
  assert.deepEqual(
    parseGithubRepo("git@github.com:simpsonm09/pstack-max.git"),
    {
      host: "github.com",
      owner: "simpsonm09",
      repo: "pstack-max",
    },
  );
  assert.deepEqual(
    parseGithubRepo("ssh://git@github.com:22/simpsonm09/pstack-max"),
    {
      host: "github.com",
      owner: "simpsonm09",
      repo: "pstack-max",
    },
  );
  assert.deepEqual(parseGithubRepo("git://github.com/simpsonm09/pstack-max"), {
    host: "github.com",
    owner: "simpsonm09",
    repo: "pstack-max",
  });
  // Another host is carried, not accepted: the resolver refuses any host but github.com.
  assert.deepEqual(
    parseGithubRepo("https://gitlab.com/simpsonm09/pstack-max.git"),
    {
      host: "gitlab.com",
      owner: "simpsonm09",
      repo: "pstack-max",
    },
  );
  for (const value of [
    "/tmp/local-bare.git",
    "C:\\repos\\bare.git",
    "https://github.com/simpsonm09/pstack-max/tree/main",
    "simpsonm09/pstack-max",
  ]) {
    assert.equal(parseGithubRepo(value), null, value);
  }
});

test("parseRepoArgument reads the gh [HOST/]OWNER/REPO form", () => {
  assert.deepEqual(parseRepoArgument("simpsonm09/pstack-max"), {
    host: "github.com",
    owner: "simpsonm09",
    repo: "pstack-max",
  });
  assert.deepEqual(parseRepoArgument("github.com/simpsonm09/pstack-max"), {
    host: "github.com",
    owner: "simpsonm09",
    repo: "pstack-max",
  });
  assert.equal(parseRepoArgument("not-a-repo"), null);
  assert.equal(parseRepoArgument("a/b/c/d"), null);
});
