// The adapter between the shared decision (gate.mjs), the packaged access resolver, and the
// repo-standard GitHub App token broker. The OpenCode plugin
// (index.ts), the Claude Code hook, and the launcher all load them through this module,
// so the way a script is found, imported, spawned, and cached is written once. Every
// function here may touch the file system or spawn a process, which is why it lives apart
// from the pure gate.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fallbackLevel, nodeRunner, tokenUsable } from "./gate.mjs";
import { timeoutFor } from "./lib/budget.mjs";
import { gitReader } from "./lib/gitstate.mjs";
import {
  observationDestination,
  observeCommand,
  toResolverIntent,
} from "./lib/intent.mjs";
import { loadPinnedAccessApi } from "./lib/pinned-access.mjs";

// The organization the GitHub App is installed on. It is the owner of an organization
// destination's installation token, and nothing else: a destination outside the organization
// uses its own ambient authentication, so this constant is never threaded into a personal
// owner's mint.
export const OWNER = "simpsonm09-org";

// Every child process and every broker call is bounded, so a stuck call becomes a
// fail-closed answer rather than a hang. The hook's budget (lib/budget.mjs) bounds the
// whole run on top of these.
const MINT_TIMEOUT_MS = 20_000;

/**
 * @typedef {{ code: number, stdout: string }} CliResult
 * @typedef {{ token: string, expires_at: string }} TokenCache
 * @typedef {{
 *   loadCommittedCatalog: (dir: string) => unknown | null,
 *   loadCommittedOwnedForks: (dir: string) => unknown | null,
 *   loadCommittedOwnedRepositories: (dir: string) => unknown | null,
 *   loadCommittedIgnore: (dir: string) => unknown | null,
 *   resolveLevel: (catalog: unknown, repoName: string) => { level?: unknown },
 *   resolveDestination: (input: Record<string, unknown>) => Record<string, unknown>,
 *   decideTarget: (target: unknown, intent: unknown) => { capability: string | null, allowed: boolean },
 * }} AccessApi
 * @typedef {{ mintForRepo: (owner: string, repo: string) => Promise<{ token: string, expires_at: string }> }} TokenApi
 */

// The resolver ships with this package. The broker and catalog use trusted workspace clones.
/**
 * @param {string} workspaceRoot
 * @returns {{ access: string, token: string, catalog: string }}
 */
export function defaultScripts(workspaceRoot) {
  const repoStandard = join(
    workspaceRoot,
    "projects",
    "repos",
    "simpsonm09-repo-standard",
  );
  return {
    access: join(
      dirname(fileURLToPath(import.meta.url)),
      "runtime",
      "agent-access.mjs",
    ),
    token: join(repoStandard, "scripts", "agent-token.mjs"),
    catalog: join(
      workspaceRoot,
      "projects",
      "repos",
      "simpsonm09-repo-catalog",
    ),
  };
}

// Import a script and return its namespace, or null when it is missing or does not load.
/**
 * @param {string} script
 * @returns {Promise<any | null>}
 */
async function importModule(script) {
  if (!existsSync(script)) return null;
  try {
    return await import(pathToFileURL(script).href);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {value is AccessApi}
 */
function isAccessApi(value) {
  const api = /** @type {Partial<AccessApi> | null} */ (value);
  return (
    typeof api?.loadCommittedCatalog === "function" &&
    typeof api?.loadCommittedOwnedForks === "function" &&
    typeof api?.loadCommittedOwnedRepositories === "function" &&
    typeof api?.loadCommittedIgnore === "function" &&
    typeof api?.resolveLevel === "function" &&
    typeof api?.resolveDestination === "function" &&
    typeof api?.decideTarget === "function"
  );
}

/**
 * @param {string} script
 * @returns {Promise<AccessApi | null>}
 */
export async function loadAccessApi(script) {
  const expected = join(
    dirname(fileURLToPath(import.meta.url)),
    "runtime",
    "agent-access.mjs",
  );
  if (script !== expected) return null;
  const access = await loadPinnedAccessApi(script);
  return isAccessApi(access) ? access : null;
}

/**
 * @param {string} script
 * @returns {Promise<TokenApi | null>}
 */
export async function loadTokenApi(script) {
  const broker = await importModule(script);
  return broker && typeof broker.mintForRepo === "function" ? broker : null;
}

// The destination and the auth route for one observation, from the committed catalog. The
// target is built only by the validated loader and the resolver's own `resolveDestination`, so
// nothing in a command's text can name a destination the loader did not classify.
/**
 * @param {AccessApi} api
 * @param {unknown} roster
 * @param {unknown} ownedForks
 * @param {unknown} ownedRepositories
 * @param {string} repo
 * @param {import("./lib/observation.mjs").Observation} observation
 * @returns {Record<string, unknown>}
 */
function targetFor(
  api,
  roster,
  ownedForks,
  ownedRepositories,
  ignore,
  repo,
  observation,
) {
  const observed = observationDestination(observation);
  return api.resolveDestination({
    roster,
    ownedForks,
    ownedRepositories,
    ignore,
    localRepo: repo,
    host: observed?.host ?? "",
    destination: observed?.destination ?? "",
  });
}

// The auth route for one target. An organization destination uses the organization App
// installation; every other destination (an owned fork, a personal push fork, an upstream, an
// unknown host) runs under the caller's own ambient authentication, and this gate never mints
// or queries a credential for it. A read the observer could not pin to one destination keeps a
// roster repository's organization token, which is the read behavior the gate already had; it
// grants no write and mints nothing for a repository outside the roster.
/**
 * @param {unknown} roster
 * @param {Record<string, any>} target
 * @param {import("./lib/observation.mjs").Observation} observation
 * @param {string} repo
 * @returns {{ route: "app" | "ambient", owner: string | null, repo: string | null }}
 */
function authRoute(roster, target, observation, repo, localInRoster) {
  const org =
    typeof (/** @type {any} */ (roster)?.org) === "string"
      ? roster.org.toLowerCase()
      : null;
  if (
    target.kind === "org" &&
    target.source !== "personal-fork" &&
    org !== null &&
    typeof target.owner === "string" &&
    target.owner.toLowerCase() === org
  )
    return { route: "app", owner: target.owner, repo: target.repo };
  if (
    observation.readOnly === true &&
    typeof target.owner !== "string" &&
    org !== null &&
    localInRoster
  )
    return { route: "app", owner: org, repo };
  return { route: "ambient", owner: null, repo: null };
}

// Decide one observation with the resolver's destination policy. The roster and the owned-fork
// policy are read from committed refs; a null roster is unknown (exit 2), which the decision
// treats conservatively. The level reported (and the denial reason built from it) is the
// destination's own policy level, because the verdict is the destination's; the local clone's
// roster level stays available beside it as the context level.
/**
 * @param {AccessApi} api
 * @param {string} catalogDir
 * @param {string} repo
 * @param {import("./lib/observation.mjs").Observation} observation
 * @returns {CliResult}
 */
function accessFromApi(api, catalogDir, repo, observation) {
  const roster = api.loadCommittedCatalog(catalogDir);
  if (roster === null) return { code: 2, stdout: "", catalogMissing: true };
  const resolved = api.resolveLevel(roster, repo);
  const contextLevel =
    typeof resolved.level === "string" ? resolved.level : fallbackLevel();
  const ownedForks = api.loadCommittedOwnedForks(catalogDir);
  const ownedRepositories = api.loadCommittedOwnedRepositories(catalogDir);
  const ignore = api.loadCommittedIgnore(catalogDir);
  if (ignore === null) {
    return { code: 2, stdout: "", catalogMissing: false };
  }
  const target = targetFor(
    api,
    roster,
    ownedForks,
    ownedRepositories,
    ignore,
    repo,
    observation,
  );
  let outcome;
  try {
    outcome = api.decideTarget(target, toResolverIntent(observation));
  } catch {
    return {
      code: 2,
      stdout: "",
      catalogMissing:
        /** @type {{ source?: string }} */ (resolved).source === "unknown",
    };
  }
  const auth = authRoute(
    roster,
    target,
    observation,
    repo,
    /** @type {{ source?: string }} */ (resolved).source !== "unknown",
  );
  const destination =
    typeof target.owner === "string" && typeof target.repo === "string"
      ? `${target.owner}/${target.repo}`
      : null;
  // A destination the resolver classified carries its own level; an unresolved destination
  // carries no level, so the local clone's context level is the only one to report.
  const level =
    destination !== null && typeof target.level === "string"
      ? target.level
      : contextLevel;
  return {
    code: outcome.allowed ? 0 : 1,
    stdout: JSON.stringify({
      level,
      contextLevel,
      capability: outcome.capability ?? null,
      allowed: outcome.allowed,
      kind: target.kind ?? "unknown",
      source: target.source ?? null,
      org: typeof roster.org === "string" ? roster.org : null,
      destination,
      auth,
    }),
  };
}

// Resolve access for one observation. A missing or invalid packaged module is unknown (exit 2).
/**
 * @param {AccessApi | null} api
 * @param {string} catalogDir
 * @param {string} repo
 * @param {import("./lib/observation.mjs").Observation} observation
 * @returns {CliResult}
 */
export function resolveAccess(api, catalogDir, repo, observation) {
  if (api) {
    try {
      return accessFromApi(api, catalogDir, repo, observation);
    } catch {
      return { code: 2, stdout: "", catalogMissing: false };
    }
  }
  return { code: 2, stdout: "" };
}

// The resolved level for the context line. The command decision is the authority; the
// level is informational.
/**
 * @param {AccessApi | null} api
 * @param {string} repo
 * @param {string} catalogDir
 * @returns {string}
 */
export function levelFor(api, repo, catalogDir) {
  if (!api) return fallbackLevel();
  try {
    const catalog = api.loadCommittedCatalog(catalogDir);
    if (catalog === null) return fallbackLevel();
    const resolved = api.resolveLevel(catalog, repo);
    return typeof resolved.level === "string"
      ? resolved.level
      : fallbackLevel();
  } catch {
    return fallbackLevel();
  }
}

// The token cache, one entry per destination (owner/repository). A token minted for one
// repository is never handed to another; that was the single-slot cache's defect.
/** @type {Map<string, TokenCache>} */
const tokenCache = new Map();

// Mint an installation token for one organization repository and cache it until it nears
// expiry. The token is never logged and never written to disk. A broker that does not answer
// in time is a failed mint. This is the organization-App route only: the caller chooses it from
// the classified destination, never from credential availability.
/**
 * @param {TokenApi | null} api
 * @param {string} script
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<string | null>}
 */
export async function tokenFor(api, script, owner, repo) {
  const key = `${owner}/${repo}`.toLowerCase();
  const cached = tokenCache.get(key) ?? null;
  if (tokenUsable(cached, Date.now())) return cached?.token ?? null;
  const minted = await withTimeout(
    api ? mintInProcess(api, owner, repo) : mintFromCli(script, owner, repo),
    timeoutFor(MINT_TIMEOUT_MS),
  );
  if (!minted) return null;
  tokenCache.set(key, minted);
  return minted.token;
}

// Resolve to null when the work does not finish in time, or fails.
/**
 * @template T
 * @param {Promise<T | null>} work
 * @param {number} ms
 * @returns {Promise<T | null>}
 */
function withTimeout(work, ms) {
  let timer;
  const deadline = new Promise((resolveDeadline) => {
    timer = setTimeout(() => resolveDeadline(null), ms);
  });
  return Promise.race([work.catch(() => null), deadline]).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * @param {TokenApi} api
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<TokenCache | null>}
 */
async function mintInProcess(api, owner, repo) {
  try {
    const minted = await api.mintForRepo(owner, repo);
    if (!minted?.token || !minted.expires_at) return null;
    return { token: minted.token, expires_at: minted.expires_at };
  } catch {
    return null;
  }
}

// A broker that only ships a CLI is spawned with a Node runtime. The CLI prints one JSON
// object on stdout.
/**
 * @param {string} script
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<TokenCache | null>}
 */
async function mintFromCli(script, owner, repo) {
  if (!existsSync(script)) return null;
  try {
    const stdout = execFileSync(
      nodeRunner(process.execPath),
      [script, `${owner}/${repo}`, "--json"],
      {
        windowsHide: true,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: timeoutFor(MINT_TIMEOUT_MS),
      },
    );
    const parsed = /** @type {Partial<TokenCache>} */ (
      JSON.parse(stdout ?? "")
    );
    if (!parsed.token || !parsed.expires_at) return null;
    return { token: parsed.token, expires_at: parsed.expires_at };
  } catch {
    return null;
  }
}

// Observe one shell command against real git state, with the git reads this adapter owns. An
// adapter passes the command, its working directory, and the destination-changing environment
// snapshot, and the observation names the destination, the refs, and any environment conflict.
// It decides nothing on its own: the gate reads it and asks the pinned resolver.
/**
 * @param {string | null} cwd the tool's working directory, already resolved by the caller
 * @param {string} command the shell text of the command
 * @param {{ shell?: "bash" | "powershell", git?: ((args: string[]) => string | null) | null, env?: string[] }} [options]
 * @returns {import("./lib/observation.mjs").Observation}
 */
export function observeShellCommand(cwd, command, options = {}) {
  const directory = typeof cwd === "string" && cwd.length > 0 ? cwd : null;
  const git = options.git ?? (directory === null ? null : gitReader(directory));
  return observeCommand(command, {
    cwd: directory,
    shell: options.shell,
    git,
    env: options.env,
  });
}

export { gitReader, observationDestination, observeCommand, toResolverIntent };
