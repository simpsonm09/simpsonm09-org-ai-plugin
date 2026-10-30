#!/usr/bin/env node
// Resolve the agent access level for a fleet repository, and the capabilities
// that level grants. The policy lives in repo-catalog/repos.json. This is the
// one reader every enforcement point shares, so a level means the same thing to
// the pre-push hook, the OpenCode gate, and the credential broker.
//
// Usage:
//   node scripts/agent-access.mjs <repo-name> [--catalog <path>] [--json]
//   node scripts/agent-access.mjs <repo-name> --allows <capability> [--catalog <path>]
//   node scripts/agent-access.mjs <repo-name> --command "<shell command>" [--remote-url <url>] [--catalog <path>]
//   node scripts/agent-access.mjs <repo-name> --host <host> --destination <owner/repo> --intent <json> [--catalog-dir <path>] [--json]
//
// The level mode prints the level and exits 0. The allows mode exits 0 when the
// repository's level grants the capability, and 1 when it does not. The command
// mode classifies a shell command to the capability it needs, then exits 0 when
// the level grants it and 1 when it does not. The optional remote URL scopes a
// git push: a push to a remote that is not the organization is out of scope and
// allowed, matching the pre-push hook. A missing catalog exits 2, so a caller
// fails closed on remote writes.
//
// The destination mode answers the sharper question: may this destination be
// written this way? It reads the roster and the owned-fork policy from committed
// catalog refs, and it takes the intent as a validated object rather than
// parsing it out of a command string.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_DIR = join(ROOT, '..', 'simpsonm09-repo-catalog');
const DEFAULT_CATALOG = join(CATALOG_DIR, 'repos.json');

export const LEVELS = ['propose', 'merge', 'full'];

// A level grants a set of capabilities. Enforcement points ask for a
// capability, never for a level, so this table is the single mapping from the
// policy in policy.md to a decision.
export const CAPABILITIES = {
  none: [],
  read: ['read'],
  propose: ['read', 'pushBranch', 'openPr'],
  merge: ['read', 'pushBranch', 'openPr', 'mergePr'],
  full: ['read', 'pushBranch', 'openPr', 'mergePr', 'pushMain', 'admin'],
};

// The level an unknown repository or an unreadable catalog resolves to. It
// allows reading and local work, and denies every remote write.
export const FALLBACK_LEVEL = 'read';

export function loadCatalog(path = DEFAULT_CATALOG) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Read the committed catalog from the clone, preferring the organization ref the
// agent cannot push to. This keeps the level out of the working tree, so an
// uncommitted edit cannot raise it.
export function loadCommittedCatalog(dir = CATALOG_DIR) {
  for (const ref of ['upstream/main', 'main']) {
    try {
      const out = execFileSync('git', ['-C', dir, 'show', `${ref}:repos.json`], {
        windowsHide: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return JSON.parse(out);
    } catch {
      // Try the next ref, then give up.
    }
  }
  return null;
}

export function resolveLevel(catalog, repoName) {
  const entry = (catalog.repos ?? []).find((repo) => repo.name === repoName);
  if (!entry) return { repo: repoName, tier: null, level: FALLBACK_LEVEL, source: 'unknown' };
  if (Object.hasOwn(entry, 'agentAccess')) {
    const valid = LEVELS.includes(entry.agentAccess);
    return { repo: repoName, tier: entry.tier, level: valid ? entry.agentAccess : FALLBACK_LEVEL, source: valid ? 'override' : 'invalid-override' };
  }
  const configured = catalog.agentAccessDefaults?.[entry.tier];
  const valid = LEVELS.includes(configured);
  return { repo: repoName, tier: entry.tier, level: valid ? configured : FALLBACK_LEVEL, source: valid ? 'tier' : 'tier-fallback' };
}

export function allows(level, capability) {
  return Object.hasOwn(CAPABILITIES, level) && CAPABILITIES[level].includes(capability);
}

// The destination policy. A level answers "how much may this clone do"; a
// destination answers "which repository is being written". The roster governs
// the organization repositories and their personal push forks from one level, so
// the same repository cannot be allowed in one enforcement point and denied in
// another. The owned-fork policy names the personally owned targets that the
// organization roster does not cover.

// The only host this policy knows. Any other host resolves to unknown.
const GITHUB_HOST = 'github.com';

// The identity patterns the catalog validator applies, mirrored so this reader
// validates the policy data instead of trusting its shape. A narrower reading is
// the safe direction: a rejected file cannot become a grant.
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

// The one personal account the catalog validator allows to own a recorded fork.
// The validator rejects any other owner, so a policy that names one is not a
// policy this reader may trust. Keeping the constant here, in the single
// validation below, is what makes the committed loader and a direct pure call
// agree instead of each carrying its own idea of the owner.
const OWNED_OWNER = 'simpsonm09';

export const DESTINATION_KINDS = ['ignored', 'org', 'owned-fork', 'owned-repository', 'upstream', 'unknown'];

// What each target kind may do. `null` means the level's capability table
// decides, which is the organization case. An owned fork gets a strict subset of
// `propose`: a non-default branch push and a pull request inside the same
// repository, never a merge, a tag, a deletion, or an administrative verb.
// Upstreams and unknown destinations grant reads only; ignored destinations
// grant nothing, including reads.
export const CAPABILITIES_BY_KIND = {
  org: null,
  ignored: [],
  'owned-fork': ['read', 'pushBranch', 'openPr'],
  'owned-repository': ['read', 'pushBranch', 'openPr'],
  upstream: ['read'],
  unknown: ['read'],
};

// Read the owned-fork policy from the committed catalog. It comes from
// `upstream/main` only, the organization ref the agent cannot push. A local
// `main` ref is writable by the same user, so it is never a grant source, and a
// missing, malformed, or unsupported file closes the owned-fork and upstream
// kinds instead of falling back to the working tree.
export function loadCommittedOwnedForks(dir = CATALOG_DIR) {
  let out;
  try {
    out = execFileSync('git', ['-C', dir, 'show', 'upstream/main:owned-forks.json'], {
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  let policy;
  try {
    policy = JSON.parse(out);
  } catch {
    return null;
  }
  return trustedOwnedForks(policy);
}

// This policy covers exact owned repositories with no upstream provenance.
// It is an independent grant and reads only from the trusted organization ref.
export function loadCommittedOwnedRepositories(dir = CATALOG_DIR) {
  let out;
  try {
    out = execFileSync('git', ['-C', dir, 'show', 'upstream/main:owned-repositories.json'], {
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  let policy;
  try {
    policy = JSON.parse(out);
  } catch {
    return null;
  }
  return trustedOwnedRepositories(policy, loadCommittedOwnedForks(dir));
}

// Read explicit destination denies from the organization-owned catalog ref only.
export function loadCommittedIgnore(dir = CATALOG_DIR) {
  let out;
  try {
    out = execFileSync('git', ['-C', dir, 'show', 'upstream/main:ignore.json'], {
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  try {
    return trustedIgnore(JSON.parse(out));
  } catch {
    return null;
  }
}

function ignoreErrors(policy) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) return ['not an object'];
  const errors = [];
  if (!Object.keys(policy).every((key) => key === 'ignore')) errors.push('an unknown top-level field');
  if (!Array.isArray(policy.ignore)) return [...errors, 'ignore is not an array'];
  const names = new Set();
  const identities = new Set();
  for (const [index, entry] of policy.ignore.entries()) errors.push(...ignoreEntryErrors(entry, index, names, identities));
  return errors;
}

function ignoreEntryErrors(entry, index, names, identities) {
  const label = `ignore[${index}]`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [`${label} is not an object`];
  const errors = [];
  if (!Object.keys(entry).every((key) => ['name', 'reason', 'agentAccessIgnore'].includes(key))) errors.push(`${label} has an unknown field`);
  if (typeof entry.name !== 'string' || !REPOSITORY_PATTERN.test(entry.name)) errors.push(`${label}.name is invalid`);
  else {
    const name = entry.name.toLowerCase();
    if (names.has(name)) errors.push(`${label}.name duplicates an earlier entry`);
    names.add(name);
  }
  if (typeof entry.reason !== 'string' || entry.reason.length === 0) errors.push(`${label}.reason is invalid`);
  return [...errors, ...ignoreIdentityErrors(entry, label, identities)];
}

function ignoreIdentityErrors(entry, label, identities) {
  if (entry.agentAccessIgnore === undefined) return [];
  if (!Array.isArray(entry.agentAccessIgnore) || entry.agentAccessIgnore.length === 0) return [`${label}.agentAccessIgnore is not a non-empty array`];
  const errors = [];
  for (const [index, identity] of entry.agentAccessIgnore.entries()) {
    const item = `${label}.agentAccessIgnore[${index}]`;
    if (!isFullyQualified(identity)) {
      errors.push(`${item} is not an owner/repository identity`);
      continue;
    }
    const normalized = identity.toLowerCase();
    if (typeof entry.name === 'string' && entry.name.toLowerCase() !== identity.split('/')[1].toLowerCase()) errors.push(`${item} does not match ${label}.name`);
    if (identities.has(normalized)) errors.push(`${item} duplicates an earlier identity`);
    identities.add(normalized);
  }
  return errors;
}

function trustedIgnore(policy) {
  return ignoreErrors(policy).length === 0 ? policy : null;
}

function isIgnored(ignore, identity) {
  return (trustedIgnore(ignore)?.ignore ?? []).some((entry) =>
    (entry.agentAccessIgnore ?? []).some((candidate) => candidate.toLowerCase() === `${identity.owner}/${identity.repo}`));
}

function ownedRepositoriesErrors(policy, ownedForks) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) return ['not an object'];
  if (!ownedForks || ownedForksErrors(ownedForks).length !== 0) return ['the owned-fork policy is unavailable for collision checks'];
  const errors = [];
  if (!Object.keys(policy).every((key) => key === 'repositories')) errors.push('an unknown top-level field');
  if (!Array.isArray(policy.repositories)) return [...errors, 'repositories is not an array'];
  const occupied = occupiedOwnedForkIdentities(ownedForks);
  const seen = new Set();
  for (const [index, entry] of policy.repositories.entries()) {
    errors.push(...ownedRepositoryEntryErrors(entry, index, occupied, seen));
  }
  return errors;
}

function occupiedOwnedForkIdentities(ownedForks) {
  const occupied = new Set();
  for (const fork of trustedOwnedForks(ownedForks)?.forks ?? []) {
    if (isFullyQualified(fork.repository)) occupied.add(fork.repository.toLowerCase());
    if (isFullyQualified(fork.upstream)) occupied.add(fork.upstream.toLowerCase());
  }
  return occupied;
}

function ownedRepositoryEntryErrors(entry, index, occupied, seen) {
  const label = `repositories[${index}]`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [`${label} is not an object`];
  const errors = [];
  if (!Object.keys(entry).every((key) => ['repository', 'agentAccess'].includes(key))) errors.push(`${label} has an unknown field`);
  if (!isFullyQualified(entry.repository)) {
    errors.push(`${label}.repository is not an owner/repository identity`);
  } else {
    const identity = entry.repository.toLowerCase();
    if (entry.repository.split('/')[0].toLowerCase() !== OWNED_OWNER) errors.push(`${label}.repository is not owned by ${OWNED_OWNER}`);
    if (seen.has(identity)) errors.push(`${label}.repository duplicates an earlier entry`);
    if (occupied.has(identity)) errors.push(`${label}.repository collides with an owned-fork target or upstream`);
    seen.add(identity);
  }
  if (entry.agentAccess !== 'propose') errors.push(`${label}.agentAccess is not propose`);
  return errors;
}

function trustedOwnedRepositories(policy, ownedForks) {
  return ownedRepositoriesErrors(policy, ownedForks).length === 0 ? policy : null;
}

export function resolveOwnedRepository(ownedRepositories, owner, repo, ownedForks) {
  const identity = destinationIdentity(owner, repo);
  if (!identity) return { owned: false };
  for (const entry of trustedOwnedRepositories(ownedRepositories, ownedForks)?.repositories ?? []) {
    if (entry.repository.toLowerCase() === identity) {
      return { owned: true, repository: entry.repository, level: 'propose', source: 'owned-repository' };
    }
  }
  return { owned: false };
}

// The shape rules the catalog validator enforces, applied by the reader. The
// collection accepts only `propose`, and `.upstream` records provenance, so it is
// never read as a grant.
function ownedForksErrors(policy) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) return ['not an object'];
  const errors = [];
  if (!Object.keys(policy).every((key) => key === 'forks')) errors.push('an unknown top-level field');
  if (!Array.isArray(policy.forks)) return [...errors, 'forks is not an array'];
  const seen = new Set();
  for (const [index, entry] of policy.forks.entries()) {
    errors.push(...ownedForkEntryErrors(entry, index, seen));
  }
  return errors;
}

function ownedForkEntryErrors(entry, index, seen) {
  const label = `forks[${index}]`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [`${label} is not an object`];
  const errors = [];
  const keys = ['repository', 'upstream', 'agentAccess'];
  if (!Object.keys(entry).every((key) => keys.includes(key))) errors.push(`${label} has an unknown field`);
  if (!isFullyQualified(entry.repository)) errors.push(`${label}.repository is not an owner/repository identity`);
  if (isFullyQualified(entry.repository) && entry.repository.split('/')[0].toLowerCase() !== OWNED_OWNER) {
    errors.push(`${label}.repository is not owned by ${OWNED_OWNER}`);
  }
  if (!isFullyQualified(entry.upstream)) errors.push(`${label}.upstream is not an owner/repository identity`);
  if (isFullyQualified(entry.repository) && isFullyQualified(entry.upstream)
    && entry.repository.toLowerCase() === entry.upstream.toLowerCase()) {
    errors.push(`${label}.repository and ${label}.upstream are not distinct`);
  }
  if (entry.agentAccess !== 'propose') errors.push(`${label}.agentAccess is not propose`);
  if (isFullyQualified(entry.repository) && seen.has(entry.repository.toLowerCase())) {
    errors.push(`${label}.repository duplicates an earlier entry`);
  }
  if (isFullyQualified(entry.repository)) seen.add(entry.repository.toLowerCase());
  return errors;
}

function isFullyQualified(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  return parts.length === 2 && OWNER_PATTERN.test(parts[0]) && REPOSITORY_PATTERN.test(parts[1]);
}

// The policy the grant path may use, or `null` when it is not one the catalog
// validator would accept. The loader and every pure entry point route through
// this one function, so a raw object a caller passes in cannot grant from an
// owner, a level, or a shape the validator rejects: one validation, one owner
// rule, one truth, rather than a second check beside the first.
function trustedOwnedForks(ownedForks) {
  return ownedForksErrors(ownedForks).length === 0 ? ownedForks : null;
}

// The owner whose repositories the policy records. The catalog validator restricts
// every owned fork to one personal account, so that owner is the personal account,
// and the clone's own fork of a governed repository can be told apart from a
// third-party repository that happens to share the name. The policy must pass the
// validator's rules first, so an invalid owner cannot become the personal account
// and collapse a third-party repository into the organization level. Without a
// trusted policy the collapse is unavailable and those writes fail closed.
function personalOwners(ownedForks) {
  const owners = new Set();
  for (const fork of trustedOwnedForks(ownedForks)?.forks ?? []) {
    if (isFullyQualified(fork?.repository)) owners.add(fork.repository.split('/')[0].toLowerCase());
  }
  return owners;
}

// Identity match against the owned-fork policy, case-insensitive. The policy must
// pass the same validation the loader applies, so a raw object with an owner the
// catalog validator rejects grants nothing. Never reads `.upstream` as a grant;
// the caller tests that separately.
export function resolveOwnedFork(ownedForks, owner, repo) {
  const identity = destinationIdentity(owner, repo);
  if (!identity) return { owned: false };
  for (const fork of trustedOwnedForks(ownedForks)?.forks ?? []) {
    if (typeof fork?.repository === 'string' && fork.repository.toLowerCase() === identity) {
      return { owned: true, repository: fork.repository, upstream: fork.upstream, level: 'propose', source: 'owned-fork' };
    }
  }
  return { owned: false };
}

function destinationIdentity(owner, repo) {
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  if (!OWNER_PATTERN.test(owner) || !REPOSITORY_PATTERN.test(repo)) return null;
  return `${owner}/${repo}`.toLowerCase();
}

// Classify one fully qualified destination against the roster and the owned-fork
// policy. First match wins, and the kind decides which capability table applies.
// `localRepo` is the clone's own identity, which is what makes a personal fork
// the clone's own fork rather than an unrelated repository with the same name.
//
// 1. a host other than github.com, or a malformed destination -> unknown
// 2. an exact committed ignore identity -> ignored
// 3. the organization repository -> org, at the roster level for that repository
// 4. the personal owner's fork of the clone's governed repository -> org, at the
//    same roster level, so one policy governs the repository and its push fork
// 5. an owned-fork target -> owned-fork, `propose`
// 6. a recorded upstream -> upstream, internal read baseline
// 7. anything else -> unknown, internal read baseline
export function resolveDestination({ roster, ownedForks, ownedRepositories, ignore, localRepo, host, destination } = {}) {
  const unresolved = { kind: 'unknown', owner: null, repo: null, level: FALLBACK_LEVEL, source: 'unknown' };
  if (typeof host !== 'string' || host.toLowerCase() !== GITHUB_HOST) return unresolved;
  if (!trustedIgnore(ignore)) return { ...unresolved, source: 'ignore-unavailable' };
  const identity = parseDestination(destination);
  if (!identity) return unresolved;
  if (isIgnored(ignore, identity)) return { kind: 'ignored', ...identity, level: FALLBACK_LEVEL, source: 'ignore' };
  const governed = matchGoverned(roster, ownedForks, localRepo, identity);
  if (governed) return governed;
  const fork = resolveOwnedFork(ownedForks, identity.owner, identity.repo);
  if (fork.owned) {
    return { kind: 'owned-fork', owner: identity.owner, repo: identity.repo, level: fork.level, source: 'owned-fork', upstream: fork.upstream };
  }
  const ownedRepository = resolveOwnedRepository(ownedRepositories, identity.owner, identity.repo, ownedForks);
  if (ownedRepository.owned) {
    return { kind: 'owned-repository', owner: identity.owner, repo: identity.repo, level: ownedRepository.level, source: 'owned-repository' };
  }
  if (isRecordedUpstream(ownedForks, identity)) {
    return { kind: 'upstream', owner: identity.owner, repo: identity.repo, level: FALLBACK_LEVEL, source: 'upstream' };
  }
  return { ...unresolved, owner: identity.owner, repo: identity.repo };
}

function matchGoverned(roster, ownedForks, localRepo, identity) {
  const org = typeof roster?.org === 'string' ? roster.org.toLowerCase() : null;
  if (!org) return null;
  const names = rosterNames(roster);
  if (identity.owner === org && names.has(identity.repo)) {
    return governedAt(roster, names.get(identity.repo), identity, 'org');
  }
  const local = typeof localRepo === 'string' ? localRepo.toLowerCase() : null;
  const ownFork = local !== null && identity.repo === local && identity.owner !== org;
  if (ownFork && names.has(local) && personalOwners(ownedForks).has(identity.owner)) {
    return governedAt(roster, names.get(local), identity, 'personal-fork');
  }
  return null;
}

function governedAt(roster, declared, identity, source) {
  return { kind: 'org', owner: identity.owner, repo: identity.repo, level: resolveLevel(roster, declared).level, source };
}

function isRecordedUpstream(ownedForks, identity) {
  const name = destinationIdentity(identity.owner, identity.repo);
  return (trustedOwnedForks(ownedForks)?.forks ?? []).some(
    (fork) => typeof fork?.upstream === 'string' && fork.upstream.toLowerCase() === name,
  );
}

function rosterNames(roster) {
  const names = new Map();
  for (const entry of roster?.repos ?? []) {
    if (typeof entry?.name === 'string') names.set(entry.name.toLowerCase(), entry.name);
  }
  return names;
}

function parseDestination(destination) {
  if (typeof destination !== 'string') return null;
  const parts = destination.split('/');
  if (parts.length !== 2 || !OWNER_PATTERN.test(parts[0]) || !REPOSITORY_PATTERN.test(parts[1])) return null;
  return { owner: parts[0].toLowerCase(), repo: parts[1].toLowerCase() };
}

export const FORBIDDEN_CAPABILITY = 'forbidden';
const KNOWN_CAPABILITIES = new Set([...Object.values(CAPABILITIES).flat(), FORBIDDEN_CAPABILITY]);

// The operations that write, and the capabilities that write. The names are the
// ones the intent already uses. An intent whose operation is a write but whose
// capability is null, or whose operation and capability disagree about writing,
// is inconsistent: it denies instead of falling through to the read path.
const WRITE_OPERATIONS = new Set(['push', 'openPr', 'mergePr', 'admin']);
const WRITE_CAPABILITIES = new Set(['pushBranch', 'pushMain', 'openPr', 'mergePr', 'admin', FORBIDDEN_CAPABILITY]);

// True when the intent contradicts itself about writing. A caller that omits the
// operation is judged on the capability alone, so a direct pure call that names
// only a capability keeps its behavior.
function inconsistentIntent(operation, capability) {
  if (operation === undefined) return false;
  const operationWrites = WRITE_OPERATIONS.has(operation);
  const capabilityWrites = capability !== null && WRITE_CAPABILITIES.has(capability);
  return operationWrites !== capabilityWrites;
}

// Authorize one structured intent against one resolved destination. The caller
// builds the destination and the intent from the command and the observed git
// state, then this validates the intent; no write is inferred from a level, and
// nothing in the command text can word a grant.
//
// `capability === null` is a known read or a local command that reaches nothing
// this policy governs, so it needs the caller to mark it read-only. An intent
// whose operation is a write cannot take that path: the mismatch denies.
export function decideTarget(target = {}, intent = {}) {
  const capability = intent?.capability ?? null;
  if (target?.source === 'ignore-unavailable') return verdict(false, capability, 'the committed ignore policy is unavailable');
  const kind = DESTINATION_KINDS.includes(target?.kind) ? target.kind : 'unknown';
  if (kind === 'ignored' || capability === FORBIDDEN_CAPABILITY) return verdict(false, capability, kind === 'ignored' ? 'ignored destination' : 'forbidden action');
  if (inconsistentIntent(intent?.operation, capability)) {
    return verdict(false, capability, 'the operation and the capability disagree about writing');
  }
  if (capability === null) return decideReadOnly(intent);
  if (!KNOWN_CAPABILITIES.has(capability)) return verdict(false, capability, 'unknown capability');
  return kind === 'org' ? decideOrgTarget(target, intent, capability) : decideOtherTarget(kind, target, intent, capability);
}

function decideOrgTarget(target, intent, capability) {
  if (!allows(target.level, capability)) return verdict(false, capability, `org ${target.level} denies ${capability}`);
  if (capability === 'pushBranch') return decidePush(intent);
  if (capability === 'pushMain') return decideMainPush(intent);
  if (capability === 'openPr') return decideOpenPr(target, intent);
  return verdict(true, capability, `org ${target.level} grants ${capability}`);
}

function decideOtherTarget(kind, target, intent, capability) {
  if (!Object.hasOwn(CAPABILITIES_BY_KIND, kind) || !CAPABILITIES_BY_KIND[kind].includes(capability)) {
    return verdict(false, capability, `${kind} does not grant ${capability}`);
  }
  if (capability === 'read') return verdict(true, capability, 'read');
  if (intent?.resolved !== true) return verdict(false, capability, 'the destination or the ref is unresolved');
  if (capability === 'pushBranch') return decidePush(intent);
  if (capability === 'openPr') return decideOpenPr(target, intent);
  return verdict(false, capability, `${kind} does not grant ${capability}`);
}

// The null-capability path: allowed only when the caller marked the command a
// read. A caller that cannot say it is a read fails closed.
function decideReadOnly(intent) {
  return intent?.readOnly === true
    ? verdict(true, null, 'read only')
    : verdict(false, null, 'no capability and not a known read');
}

// A branch push. Only a single non-default branch refspec qualifies, and the
// default is the caller's resolved default branch rather than a literal name, so
// a tag, a deletion, a force, a multi-refspec, and an unresolved ref all deny.
function decidePush(intent) {
  if (intent?.resolved !== true) return verdict(false, 'pushBranch', 'the destination or the ref is unresolved');
  if (intent.force === true) return verdict(false, 'pushBranch', 'a force push is not allowed');
  if (intent.delete === true) return verdict(false, 'pushBranch', 'deleting a ref is not allowed');
  const refs = Array.isArray(intent.refs) ? intent.refs : [];
  if (refs.length !== 1) return verdict(false, 'pushBranch', 'exactly one branch refspec is required');
  const ref = refs[0] ?? {};
  if (ref.kind !== 'branch') return verdict(false, 'pushBranch', 'only a branch push is allowed');
  if (ref.isDefault !== false) return verdict(false, 'pushBranch', 'the default branch is not allowed');
  return verdict(true, 'pushBranch', 'a non-default branch push');
}

function decideMainPush(intent) {
  if (intent?.resolved !== true) return verdict(false, 'pushMain', 'the destination or the ref is unresolved');
  if (intent.force === true) return verdict(false, 'pushMain', 'a force push is not allowed');
  if (intent.delete === true) return verdict(false, 'pushMain', 'deleting a ref is not allowed');
  const refs = Array.isArray(intent.refs) ? intent.refs : [];
  if (refs.length !== 1) return verdict(false, 'pushMain', 'exactly one protected ref is required');
  const ref = refs[0] ?? {};
  if (ref.kind === 'tag') return verdict(true, 'pushMain', 'a tag push');
  if (ref.kind === 'branch' && ref.isDefault === true) return verdict(true, 'pushMain', 'a default-branch push');
  return verdict(false, 'pushMain', 'only a default-branch or tag push is allowed');
}

// A pull request stays on the destination repository. For an organization target,
// its head may also use the paired personal fork. A side with no owner or
// repository identity fields is the observed branch-only shorthand; once either
// identity field is present, both must match an accepted repository.
function decideOpenPr(target, intent) {
  if (intent?.resolved !== true) return verdict(false, 'openPr', 'the destination or the pull request sides are unresolved');
  if (!sameRepository(intent.base, target)) return verdict(false, 'openPr', 'the base is another repository');
  if (!sameRepository(intent.head, target) && !(target.kind === 'org' && samePairedFork(intent.head, target))) {
    return verdict(false, 'openPr', 'the head is another repository');
  }
  return verdict(true, 'openPr', 'a pull request inside the same repository');
}

function samePairedFork(side, target) {
  return side !== null && side !== undefined
    && typeof side.owner === 'string' && side.owner.toLowerCase() === OWNED_OWNER
    && typeof side.repo === 'string' && side.repo.toLowerCase() === target.repo;
}

function sameRepository(side, target) {
  if (side === null || side === undefined) return true;
  if (typeof side !== 'object') return false;
  const hasOwner = Object.hasOwn(side, 'owner');
  const hasRepo = Object.hasOwn(side, 'repo');
  if (!hasOwner && !hasRepo) return true;
  const owner = side.owner;
  const repo = side.repo;
  if (typeof owner !== 'string' || owner.length === 0 || typeof repo !== 'string' || repo.length === 0) return false;
  return owner.toLowerCase() === target.owner && repo.toLowerCase() === target.repo;
}

function verdict(allowed, capability, reason) {
  return { allowed, capability, reason };
}

// The organization remote the push hook governs. A push to any other remote is
// out of scope, so the gate leaves it to the hook's own scope rule.
const ORG_REMOTE_MARKER = 'simpsonm09-org';

// A shell command needs one capability. The patterns are ordered, first match
// wins, so merge and PR-management checks run before the generic push.
// Unmatched commands outside gh need no capability. An unmodeled gh command is
// conservatively an admin write unless it matches the observer's small read
// contract below.
const COMMAND_RULES = [
  { capability: FORBIDDEN_CAPABILITY, test: isForbiddenCommand },
  { capability: 'mergePr', test: (parts) => parts[0] === 'gh' && parts[1] === 'pr' && parts[2] === 'merge' },
  { capability: 'openPr', test: isOpenPrManagement },
  { capability: 'admin', test: (parts) => isGhAdmin(parts) || isUnmodeledGh(parts) },
  { capability: 'pushMain', test: (parts) => isGitPush(parts) && gitPushNeedsMain(parts) },
  { capability: 'pushBranch', test: (parts) => isGitPush(parts) },
];

const GH_OPEN_PR_VERBS = {
  pr: new Set(['create', 'edit', 'close', 'reopen', 'ready', 'comment', 'review', 'update-branch']),
  issue: new Set(['create']),
};

function isOpenPrManagement(parts) {
  if (!Object.hasOwn(GH_OPEN_PR_VERBS, parts[1]) || !GH_OPEN_PR_VERBS[parts[1]].has(parts[2])) return false;
  if (parts[1] === 'pr' && parts[2] === 'review') return isSafeReview(parts);
  if ((parts[1] === 'pr' && ['create', 'edit'].includes(parts[2]))
    || (parts[1] === 'issue' && parts[2] === 'create')) {
    return !hasMilestoneOperand(parts);
  }
  return true;
}

function hasMilestoneOperand(parts) {
  return hasCommandOption(parts, ['-m', '--milestone', '--remove-milestone'], [
    '--title', '-t', '--body', '-b', '--base', '-B', '--head', '-H', '--assignee', '-a',
    '--label', '-l', '--reviewer', '-r', '--project',
  ]);
}

const REVIEW_VALUE_OPTIONS = new Set(['--body', '-b', '--body-file', '-F', '--repo', '-R']);
const REVIEW_SAFE_FLAGS = new Set(['--comment', '-c', '--request-changes', '-r', '--help', '-h']);

function isSafeReview(parts) {
  if (hasForbiddenReviewWrite(parts)) return false;
  for (let index = 3; index < parts.length; index += 1) {
    const part = parts[index];
    if (REVIEW_SAFE_FLAGS.has(part)) continue;
    if (REVIEW_VALUE_OPTIONS.has(part)) {
      index += 1;
      continue;
    }
    if ([...REVIEW_VALUE_OPTIONS].some((flag) => part.startsWith(`${flag}=`))) continue;
    if (part.startsWith('-')) return false;
  }
  return true;
}

function hasCommandOption(parts, flags, valueOptions) {
  for (let index = 3; index < parts.length; index += 1) {
    const part = parts[index];
    if (flags.some((flag) => part === flag || part.startsWith(`${flag}=`) || (flag === '-m' && part.startsWith('-m') && part.length > 2))) return true;
    if (valueOptions.includes(part)) index += 1;
  }
  return false;
}

// A gh subcommand that changes repository state, or an api call that writes. Each
// is a named positional test on the recognized verb, never a scan of the whole
// command text, so a quoted example of the verb is not a match.
const GH_ADMIN_VERBS = {
  release: ['create', 'edit', 'delete', 'upload'],
  workflow: ['run', 'enable', 'disable'],
  secret: ['set', 'delete'],
  repo: ['create', 'delete', 'edit', 'rename', 'transfer', 'archive', 'unarchive'],
};

// Keep the public classifier's read contract aligned with the fail-closed
// observer. Anything outside these known read groups/verbs is not assumed safe.
const GH_READ_GROUP_VERBS = {
  pr: new Set(['list', 'view', 'status', 'diff', 'checks', 'checkout']),
  issue: new Set(['list', 'view', 'status']),
  repo: new Set(['list', 'view', 'clone']),
  release: new Set(['list', 'view', 'download']),
  workflow: new Set(['list', 'view']),
  run: new Set(['list', 'view', 'watch', 'download']),
  secret: new Set(['list']),
  variable: new Set(['list', 'get']),
  label: new Set(['list']),
  project: new Set(['list', 'view', 'field-list', 'item-list']),
  extension: new Set(['list', 'search']),
  config: new Set(['get', 'list']),
};
const API_READ_METHODS = new Set(['GET', 'HEAD']);

function isUnmodeledGh(parts) {
  if (parts[0] !== 'gh' || isGhHelp(parts)) return false;
  if (Object.hasOwn(GH_ADMIN_VERBS, parts[1]) && GH_ADMIN_VERBS[parts[1]].includes(parts[2])) return false;
  if (parts[1] === 'api') return hasUnknownApiMethod(parts);
  if (parts[1] === 'status') return false;
  if (parts[1] === 'search') return !['code', 'commits', 'issues', 'prs', 'repos', 'topics', 'users'].includes(parts[2]);
  if (Object.hasOwn(GH_READ_GROUP_VERBS, parts[1]) && GH_READ_GROUP_VERBS[parts[1]].has(parts[2])) return false;
  return true;
}

function isGhHelp(parts) {
  const last = parts.length - 1;
  // Recognize control tokens only at the end of argv. A help/version token
  // followed by another verb is ambiguous and must fail closed. Limit these
  // controls to gh's command and group slots so title operands stay data.
  if (last === 1 && ['-h', '--help', '--version'].includes(parts[1])) return true;
  if (last === 2 && ['-h', '--help'].includes(parts[2])) return true;
  // `gh help` itself is a control; help topics with trailing words are
  // conservatively unmodeled because they can resemble a command sequence.
  return parts[1] === 'help' && parts.length === 2;
}

function hasUnknownApiMethod(parts) {
  for (let index = 2; index < parts.length; index += 1) {
    const method = methodArgument(parts, index);
    if (method !== null && method !== undefined && !API_READ_METHODS.has(method.toUpperCase())) return true;
  }
  return false;
}

function isGhAdmin(parts) {
  if (parts[0] !== 'gh') return false;
  const verbs = Object.hasOwn(GH_ADMIN_VERBS, parts[1]) ? GH_ADMIN_VERBS[parts[1]] : undefined;
  if (verbs?.includes(parts[2])) return true;
  return parts[1] === 'api' && (isWriteMethod(parts) || hasImplicitApiBody(parts));
}

// gh api treats -f/--field/--raw-field/--input as an implicit write. A body flag
// is the exact token, a long flag with its value after "=", or the attached short
// form gh also accepts (-fkey=value, -Fkey=@file). The short form is matched on
// the -f/-F prefix of one token -- the same attached-short-flag reading the
// method parser uses -- not a scan of the command text. A long flag starts with
// "--", so it never reads as an attached short flag.
const API_BODY_FLAGS = ['-f', '-F', '--field', '--raw-field', '--input'];
const API_BODY_PREFIXES = ['--field=', '--raw-field=', '--input='];

function hasImplicitApiBody(parts) {
  return parts.some(isApiBodyFlag);
}

function isApiBodyFlag(part) {
  if (API_BODY_FLAGS.includes(part)) return true;
  if (API_BODY_PREFIXES.some((prefix) => part.startsWith(prefix))) return true;
  return !part.startsWith('--') && (part.startsWith('-f') || part.startsWith('-F')) && part.length > 2;
}

function isGitPush(parts) {
  return parts[0] === 'git' && parts[1] === 'push';
}

// Parse the tokens after "git push". A flag token starts with "-" and is
// skipped. The first non-flag token is the remote only when it is not a
// refspec: a token naming a ref ("main", "refs/heads/x", or "X:Y") is a
// refspec even in the remote position. Every remaining non-flag token is a
// refspec. This handles a flag or flags between "push" and the remote or ref,
// as in "git push --dry-run origin main".
function gitPushTarget(parts) {
  const tokens = parts.slice(2).filter((token) => !token.startsWith('-'));
  const remote = tokens[0] && !looksLikeRefspec(tokens[0]) ? tokens[0] : undefined;
  const refspecs = remote ? tokens.slice(1) : tokens;
  return { remote, refspecs };
}

function gitPushRefspecs(parts) {
  return gitPushTarget(parts).refspecs;
}

// A refspec names a ref. "main" and "refs/heads/main" are the shorthand and the
// full form. A colon separates source and destination ("X:main", ":main"), and
// the leading colon alone is a deletion. A bare remote name has no colon and no
// slash, and does not start with a ref prefix, so it reads as a remote.
function looksLikeRefspec(token) {
  if (token.includes(':')) return true;
  if (token === 'HEAD' || token.startsWith('refs/') || token.startsWith('refs\\')) return true;
  if (!token.includes('/')) return false;
  const [head] = token.split(/[/\\]/);
  return head === 'refs' || head === 'heads';
}

// git push <remote> <refspec>. Bare "main" expands to refs/heads/main. A
// refspec with a colon separates source and destination ("X:main", ":main",
// "feat/x:main"), and the destination is the ref the remote writes, so the part
// after the colon is the one tested. A tag destination is a tag write, and a
// deletion of the default branch is a default-branch write.
function refspecDestination(refspec) {
  const value = refspec ?? '';
  return value.includes(':') ? value.slice(value.indexOf(':') + 1) : value;
}

function isProtectedRef(refspec) {
  const ref = refspecDestination(refspec);
  return ref === 'main' || ref === 'refs/heads/main' || ref.startsWith('refs/tags/') || ref.startsWith('refs/tags\\');
}

// A push needs `pushMain` when it writes a tag or the default branch, or when it
// writes refs the command does not name: --tags, --all, --mirror, --follow-tags,
// and --delete push refs on their own, and --prune removes the remote refs the
// refspec does not cover, which is the same broad scope. A bare ref name is left
// to the caller's ref resolution rather than a name guess.
const PUSH_MAIN_FLAGS = ['--tags', '--all', '--mirror', '--follow-tags', '--delete', '-d', '--prune'];

function gitPushNeedsMain(parts) {
  if (gitPushRefspecs(parts).some(isProtectedRef)) return true;
  return parts.slice(2).some((token) => token.startsWith('-') && PUSH_MAIN_FLAGS.includes(token));
}

// A git push is governed only when it targets the organization remote. When the
// remote URL is known and is not the organization, the push is out of scope and
// needs no capability, which matches the pre-push hook's URL scope. When the URL
// is unknown, the push stays governed, so the gate keeps its current behavior.
function pushInScope(parts, remoteUrl) {
  if (!isGitPush(parts)) return true;
  if (!remoteUrl) return true;
  return remoteUrl.includes(ORG_REMOTE_MARKER);
}

// gh api mutates only when it names an explicit HTTP method. The method comes
// from the next token after -X or --method, from a --method=... form, or from the
// attached short form gh also accepts (-XDELETE). The attached form is matched on
// the -X prefix, not a scan of the whole token, so a value that merely contains
// "POST" is never a method.
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

function isWriteMethod(parts) {
  for (let index = 0; index < parts.length; index += 1) {
    const value = methodArgument(parts, index);
    if (value && WRITE_METHODS.includes(value.toUpperCase())) return true;
  }
  return false;
}

// The HTTP method one token names, or null when it names none. A bare -X or
// --method takes the next token, --method=... carries its own value, and -X...
// appends the value to the short flag.
function methodArgument(parts, index) {
  const arg = parts[index] ?? '';
  if (arg === '-X' || arg === '--method') return parts[index + 1];
  if (arg.startsWith('--method=')) return arg.slice('--method='.length);
  if (arg.startsWith('-X') && arg.length > 2) return arg.slice(2);
  return null;
}

// Classify one supported simple command. This small tokenizer groups whitespace
// and quotes but rejects unsupported expansion syntax on governed commands; it
// does not inspect wrappers or compound commands. A non-gh command with no match
// classifies to null. Unknown gh forms use the admin fallback. A git push to a
// known non-organization remote is out of scope for this classifier.
export function classify(command, remoteUrl) {
  const parsed = tokenize(command);
  if (!parsed) return FORBIDDEN_CAPABILITY;
  const { parts, unsupported, firstTokenUnsupported } = parsed;
  if (firstTokenUnsupported) return FORBIDDEN_CAPABILITY;
  parts[0] = normalizeExecutable(parts[0]);
  if (['!', 'time'].includes(parts[0])) return FORBIDDEN_CAPABILITY;
  if (unsupported && (parts[0] === 'gh' || isGitPush(parts))) return FORBIDDEN_CAPABILITY;
  if (!pushInScope(parts, remoteUrl)) return null;
  const rule = COMMAND_RULES.find((candidate) => candidate.test(parts));
  return rule ? rule.capability : null;
}

function tokenize(command) {
  if (typeof command !== 'string') return { parts: [], unsupported: false };
  const tokens = [];
  const state = { token: '', quote: null, started: false, unsupported: false, tokenUnsupported: false, firstTokenUnsupported: false, firstTokenPending: true };
  for (const char of command) consumeCommandChar(tokens, state, char);
  if (state.quote) return null;
  if (state.started) finishCommandToken(tokens, state);
  return { parts: tokens, unsupported: state.unsupported, firstTokenUnsupported: state.firstTokenUnsupported };
}

function consumeCommandChar(tokens, state, char) {
  if (state.quoteEscape && !state.quote) {
    state.quoteEscape = false;
    state.token += char;
    return;
  }
  if (state.quote) {
    return consumeQuotedChar(state, char);
  } else if (char === '\\') {
    state.unsupported = true;
    markTokenUnsupported(state);
    state.started = true;
    state.quoteEscape = true;
  } else if (char === '"' || char === "'") {
    state.quote = char;
    state.started = true;
  } else if (/\s/.test(char)) {
    finishCommandToken(tokens, state);
  } else {
    if (isUnsupportedShellChar(char, state.started)) {
      state.unsupported = true;
      markTokenUnsupported(state);
    }
    state.token += char;
    state.started = true;
  }
}

function consumeQuotedChar(state, char) {
  if (state.quoteEscape) {
    state.quoteEscape = false;
    if (['"', '\\', '$', '`'].includes(char)) {
      state.unsupported = true;
      markTokenUnsupported(state);
      state.token += char;
    } else state.token += `\\${char}`;
    return;
  }
  if (state.quote === '"' && char === '\\') {
    state.quoteEscape = true;
  } else if (char === state.quote) state.quote = null;
  else {
    if (state.quote === '"' && ['$', '`'].includes(char)) {
      state.unsupported = true;
      markTokenUnsupported(state);
    }
    state.token += char;
  }
  state.started = true;
}

function finishCommandToken(tokens, state) {
  if (state.started) {
    if (state.firstTokenPending) {
      state.firstTokenUnsupported = state.tokenUnsupported;
      state.firstTokenPending = false;
    }
    tokens.push(state.token);
  }
  state.token = '';
  state.started = false;
  state.tokenUnsupported = false;
}

function markTokenUnsupported(state) {
  state.tokenUnsupported = true;
}

function normalizeExecutable(executable) {
  const basename = (executable ?? '').split(/[\\/]/).at(-1) ?? '';
  return basename.replace(/\.exe$/i, '').toLowerCase();
}

function isUnsupportedShellChar(char, tokenStarted) {
  return ['$', '`', '{', '}', '(', ')', '<', '>', ';', '&', '|', '*', '?', '[', ']'].includes(char) || (char === '~' && !tokenStarted);
}

// A null classification needs no capability, so it is allowed at every level.
export function decide(level, command, remoteUrl) {
  const capability = classify(command, remoteUrl);
  return capability === null ? { capability, allowed: true } : { capability, allowed: capability !== FORBIDDEN_CAPABILITY && allows(level, capability) };
}

function isForbiddenCommand(parts) {
  if (parts[0] !== 'gh') return false;
  if (parts[1] === 'pr' && parts[2] === 'merge'
    && parts.slice(3).some((part) => part === '--admin' || part.startsWith('--admin='))) return true;
  if (parts[1] === 'pr' && parts[2] === 'review' && !isSafeReview(parts)) return true;
  return parts[1] === 'api' && isForbiddenReviewApi(parts);
}

function hasForbiddenReviewWrite(parts) {
  for (let index = 3; index < parts.length; index += 1) {
    if (REVIEW_VALUE_OPTIONS.has(parts[index])) index += 1;
    else if (['--approve', '-a', '--dismiss'].some((flag) => parts[index] === flag || parts[index].startsWith(`${flag}=`))) return true;
  }
  return false;
}

function isForbiddenReviewApi(parts) {
  if (!(isWriteMethod(parts) || hasImplicitApiBody(parts))) return false;
  const endpoints = parts.slice(2).map(normalizeApiEndpointToken);
  if (endpoints.some((endpoint) => endpoint.ambiguous)) return true;
  if (endpoints.some((endpoint) => isReviewRouteToken(endpoint.path))) return true;
  if (!endpoints.some((endpoint) => isGraphqlEndpointToken(endpoint.path))) return false;
  const payload = parts.slice(2).join(' ');
  if (/(?:query\s*=\s*|--input(?:=|\s+)|-F?\s+query\s*=)[^\s]*@|--input(?:=|\s+)/i.test(payload)) return true;
  return /\bmutation\b[\s\S]*\b[\w]*(?:pullrequestreview|reviewthread|reviewcomment|reviewrequests?)[\w]*\b/i.test(payload);
}

function normalizeApiEndpointToken(token) {
  const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token);
  const canonicalAbsolute = /^https:\/\/api\.github\.com(?=\/|\?|#|$)/i.test(token);
  const endpointLike = absolute || /^(?:\/|\.|%|repos[/%]|graphql(?:[/?#]|$))/i.test(token);
  if (!endpointLike) return { path: '', ambiguous: false };
  const pathToken = absolute && canonicalAbsolute ? token.slice('https://api.github.com'.length) : token;
  if ((absolute && !canonicalAbsolute) || pathToken.includes('\\') || pathToken.includes('//') || /%|(?:^|\/)\.{1,2}(?:\/|$)/.test(pathToken)) return { path: '', ambiguous: true };
  try {
    const url = new URL(absolute ? token : `https://api.github.com/${token.replace(/^\//, '')}`);
    if (url.origin.toLowerCase() !== 'https://api.github.com' || url.username || url.password) return { path: '', ambiguous: true };
    return { path: `${url.pathname}${url.search}`, ambiguous: false };
  } catch {
    return { path: '', ambiguous: true };
  }
}

function isReviewRouteToken(token) {
  return /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews(?:[/?]|$)/i.test(token);
}

function isGraphqlEndpointToken(token) {
  return /^\/graphql\/?(?:\?.*)?$/i.test(token);
}

export function selfTest() {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const fixture = {
    agentAccessDefaults: { standard: 'read', feature: 'propose', legacy: 'none' },
    repos: [
      { name: 'tier-default', tier: 'standard' },
      { name: 'feature-default', tier: 'feature' },
      { name: 'override', tier: 'feature', agentAccess: 'merge' },
      { name: 'legacy', tier: 'legacy' },
    ],
  };

  assert(resolveLevel(fixture, 'tier-default').level === 'read', 'tier default');
  assert(resolveLevel(fixture, 'feature-default').level === 'propose', 'feature default');
  const override = resolveLevel(fixture, 'override');
  assert(override.level === 'merge' && override.source === 'override', 'per-repo override');
  assert(resolveLevel(fixture, 'legacy').level === 'read', 'an invalid legacy default falls back to the internal read baseline');
  const unknown = resolveLevel(fixture, 'not-listed');
  assert(unknown.level === FALLBACK_LEVEL && unknown.source === 'unknown', 'unknown repository');

  for (const level of LEVELS) assert(Array.isArray(CAPABILITIES[level]), `capabilities for ${level}`);
  assert(allows('none', 'read') === false, 'none denies read');
  assert(allows('read', 'read') && allows('read', 'pushBranch') === false, 'read capabilities');
  assert(allows('propose', 'pushBranch') && allows('propose', 'mergePr') === false, 'propose capabilities');
  assert(allows('merge', 'mergePr') && allows('merge', 'pushMain') === false, 'merge capabilities');
  assert(allows('full', 'pushMain') && allows('full', 'admin'), 'full capabilities');

  const fork = 'https://github.com/simpsonm09/simpsonm09-repo-standard.git';
  const org = 'https://github.com/simpsonm09-org/simpsonm09-repo-standard.git';

  const table = [
    ['gh pr merge 1', 'mergePr'],
    ['gh pr create --title x', 'openPr'],
    ['git push origin main', 'pushMain'],
    ['git push upstream refs/heads/main', 'pushMain'],
    ['git push origin main --force-with-lease', 'pushMain'],
    ['git push origin feat/x', 'pushBranch'],
    ['git push origin :main', 'pushMain'],
    ['git push origin feat/x:main', 'pushMain'],
    ['git push origin refs/tags/v1', 'pushMain'],
    ['git push origin v1:refs/tags/v1', 'pushMain'],
    ['git push origin --tags', 'pushMain'],
    ['git push --all', 'pushMain'],
    ['git push --mirror', 'pushMain'],
    ['git push origin --delete feat/x', 'pushMain'],
    ['git push origin --prune feat/x', 'pushMain'],
    ['git push --prune origin feat/x', 'pushMain'],
    ['git push --dry-run --prune origin feat/x', 'pushMain'],
    ['git push origin --prune feat/x feat/y', 'pushMain'],
    ['git push origin --prune refs/heads/*:refs/heads/*', FORBIDDEN_CAPABILITY],
    ['git push --prune', 'pushMain'],
    ['git push --dry-run origin main', 'pushMain'],
    ['git push -f origin main', 'pushMain'],
    ['git push --force-with-lease origin refs/heads/main', 'pushMain'],
    ['git push --dry-run origin feat/x', 'pushBranch'],
    ['git push --dry-run', 'pushBranch'],
    ['git push origin', 'pushBranch'],
    ['git push', 'pushBranch'],
    ['gh api repos/o/r --method PATCH', 'admin'],
    ['gh api -X DELETE repos/o/r', 'admin'],
    ['gh api -XDELETE repos/o/r', 'admin'],
    ['gh api -XPOST repos/o/r', 'admin'],
    ['gh api -XPATCH repos/o/r', 'admin'],
    ['gh api -XPUT repos/o/r', 'admin'],
    ['gh api --method=POST repos/o/r', 'admin'],
    ['gh api --method=delete repos/o/r', 'admin'],
    ['gh api -f name=value repos/o/r', 'admin'],
    ['gh api -fkey=value repos/o/r', 'admin'],
    ['gh api -Fkey=@file repos/o/r', 'admin'],
    ['gh api -f=key=value repos/o/r', 'admin'],
    ['gh api graphql -fquery=mutation', 'admin'],
    ['gh api --input - repos/o/r', 'admin'],
    ['gh release create v1', 'admin'],
    ['gh workflow run ci.yml', 'admin'],
    ['gh secret set X', 'admin'],
    ['gh repo edit --description y', 'admin'],
    ['gh pr edit 52 --base main', 'openPr'],
    ['gh pr create --milestone v1 --title x', 'admin'],
    ['gh pr edit 52 -m v1', 'admin'],
    ['gh issue create --title x', 'openPr'],
    ['gh unknown-command --admin', 'admin'],
    ['gh pr view 1', null],
    ['gh pr list', null],
    ['gh help', null],
    ['gh help pr', 'admin'],
    ['gh --help', null],
    ['gh --version', null],
    ['gh -h issue create --title x', 'admin'],
    ['gh --version issue create --title x', 'admin'],
    ['gh issue --help create --title x', 'admin'],
    ['gh help issue create --title x', 'admin'],
    ['gh auth token', 'admin'],
    ['gh auth status', 'admin'],
    ['gh auth status --show-token', 'admin'],
    ['gh auth status -t', 'admin'],
    ['gh status', null],
    ['gh search repos foo', null],
    ['gh search foo x', 'admin'],
    ['gh repo unarchive o/r', 'admin'],
    ['gh release list', null],
    ['gh workflow list', null],
    ['gh secret list', null],
    ['gh api -X get repos/o/r', null],
    ['gh api repos/o/r', null],
    ['gh api -X GET repos/o/r', null],
    ['gh api -XGET repos/o/r', null],
    ['gh api -X HEAD repos/o/r', null],
    ['gh api -XHEAD repos/o/r', null],
    ['gh api -X', null],
    ['gh api -XPOSTED repos/o/r', 'admin'],
    ['gh api repos/o/r --jq .name', null],
    ['gh api repos/o/r --paginate', null],
    ['gh pr view 1', null],
    ['npm test', null],
    ['git status', null],
    ['echo "gh pr create"', null],
    ['git commit -m "gh pr create docs"', null],
    ['echo "gh api -fkey=value repos/o/r"', null],
    ['git commit -m "git push origin --prune"', null],
    ['npm test 2>&1 | grep "git push origin main"', null],
    ['', null],
  ];
  for (const [command, expected] of table) {
    assert(classify(command) === expected, `classify ${JSON.stringify(command)} -> ${expected}`);
  }

  // A propose level denies a push to the organization main but allows the same
  // push to the fork, because the flag case classifies the first and the scope
  // rules the second out.
  const allowed = [
    ['read', 'gh pr merge 1', false],
    ['read', 'gh pr create', false],
    ['propose', 'gh pr create', true],
    ['propose', 'gh pr merge 1', false],
    ['merge', 'gh pr merge 1', true],
    ['merge', 'git push origin main', false],
    ['full', 'git push origin main', true],
    ['none', 'npm test', true],
    ['read', 'gh api -X POST repos/o/r', false],
    ['full', 'gh api -X POST repos/o/r', true],
    ['merge', 'gh pr edit 52 --base main', true],
    ['merge', 'gh issue create --title x', true],
    ['merge', 'gh pr create --milestone v1 --title x', false],
    ['full', 'gh pr create --milestone v1 --title x', true],
    ['full', 'gh pr review 52 --approve', false],
    ['full', 'gh pr merge 52 --admin', false],
    ['merge', 'gh unknown-command', false],
    ['full', 'gh unknown-command', true],
    ['propose', 'git push origin --prune feat/x', false],
    ['merge', 'git push origin --prune feat/x', false],
    ['full', 'git push origin --prune feat/x', true],
    ['read', 'gh api -fkey=value repos/o/r', false],
    ['full', 'gh api -fkey=value repos/o/r', true],
  ];
  for (const [level, command, expected] of allowed) {
    assert(decide(level, command).allowed === expected, `decide ${level} ${JSON.stringify(command)} -> ${expected}`);
  }

  assertPushScope(assert, fork, org);
  assertDestinationPolicy(assert);
}

// The push scope coverage: a known non-organization remote is out of scope and
// needs no capability, the organization remote keeps the governed capability,
// and an unknown URL stays governed. Split from selfTest so each stays short.
function assertPushScope(assert, fork, org) {
  const scoped = [
    ['git push --dry-run origin main', fork, null],
    ['git push --dry-run origin main', org, 'pushMain'],
    ['git push upstream feat/x', fork, null],
    ['git push upstream feat/x', org, 'pushBranch'],
    ['git push origin main', fork, null],
    ['git push origin main', undefined, 'pushMain'],
    ['git push origin main', '', 'pushMain'],
  ];
  for (const [command, remoteUrl, expected] of scoped) {
    assert(classify(command, remoteUrl) === expected, `classify ${JSON.stringify(command)} @ ${remoteUrl} -> ${expected}`);
  }

  const decided = [
    ['propose', 'git push --dry-run origin main', org, false],
    ['propose', 'git push --dry-run origin main', fork, true],
    ['propose', 'git push upstream feat/x', org, true],
    ['merge', 'git push --dry-run origin main', org, false],
    ['full', 'git push --dry-run origin main', org, true],
  ];
  for (const [level, command, remoteUrl, expected] of decided) {
    assert(decide(level, command, remoteUrl).allowed === expected, `decide ${level} ${JSON.stringify(command)} @ ${remoteUrl} -> ${expected}`);
  }
}

// The destination and intent coverage: one policy truth for the organization
// repository and its personal push fork, a strict subset for an owned fork, and
// no write for an upstream or an unknown destination. Split from selfTest so
// each stays short.
function assertDestinationPolicy(assert) {
  const ownedForks = {
    forks: [{ repository: 'simpsonm09/pstack-max', upstream: 'acme/upstream-lib', agentAccess: 'propose' }],
  };
  const roster = {
    org: 'simpsonm09-org',
    agentAccessDefaults: { fixture: 'read' },
    repos: [{ name: 'demo', tier: 'fixture', agentAccess: 'propose' }],
  };
  const at = (localRepo, destination, host = 'github.com') => resolveDestination({ roster, ownedForks, ignore: { ignore: [] }, localRepo, host, destination });

  assert(at('demo', 'simpsonm09-org/demo').kind === 'org', 'the organization repository is org');
  const personal = at('demo', 'simpsonm09/demo');
  assert(personal.kind === 'org' && personal.source === 'personal-fork', 'the personal push fork follows the org level');
  assert(at('demo', 'simpsonm09-org/not-listed').kind === 'unknown', 'an unlisted repository is unknown');
  assert(at('demo', 'acme/demo').kind === 'unknown', 'a third-party repository with the same name is unknown');
  assert(at('pstack-max', 'simpsonm09/pstack-max').kind === 'owned-fork', 'an owned fork is its own kind');
  assert(at('pstack-max', 'acme/upstream-lib').kind === 'upstream', 'a recorded upstream is read only');
  assert(at('pstack-max', 'simpsonm09/pstack-max', 'gitlab.com').kind === 'unknown', 'another host is unknown');

  const owned = at('pstack-max', 'simpsonm09/pstack-max');
  const push = (extra) => ({
    operation: 'push',
    capability: 'pushBranch',
    readOnly: false,
    resolved: true,
    force: false,
    delete: false,
    refs: [{ kind: 'branch', name: 'feat/x', isDefault: false }],
    ...extra,
  });

  assert(decideTarget(owned, push()).allowed === true, 'an owned fork allows a non-default branch push');
  assert(decideTarget(owned, push({ refs: [{ kind: 'branch', name: 'main', isDefault: true }] })).allowed === false, 'an owned fork denies the default branch');
  assert(decideTarget(owned, push({ refs: [{ kind: 'tag', name: 'v1', isDefault: false }] })).allowed === false, 'an owned fork denies a tag');
  assert(decideTarget(owned, push({ force: true })).allowed === false, 'an owned fork denies a force push');
  assert(decideTarget(owned, push({ delete: true })).allowed === false, 'an owned fork denies a deletion');
  assert(decideTarget(owned, push({ refs: [] })).allowed === false, 'an owned fork denies an unresolved ref');
  assert(decideTarget(owned, { ...push(), capability: 'pushMain' }).allowed === false, 'an owned fork denies a main push');
  assert(decideTarget(owned, { ...push(), capability: 'mergePr' }).allowed === false, 'an owned fork denies a merge');
  assert(decideTarget(owned, { ...push(), capability: 'admin' }).allowed === false, 'an owned fork denies an admin verb');
  const crossRepo = { ...push(), capability: 'openPr', base: { owner: 'acme', repo: 'upstream-lib', branch: 'main' } };
  assert(decideTarget(owned, crossRepo).allowed === false, 'an owned fork denies a cross-repository pull request');
  const sameRepo = { ...push(), capability: 'openPr', base: { branch: 'main' } };
  assert(decideTarget(owned, sameRepo).allowed === true, 'an owned fork allows a pull request in the same repository');
  assert(decideTarget(at('pstack-max', 'acme/upstream-lib'), push()).allowed === false, 'an upstream denies a branch push');
  assert(decideTarget(at('pstack-max', 'acme/other'), { capability: null, readOnly: true, resolved: true }).allowed === true, 'an unknown destination allows a read');
  assert(decideTarget(at('pstack-max', 'acme/other'), { capability: null, readOnly: false, resolved: true }).allowed === false, 'an unknown destination denies an unqualified command');

  const writingWithoutCapability = { ...push(), capability: null, readOnly: true };
  assert(decideTarget(owned, writingWithoutCapability).allowed === false, 'a write operation with no capability is inconsistent and denied');

  const foreignPolicy = { forks: [{ repository: 'evil/pstack-max', upstream: 'acme/upstream-lib', agentAccess: 'propose' }] };
  assert(resolveOwnedFork(foreignPolicy, 'evil', 'pstack-max').owned === false, 'a policy whose owner the validator rejects grants nothing');
}

// One table for the value-taking flags, so the parser stays a loop rather than a
// chain. A Map keys on the exact flag and cannot collide with an object prototype.
const ARG_KEYS = new Map([
  ['--catalog', 'catalog'],
  ['--catalog-dir', 'catalogDir'],
  ['--allows', 'allows'],
  ['--command', 'command'],
  ['--remote-url', 'remoteUrl'],
  ['--host', 'host'],
  ['--destination', 'destination'],
  ['--intent', 'intent'],
]);

function parseArgs(argv) {
  const args = { repo: undefined, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const key = ARG_KEYS.get(arg);
    if (key) {
      index += 1;
      args[key] = argv[index];
    } else if (arg === '--json') {
      args.json = true;
    } else if (!args.repo) {
      args.repo = arg;
    }
  }
  return args;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    runSelfTest();
    return;
  }

  const args = parseArgs(argv);
  if (!args.repo) return usageAndExit();
  if (args.host !== undefined || args.destination !== undefined || args.intent !== undefined) {
    return runDestinationMode(args);
  }

  const catalog = loadCatalogFromArgs(args);
  const resolved = resolveLevel(catalog, args.repo);
  const capabilities = Object.hasOwn(CAPABILITIES, resolved.level) ? CAPABILITIES[resolved.level] : [];

  if (args.command !== undefined) {
    const { capability, allowed } = decide(resolved.level, args.command, args.remoteUrl);
    if (args.json) process.stdout.write(`${JSON.stringify({ ...resolved, capability, allowed })}\n`);
    process.exit(allowed ? 0 : 1);
  }
  if (args.allows) process.exit(capabilities.includes(args.allows) ? 0 : 1);
  if (args.json) process.stdout.write(`${JSON.stringify({ ...resolved, capabilities })}\n`);
  else process.stdout.write(`${resolved.level}\n`);
}

function runSelfTest() {
  try {
    selfTest();
    process.stdout.write('agent-access: self-test ok\n');
  } catch (error) {
    process.stderr.write(`agent-access: self-test failed: ${error.message}\n`);
    process.exit(1);
  }
}

function usageAndExit() {
  process.stderr.write('usage: agent-access <repo-name> [--catalog <path>] [--json] [--allows <capability>] [--command "<shell command>"] [--remote-url <url>]\n');
  process.stderr.write('       agent-access <repo-name> --host <host> --destination <owner/repo> --intent <json> [--catalog-dir <path>] [--json]\n');
  process.exit(2);
}

// The destination mode. The catalog is read from committed refs only, and the
// intent is a validated object, so a caller cannot word a grant out of a command
// string. Exit 0 allows, 1 denies, and 2 is usage or an unreadable roster, which
// a caller treats as a denial.
function runDestinationMode(args) {
  const intent = parseIntent(args.intent);
  if (args.host === undefined || args.destination === undefined || !intent) return usageAndExit();
  const roster = loadCommittedCatalog(args.catalogDir);
  if (!roster) {
    process.stderr.write('agent-access: cannot read the committed catalog, denying remote writes\n');
    process.exit(2);
  }
  const ownedForks = loadCommittedOwnedForks(args.catalogDir);
  const ownedRepositories = loadCommittedOwnedRepositories(args.catalogDir);
  const ignore = loadCommittedIgnore(args.catalogDir);
  if (!ignore) {
    process.stderr.write('agent-access: cannot read the committed ignore policy, denying remote writes\n');
    process.exit(2);
  }
  const target = resolveDestination({ roster, ownedForks, ownedRepositories, ignore, localRepo: args.repo, host: args.host, destination: args.destination });
  const outcome = decideTarget(target, intent);
  if (args.json) process.stdout.write(`${JSON.stringify({ ...target, intent, ...outcome })}\n`);
  process.exit(outcome.allowed ? 0 : 1);
}

const INTENT_OPERATIONS = ['push', 'openPr', 'mergePr', 'admin', 'read', 'none', 'unknown'];
const INTENT_REF_KINDS = ['branch', 'tag', 'other', 'unknown'];
const INTENT_KEYS = ['operation', 'capability', 'readOnly', 'resolved', 'refs', 'force', 'delete', 'base', 'head'];
const REF_KEYS = ['kind', 'name', 'isDefault'];
const SIDE_KEYS = ['owner', 'repo', 'branch'];

// A structured intent, validated field by field. Anything unrecognized is a usage
// error, so a caller that cannot build a trustworthy intent fails closed instead
// of falling back to a permissive default.
function parseIntent(raw) {
  if (typeof raw !== 'string') return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!validIntent(value)) return null;
  const intent = {
    operation: value.operation,
    capability: value.capability ?? null,
    readOnly: value.readOnly,
    resolved: value.resolved,
    refs: value.refs ?? [],
    force: value.force === true,
    delete: value.delete === true,
  };
  if (value.base) intent.base = value.base;
  if (value.head) intent.head = value.head;
  return intent;
}

// Every field is checked, including the two optional sides, so an unrecognized or
// malformed intent cannot reach the policy.
function validIntent(value) {
  if (!hasOnly(value, INTENT_KEYS)) return false;
  if (!INTENT_OPERATIONS.includes(value.operation)) return false;
  if (!validIntentCapability(value.capability)) return false;
  if (typeof value.readOnly !== 'boolean' || typeof value.resolved !== 'boolean') return false;
  if (!isOptionalBoolean(value.force) || !isOptionalBoolean(value.delete)) return false;
  const refs = value.refs ?? [];
  if (!Array.isArray(refs) || !refs.every(isRef)) return false;
  return isSide(value.base) && isSide(value.head);
}

function validIntentCapability(capability) {
  return capability === undefined || capability === null || KNOWN_CAPABILITIES.has(capability);
}

function hasOnly(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
}

function isOptionalBoolean(value) {
  return value === undefined || typeof value === 'boolean';
}

function isRef(ref) {
  if (!hasOnly(ref, REF_KEYS)) return false;
  if (!INTENT_REF_KINDS.includes(ref.kind)) return false;
  return typeof ref.name === 'string' && isOptionalDefault(ref);
}

function isOptionalDefault(ref) {
  return ref.isDefault === undefined || ref.isDefault === null || typeof ref.isDefault === 'boolean';
}

// An absent side is valid, a present one must name only strings. The policy then
// reads the owner and the repository, so a validated side cannot smuggle a value
// the type does not expect.
function isSide(value) {
  if (value === undefined || value === null) return true;
  if (!hasOnly(value, SIDE_KEYS)) return false;
  const fields = SIDE_KEYS.filter((key) => value[key] !== undefined && value[key] !== null);
  return fields.every((key) => typeof value[key] === 'string');
}

function loadCatalogFromArgs(args) {
  try {
    return args.catalog
      ? loadCatalog(args.catalog)
      : loadCommittedCatalog() ?? loadCatalog(DEFAULT_CATALOG);
  } catch {
    process.stderr.write('agent-access: cannot read the catalog, denying remote writes\n');
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
