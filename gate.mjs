// The shared decision for one shell command. Both harnesses reach the same answer
// through this module: the OpenCode plugin (index.ts) calls gateShellEdit, which also
// rewrites a denied command and injects GH_TOKEN; the Claude Code hook calls decideShell
// and maps its action onto a PreToolUse answer. The rules live here and nowhere else:
// which fleet repository a directory belongs to, what the observer sees, what the pinned
// resolver decides for that destination, when Codex's conservative GitHub-write rule applies,
// and when gh gets a token.
//
// The decision moves onto the command observer (lib/intent.mjs): one recognized-form parse of
// the command, joined to read-only git state, names the destination, the refs, and any
// inherited environment conflict. There is no whole-string write scan any more — the observer
// is the single classifier, and the resolver turns its observation into a verdict. The
// adapters do the I/O (access.mjs, lib/fleet.mjs, lib/gitstate.mjs); this module only sees
// their answers and the injected git port.

import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { observeCommand } from "./lib/intent.mjs";
import { isGovernedWrite } from "./lib/observation.mjs";
import { canonicalCommand, readShellWord } from "./lib/program.mjs";

const FALLBACK_LEVEL = "read";

/**
 * @typedef {{ code: number, stdout: string, catalogMissing?: boolean }} CliResult
 * @typedef {(repo: string, observation: import("./lib/observation.mjs").Observation) => CliResult} Resolver
 * @typedef {{ git?: (cwd: string) => ((args: string[]) => string | null) | null, env?: string[] }} ObservationDeps
 * @typedef {"allow" | "deny" | "unknown"} Classification
 * @typedef {{ route: "app" | "ambient", owner: string | null, repo: string | null }} AuthRoute
 * @typedef {{ action: "pass" | "deny" | "inject", repo: string | null, level: string, reason?: string, auth?: AuthRoute }} Decision
 */

// The clone lives at <workspace>/projects/repos/<repo-name>.
/**
 * @param {string} cwd
 * @param {string} workspaceRoot
 * @returns {string | null}
 */
export function repoFromCwd(cwd, workspaceRoot) {
  if (!cwd || !workspaceRoot) return null;
  const reposRoot = resolve(workspaceRoot, "projects", "repos");
  const rel = relative(reposRoot, resolve(cwd));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  const name = rel.split(/[\\/]/)[0];
  return name.length > 0 ? name : null;
}

// A worktree lives at <workspace>/projects/worktrees/<name>. It is not named after its
// repository, so the caller resolves it through git (see repoFromCommonDir).
/**
 * @param {string} cwd
 * @param {string} workspaceRoot
 * @returns {boolean}
 */
export function isWorktreePath(cwd, workspaceRoot) {
  if (!cwd || !workspaceRoot) return false;
  const rel = relative(
    resolve(workspaceRoot, "projects", "worktrees"),
    resolve(cwd),
  );
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// A worktree's git common dir is the clone's .git directory, <workspace>/projects/repos/
// <repo>/.git. It names the repository only when the clone sits directly under repos.
/**
 * @param {string | null} commonDir
 * @param {string} workspaceRoot
 * @returns {string | null}
 */
export function repoFromCommonDir(commonDir, workspaceRoot) {
  if (!commonDir || !workspaceRoot || !isAbsolute(commonDir)) return null;
  if (basename(commonDir) !== ".git") return null;
  const reposRoot = resolve(workspaceRoot, "projects", "repos");
  const rel = relative(reposRoot, dirname(commonDir));
  if (isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]/);
  if (parts.length !== 1 || parts[0] === "" || parts[0] === "..") return null;
  return parts[0];
}

// A gh command is the only command the gate injects a token for. The test is on the first
// word after canonicalCommand, so a leading space or tab is not a gh command here, as before.
/**
 * @param {string} command
 * @returns {boolean}
 */
export function shouldInject(command) {
  return /^gh(\s|$)/.test(canonicalCommand(command));
}

// An App token is safe only when the observed gh invocation is pinned to github.com. Host
// overrides are names and parsed words only; no GH_HOST value is read.
/**
 * @param {string} command
 * @param {import("./lib/observation.mjs").Observation} observation
 * @returns {boolean}
 */
function targetsGithubCom(command, observation) {
  return (
    shouldInject(command) &&
    observation.program === "gh" &&
    observation.ghHostAssignment !== true &&
    observation.environment.length === 0 &&
    observation.ghArgumentsLiteral === true &&
    observation.ghArgumentsStrict === true &&
    observation.ghCommandKnown === true &&
    observation.ghExternalUrl !== true &&
    observation.destination?.host?.toLowerCase() === "github.com" &&
    observation.ghHostnames.every(
      (hostname) =>
        hostname.literal && hostname.value?.toLowerCase() === "github.com",
    )
  );
}

// Split a shell command on whitespace and quotes, the same light parse the resolver
// uses. Only enough to reach the command and its git push remote. A PowerShell command is
// split by the PowerShell reading of its words (lib/program.mjs), so a doubled quote and a
// backtick mean what PowerShell makes of them.
/**
 * @param {string} command
 * @param {"bash" | "powershell"} [shell]
 * @returns {string[]}
 */
export function tokenize(command, shell = "bash") {
  if (shell === "powershell") return tokenizePowerShell(command);
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

// The words of a PowerShell command. A word the reader does not take (an unquoted $, backtick,
// or parenthesis) is kept as typed, so a push with a variable in it is still seen as a push.
/**
 * @param {string} command
 * @returns {string[]}
 */
function tokenizePowerShell(command) {
  const words = [];
  let i = 0;
  while (i < command.length) {
    if (/\s/.test(command[i])) {
      i += 1;
      continue;
    }
    const read = readShellWord(command, i, "powershell");
    const end = read ? read.end : i + command.slice(i).match(/^\S+/)[0].length;
    const word = read ? read.word : command.slice(i, end);
    if (word) words.push(word);
    i = end;
  }
  return words;
}

/**
 * The reason line every denial carries, shared by both harnesses.
 * @param {string} reason
 * @returns {string}
 */
export function denyMessage(reason) {
  return `agent-access: denied: ${reason}`;
}

// Rewrite a denied command into one that reports the reason and exits non-zero. The
// promise hook cannot fail by type, so denial is a rewritten command. The OpenCode shell
// runs a real shell, so the syntax must match it: PowerShell on Windows, POSIX elsewhere.
/**
 * @param {string} reason
 * @param {string} [shell]
 * @returns {string}
 */
export function denyCommand(reason, shell = "") {
  const message = denyMessage(reason);
  if (isPowerShell(shell))
    return `Write-Error ${powerShellQuote(message)}; exit 1`;
  return `printf '%s\\n' ${shellQuote(message)} >&2; exit 1`;
}

// The OpenCode shell hook names the shell it will run. Match the PowerShell family by
// the file's base name so a full path still resolves.
/**
 * @param {string} shell
 * @returns {boolean}
 */
export function isPowerShell(shell) {
  const name = fileName(shell ?? "").toLowerCase();
  return /^(pwsh|powershell)(\.exe)?$/.test(name);
}

// The last path segment of a path written with either separator. Node's basename only
// splits on the separator of the running platform, so a Windows path on Linux (or a
// POSIX path on Windows) needs both separators handled here.
/**
 * @param {string} path
 * @returns {string}
 */
export function fileName(path) {
  return basename(path.trim().replace(/\\/g, "/"));
}

/**
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// A PowerShell single-quoted string escapes an embedded quote by doubling it.
/**
 * @param {string} value
 * @returns {string}
 */
export function powerShellQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

// Pick the interpreter for a spawned script. The OpenCode server runs the plugin inside
// its own binary, so process.execPath is the OpenCode CLI, not Node. Use process.execPath
// only when it is a real Node or Bun runtime; otherwise fall back to `node` on PATH.
/**
 * @param {string} execPath
 * @returns {string}
 */
export function nodeRunner(execPath) {
  const name = fileName(execPath ?? "").toLowerCase();
  return /^(node|node\.exe|bun|bun\.exe)$/.test(name) ? execPath : "node";
}

/**
 * @param {CliResult} result
 * @returns {Classification}
 */
export function classifyResolver(result) {
  if (result.code === 0) return "allow";
  if (result.code === 1) return "deny";
  return "unknown";
}

// The resolver prints one JSON object on stdout. Anything that does not parse is an unknown
// answer, which the caller treats conservatively. The destination kind and the auth route are
// informational inputs to the message and the token step; they never change the verdict.
/**
 * @param {string} stdout
 * @returns {{ level: string, capability: string | null, kind: string | null, source: string | null, org: string | null, destination: string | null, auth: AuthRoute | null } | null}
 */
export function parseResolverOutput(stdout) {
  if (!stdout) return null;
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed?.level !== "string") return null;
    const auth = parsed.auth;
    return {
      level: parsed.level,
      capability:
        typeof parsed.capability === "string" ? parsed.capability : null,
      kind: typeof parsed.kind === "string" ? parsed.kind : null,
      ...(typeof parsed.source === "string" ? { source: parsed.source } : {}),
      ...(typeof parsed.org === "string" ? { org: parsed.org } : {}),
      destination:
        typeof parsed.destination === "string" ? parsed.destination : null,
      auth:
        auth && (auth.route === "app" || auth.route === "ambient")
          ? {
              route: auth.route,
              owner: typeof auth.owner === "string" ? auth.owner : null,
              repo: typeof auth.repo === "string" ? auth.repo : null,
            }
          : null,
    };
  } catch {
    return null;
  }
}

// Refresh a cached installation token five minutes before it expires.
const TOKEN_SKEW_MS = 5 * 60 * 1000;

/**
 * @param {{ token: string, expires_at: string } | null} cache
 * @param {number} now
 * @returns {boolean}
 */
export function tokenUsable(cache, now) {
  if (!cache?.token || !cache.expires_at) return false;
  const expires = Date.parse(cache.expires_at);
  return Number.isFinite(expires) && expires - now > TOKEN_SKEW_MS;
}

/**
 * @param {string} repo
 * @param {string} level
 * @returns {string}
 */
export function contextLine(repo, level) {
  return `agent-access: the repository ${repo} has agent access level "${level}".`;
}

/**
 * @returns {string}
 */
export function fallbackLevel() {
  return FALLBACK_LEVEL;
}

// The observation of one command, with the git port this decision was given. The observation
// is a guardrail input: it names a destination, but the resolver decides.
/**
 * @param {string} command
 * @param {{ cwd: string, shell?: "bash" | "powershell" }} input
 * @param {ObservationDeps} deps
 * @returns {import("./lib/observation.mjs").Observation}
 */
function observeFor(command, input, deps) {
  const git = deps.git ? deps.git(input.cwd) : null;
  return observeCommand(command, {
    cwd: input.cwd,
    shell: input.shell,
    git,
    env: deps.env ?? [],
  });
}

// The reason for a governed write the observer saw with a destination-changing environment
// variable set. The variable's *name* is named; its value is never read, so a credential in
// the environment cannot appear here.
/**
 * @param {string[]} names
 * @returns {string}
 */
function environmentReason(names) {
  return `the environment variable ${names[0]} changes which repository this command reaches, so a governed write is refused`;
}

// The answer when the working directory cannot be resolved to a fleet repository (git could
// not run, for instance). It is the same rule as a command the resolver cannot answer: a
// governed write is denied, and any other command passes.
/**
 * @param {import("./lib/observation.mjs").Observation} observation
 * @returns {Decision}
 */
function unresolvedAnswer(observation) {
  if (isGovernedWrite(observation)) {
    return {
      action: "deny",
      repo: null,
      level: FALLBACK_LEVEL,
      reason:
        "the working directory could not be resolved to a fleet repository for this write",
    };
  }
  return { action: "pass", repo: null, level: FALLBACK_LEVEL };
}

// The repository a denial names. The local clone's name is the answer for a command whose
// repository the clone decides, but a gh command may name another repository with an explicit
// -R/--repo. That destination's catalog entry is the one the resolver denies, so the message
// names the destination rather than the clone the caller happened to run from. Only the name in
// the message changes: the decision and the repository a token is minted for come from the
// resolver, and are exactly what they were. A destination on another host, an unresolved -R, or
// any non-gh command keeps the clone's name.
/**
 * @param {string} repo the local clone's repository name
 * @param {ReturnType<typeof parseResolverOutput>} resolved
 * @param {import("./lib/observation.mjs").Observation} observation
 * @returns {string}
 */
function denialRepository(repo, resolved, observation) {
  if (observation?.program !== "gh") return repo;
  if (observation.destinationSource !== "explicit") return repo;
  if (observation.destination?.host !== "github.com") return repo;
  return resolved?.destination ?? repo;
}

// The message for a resolver denial. An unsupported observation reports the shape the observer
// refused, rather than the misleading "destination unknown". A gh write whose destination the
// observer could not pin to one repository says so and points at the explicit `-R` form rather
// than claiming the repository is unknown. An organization destination is denied by its roster
// level, the message the gate has always printed; any other destination is denied by the
// target's own capability table, and its reason names that destination.
/**
 * @param {ReturnType<typeof parseResolverOutput>} resolved
 * @param {string} repo
 * @param {string} level
 * @param {import("./lib/observation.mjs").Observation} observation
 * @returns {string}
 */
function denyReason(resolved, repo, level, observation) {
  if (observation?.kind === "unsupported")
    return `${observation.reason}, so the write is denied`;
  if (
    observation?.program === "gh" &&
    observation.readOnly !== true &&
    resolved?.kind === "unknown" &&
    !resolved.destination
  )
    return "the destination for this gh command is ambiguous, so specify -R owner/repo for a new operation";
  if (
    observation?.program === "gh" &&
    observation.destinationSource === "explicit" &&
    observation.destination?.host === "github.com" &&
    resolved?.kind !== "org" &&
    resolved?.destination
  )
    return `the destination ${resolved.destination} denies ${resolved.capability ?? "this command"} at level "${level}"`;
  if (!resolved || resolved.kind === "org")
    return `${denialRepository(repo, resolved, observation)} denies this command at level "${level}"`;
  const capability = resolved.capability ?? "this command";
  return `the destination ${resolved.destination ?? "unknown"} denies ${capability} for this repository`;
}

// The owner decision allows only this literal personal-fork sync shape when its roster level
// grants an ordinary branch push. The server selects the parent; no local ref is trusted.
/**
 * @param {import("./lib/observation.mjs").Observation} observation
 * @param {ReturnType<typeof parseResolverOutput>} resolved
 * @returns {boolean}
 */
function allowsPersonalForkSync(observation, resolved) {
  if (!isPersonalForkSyncShape(observation, resolved)) return false;

  return (
    resolved?.kind === "org" &&
    resolved.source === "personal-fork" &&
    resolved.destination?.toLowerCase() ===
      `${observation.destination.owner}/${observation.destination.repo}`.toLowerCase() &&
    ["propose", "merge", "full"].includes(resolved.level)
  );
}

// The syntax accepted by the personal-fork sync exception. Kept separate from the resolver
// classification so the same narrowly recognized request can explain a missing clone context
// without changing its denial.
/**
 * @param {import("./lib/observation.mjs").Observation} observation
 * @param {ReturnType<typeof parseResolverOutput>} resolved
 * @returns {boolean}
 */
function isPersonalForkSyncShape(observation, resolved, requireSource = false) {
  const sync = observation.ghRepoSync;
  if (
    observation.program !== "gh" ||
    observation.operation !== "admin" ||
    observation.capability !== "admin" ||
    observation.ghArgumentsLiteral !== true ||
    observation.ghArgumentsStrict !== true ||
    !sync ||
    sync.positionals.length !== 1 ||
    !observation.destination ||
    observation.destinationSource !== "explicit" ||
    observation.destination.host.toLowerCase() !== "github.com" ||
    sync.positionals[0].toLowerCase() !==
      `${observation.destination.owner}/${observation.destination.repo}`.toLowerCase()
  )
    return false;

  const options = sync.options;
  const permitted = new Set(["-b", "--branch", "--source", "-h", "--help"]);
  if (options.some((option) => !permitted.has(option.name))) return false;
  const branches = options.filter(
    (option) => option.name === "-b" || option.name === "--branch",
  );
  if (branches.length > 1 || branches.some((option) => option.value !== "main"))
    return false;
  const sources = options.filter((option) => option.name === "--source");
  if (
    sources.length > 1 ||
    (requireSource && sources.length !== 1) ||
    (sources.length === 1 &&
      (!resolved?.org ||
        sources[0].value?.toLowerCase() !==
          `${resolved.org}/${observation.destination.repo}`.toLowerCase()))
  )
    return false;

  return Boolean(
    resolved?.org &&
      observation.destination.owner.toLowerCase() !==
        resolved.org.toLowerCase(),
  );
}

/**
 * @param {import("./lib/observation.mjs").Observation} observation
 * @param {ReturnType<typeof parseResolverOutput>} resolved
 * @returns {boolean}
 */
function hasUnresolvedPersonalForkSyncContext(observation, resolved, deps) {
  if (
    !(
      isPersonalForkSyncShape(observation, resolved, true) &&
      resolved?.kind === "unknown" &&
      resolved.source === "unknown" &&
      resolved.level === "none" &&
      resolved.destination?.toLowerCase() ===
        `${observation.destination.owner}/${observation.destination.repo}`.toLowerCase()
    )
  )
    return false;

  const org = resolved.org;
  if (!org) return false;
  const orgDestination = `${org}/${observation.destination.repo}`;
  const orgObservation = {
    ...observation,
    destination: {
      ...observation.destination,
      owner: org,
    },
    ghRepoSync: {
      ...observation.ghRepoSync,
      positionals: [orgDestination],
    },
  };
  const orgTarget = parseResolverOutput(
    deps.resolve("", orgObservation).stdout,
  );

  return (
    orgTarget?.kind === "org" &&
    orgTarget.source === "org" &&
    orgTarget.destination?.toLowerCase() === orgDestination.toLowerCase() &&
    ["propose", "merge", "full"].includes(orgTarget.level)
  );
}

function unresolvedPersonalForkSyncReason(observation) {
  return `the destination ${observation.destination.owner}/${observation.destination.repo} is denied because its personal-fork identity cannot be determined without local repository context for the ${observation.destination.repo} clone. This denial is final and the blocked command cannot be automatically retried`;
}

// The decision for one command, with no side effects: no token, no environment, no
// rewrite. The repository comes from deps.lookup(), which never throws: it answers
// { repo } for a fleet directory, { repo: null } for any other directory, and
// { repo: null, unresolved: true } when the lookup could not run. The directory it is
// asked for is the one the command itself reaches: a `git -C <path>` command observes the
// `<path>` clone's git state, so its local repository is looked up there too; every other
// command is looked up from the cwd as before. Without a lookup, the repos-only path rule
// answers. Outside a fleet repository, an explicitly pinned GitHub gh destination is still
// resolved without a local clone; other commands keep the fleet-only scope.
/**
 * @param {{ command: string, shell?: "bash" | "powershell", runtime?: "codex" }} input the dialect defaults to bash
 * @param {{
 *   cwd: string,
 *   workspaceRoot?: string,
 *   lookup?: (cwd: string) => { repo: string | null, unresolved?: boolean },
 *   resolve: Resolver,
 *   git?: (cwd: string) => ((args: string[]) => string | null) | null,
 *   env?: string[],
 * }} deps
 * @returns {Decision}
 */
export function decideShell(input, deps) {
  const command = canonicalCommand(programCommand(input.command, input.shell));
  const shell = input.shell === "powershell" ? "powershell" : "bash";
  const observation = observeFor(command, { cwd: deps.cwd, shell }, deps);
  // The local repository is the clone the command reaches, not always the tool's cwd: a
  // `git -C <path>` push reaches the `<path>` clone, whose git state the observation already
  // read, so the destination's fork must be classified against that clone's fleet name.
  // With no `-C` this is the cwd, and the decision is the one the gate always made.
  const directory = observation.commandDirectory ?? deps.cwd;
  const found = deps.lookup
    ? deps.lookup(directory)
    : { repo: repoFromCwd(directory, deps.workspaceRoot ?? "") };
  const governed = isGovernedWrite(observation);
  const environment = observation.environment ?? [];
  const codex = input.runtime === "codex";

  if (found.unresolved)
    return unresolvedDecision(observation, governed, environment, codex);
  const repo = found.repo;
  if (
    !repo &&
    !observation.commandDirectory &&
    isOutsideFleetGhWrite(observation, governed)
  ) {
    if (
      observation.program === "gh" &&
      observation.destinationSource === "explicit" &&
      observation.resolved &&
      observation.destination?.host.toLowerCase() === "github.com"
    )
      return outsideFleetDestinationDecision(
        command,
        observation,
        environment,
        codex,
        deps,
      );
    return outsideFleetUnpinnedWriteDecision(observation, environment, codex);
  }
  if (!repo)
    return unknownRepoDecision(
      observation,
      observation.commandDirectory,
      governed,
      environment,
      codex,
    );

  // An inherited variable that changes which repository the command reaches makes the
  // observation untrustworthy for a governed write: refuse it rather than observe the wrong
  // repository. Local and read commands are untouched.
  if (governed && environment.length > 0)
    return denyEnvironment(repo, environment);
  return resolveDecision(command, repo, observation, governed, codex, deps);
}

function isOutsideFleetGhWrite(observation, governed) {
  return (
    (observation.program === "gh" && governed) ||
    observation.ghWriteSignal === true
  );
}

function outsideFleetUnpinnedWriteDecision(observation, environment, codex) {
  if (codex) return codexWriteDenial();
  if (environment.length > 0) return denyEnvironment(null, environment);
  return {
    action: "deny",
    repo: null,
    level: FALLBACK_LEVEL,
    reason: `${observation.reason || "this gh write"}; outside the fleet, run the write from the fleet clone or pin -R OWNER/REPO to a GitHub repository`,
  };
}

// An explicit destination can be governed without treating the caller's folder as a clone.
// Empty localRepo disables the resolver's clone-relative personal-fork rule. Allowed writes
// use ambient authentication outside the fleet, so this path never injects a token.
/**
 * @param {string} command
 * @param {import("./lib/observation.mjs").Observation} observation
 * @param {string[]} environment
 * @param {boolean} codex
 * @param {{ resolve: Resolver }} deps
 * @returns {Decision}
 */
function outsideFleetDestinationDecision(
  command,
  observation,
  environment,
  codex,
  deps,
) {
  if (codex) return codexWriteDenial();
  if (environment.length > 0) return denyEnvironment(null, environment);
  const decision = resolveDecision(command, "", observation, true, false, deps);
  if (decision.action === "inject")
    return { action: "pass", repo: null, level: decision.level };
  return { ...decision, repo: null };
}

// The answer when the working directory could not be resolved: a governed write is refused
// (naming the environment variable first, then Codex's rule), and any other command passes.
/**
 * @param {import("./lib/observation.mjs").Observation} observation
 * @param {boolean} governed
 * @param {string[]} environment
 * @param {boolean} codex
 * @returns {Decision}
 */
function unresolvedDecision(observation, governed, environment, codex) {
  if (governed && environment.length > 0)
    return denyEnvironment(null, environment);
  if (codex && governed) return codexWriteDenial();
  return unresolvedAnswer(observation);
}

// The answer when the directory is not a fleet repository at all. Ordinary commands remain
// outside the fleet-only scope unless they name a directory with `-C`; Codex still blocks
// every governed write. A `git -C` clone the fleet cannot name fails closed, and an unsupported
// shape without a parsed command directory also fails closed.
/**
 * @param {import("./lib/observation.mjs").Observation} observation
 * @param {string | null} commandDirectory the directory the command names with `-C`, or null
 * @param {boolean} governed
 * @param {string[]} environment
 * @param {boolean} codex
 * @returns {Decision}
 */
function unknownRepoDecision(
  observation,
  commandDirectory,
  governed,
  environment,
  codex,
) {
  if (codex && governed) return codexWriteDenial();
  if (observation.kind === "unsupported" && !commandDirectory)
    return {
      action: "deny",
      repo: null,
      level: FALLBACK_LEVEL,
      reason: `${observation.reason}; unsupported command is denied`,
    };
  if (!commandDirectory || !governed)
    return { action: "pass", repo: null, level: FALLBACK_LEVEL };
  if (environment.length > 0) return denyEnvironment(null, environment);
  return {
    action: "deny",
    repo: null,
    level: FALLBACK_LEVEL,
    reason:
      "the directory this command names with git -C could not be resolved to a fleet repository, so the write is denied",
  };
}

// The denial for a governed write observed under a destination-changing environment variable.
/**
 * @param {string | null} repo
 * @param {string[]} environment
 * @returns {Decision}
 */
function denyEnvironment(repo, environment) {
  return {
    action: "deny",
    repo,
    level: FALLBACK_LEVEL,
    reason: environmentReason(environment),
  };
}

// The decision for a command in a resolved fleet repository: ask the resolver, then map its
// answer. Codex denies a governed write whatever the resolver said.
/**
 * @param {string} command
 * @param {string} repo
 * @param {import("./lib/observation.mjs").Observation} observation
 * @param {boolean} governed
 * @param {boolean} codex
 * @param {{ resolve: Resolver }} deps
 * @returns {Decision}
 */
function resolveDecision(command, repo, observation, governed, codex, deps) {
  const result = deps.resolve(repo, observation);
  const classification = classifyResolver(result);
  const resolved = parseResolverOutput(result.stdout);
  const level = resolved?.level ?? FALLBACK_LEVEL;

  // Codex does not report which folder a command runs in, so every governed GitHub write from
  // Codex is denied regardless of the destination.
  if (codex && governed) return codexWriteDenial(repo, level);
  // Any other sync shape falls through and is decided as the pushMain write it is.
  if (allowsPersonalForkSync(observation, resolved))
    return { action: "pass", repo, level };
  if (classification === "deny")
    return {
      action: "deny",
      repo,
      level,
      reason:
        repo === "" &&
        hasUnresolvedPersonalForkSyncContext(observation, resolved, deps)
          ? unresolvedPersonalForkSyncReason(observation)
          : denyReason(resolved, repo, level, observation),
    };
  if (classification === "unknown")
    return unresolvableWrite(repo, level, governed, result);

  // An allowed gh command is injected only when the destination is an organization
  // destination the App serves. A destination outside the organization (an owned fork, a
  // personal push fork) runs under the caller's own ambient authentication: the gate does not
  // mint or hand out a token for it.
  if (targetsGithubCom(command, observation) && resolved?.auth?.route === "app")
    return { action: "inject", repo, level, auth: resolved.auth };
  return { action: "pass", repo, level };
}

// The answer when the resolver could not answer at all. A governed write is denied, naming the
// missing catalog entry or the unavailable resolver; any other command passes.
/**
 * @param {string} repo
 * @param {string} level
 * @param {boolean} governed
 * @param {CliResult} result
 * @returns {Decision}
 */
function unresolvableWrite(repo, level, governed, result) {
  if (!governed) return { action: "pass", repo, level };
  return {
    action: "deny",
    repo,
    level,
    reason: result.catalogMissing
      ? `${repo} is not in the fleet catalog (simpsonm09-org/simpsonm09-repo-catalog, repo-catalog/repos.json); add it there before agents can write to it`
      : `the access resolver could not answer for ${repo}; check that the catalog and resolver are available before running this write`,
  };
}

function codexWriteDenial(repo = null, level = FALLBACK_LEVEL) {
  return {
    action: "deny",
    repo,
    level,
    reason:
      "Codex does not report which folder a command runs in, so GitHub writes from Codex are blocked in every repository. Push or open the pull request from Claude, OpenCode or Copilot.",
  };
}

// In PowerShell `&` is the call operator: it runs the word after it as a program, so that
// word is the program word. Drop a leading `&` before the program is read, and the
// executable-spelling handling in canonicalCommand reads the word itself (`& 'git' push` is
// decided as `git push`). Only a `&` that is a token of its own counts. Nothing else is read
// here: the observer owns the segment analysis, and a compound command with a governed write
// is an unsupported shape it denies.
/**
 * @param {string} command
 * @param {"bash" | "powershell"} [shell]
 * @returns {string}
 */
function programCommand(command, shell) {
  if (shell !== "powershell") return command;
  return command.replace(/^(\s*)&(?=\s)\s*/, "$1");
}

// The conservative lexical read of a command with no git state and no working directory. Used
// where the gate cannot reach git state — a call with no cwd, a relative cwd, or a hook that
// ran out of budget — so a governed-write shape still fails closed, while a local command, a
// quoted mention, or a known gh read passes. This is the observer without its git port, not the
// whole-string scan it replaced.
/**
 * @param {string} command
 * @param {"bash" | "powershell"} [shell]
 * @returns {boolean}
 */
export function isGovernedCommand(command, shell) {
  return isGovernedWrite(
    observeCommand(command, {
      shell: shell === "powershell" ? "powershell" : "bash",
    }),
  );
}

// The OpenCode side of the decision. It applies the decision to the command holder and
// the environment: a denial rewrites the command, and an injection mints the token for the
// destination and sets GH_TOKEN. A token that cannot be minted is a denial, as before.
/**
 * @param {{ command: string, shell?: string }} input
 * @param {Record<string, string | undefined>} env
 * @param {{
 *   cwd: string,
 *   workspaceRoot?: string,
 *   lookup?: (cwd: string) => { repo: string | null, unresolved?: boolean },
 *   resolve: Resolver,
 *   git?: (cwd: string) => ((args: string[]) => string | null) | null,
 *   env?: string[],
 *   tokenFor: (owner: string, repo: string) => Promise<string | null>,
 * }} deps
 * @returns {Promise<Decision>}
 */
export async function gateShellEdit(input, env, deps) {
  const decision = decideShell(input, deps);

  if (decision.action === "deny") {
    input.command = denyCommand(decision.reason ?? "", input.shell);
    return decision;
  }

  if (decision.action === "inject") {
    const owner = decision.auth?.owner ?? "";
    const repo = decision.auth?.repo ?? decision.repo ?? "";
    const token = await deps.tokenFor(owner, repo);
    if (!token) {
      const reason = `${repo} could not mint a token for a gh command`;
      input.command = denyCommand(reason, input.shell);
      return {
        action: "deny",
        repo: decision.repo,
        level: decision.level,
        reason,
      };
    }
    env.GH_TOKEN = token;
  }

  return decision;
}
