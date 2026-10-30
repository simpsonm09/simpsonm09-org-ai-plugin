// The `gh` half of the command observer: the verb classification, the operation a gh
// invocation needs, and the destination from `-R`/`--repo` or the clone's own remotes. It
// reads git state through the injected read-only reader (lib/gitstate.mjs) and returns the
// shared Observation shape (lib/observation.mjs). The option tables it reads against live in
// lib/ghoptions.mjs and the argument reader in lib/ghargv.mjs.
//
// Bounded forms only, and the bounds are the contract:
//   - `gh` global flags are -R/--repo, --help, and --version; a gh verb with no precise
//     capability in this observer is a conservative `admin` write, never a read.
//   - `gh` resolves a missing -R through the API, so a clone that names more than one github
//     destination is `ambiguous` and a governed write fails closed.
//   - a wrapper, an interpreter, or an alias is not a modeled form: the program is the
//     wrapper, so the command is `local`.

import { ghCommandStart, readGhArguments } from "./ghargv.mjs";
import { COMMAND_OPTIONS, GLOBAL_OPTIONS, READ_TABLE } from "./ghoptions.mjs";
import {
  commandReader,
  identityKey,
  parseGithubRepo,
  parseRepoArgument,
  remoteFetchUrl,
  remoteNames,
  remotePushUrls,
} from "./gitstate.mjs";
import {
  baseObservation,
  readObservation,
  unsupported,
  writeObservation,
} from "./observation.mjs";

// A gh verb that only reads or only touches the local machine. These are the verbs the
// observer treats as read-only, and the list is deliberately small: a verb not on it is a
// write, so an unlisted verb can never be granted as a read.
const READ_VERBS = new Set([
  "list",
  "view",
  "status",
  "diff",
  "checks",
  "show",
  "watch",
  "clone",
  "checkout",
  "download",
  "browse",
  "get",
]);

// A gh group whose verbs are all reads (`gh search prs`, `gh status`). Kept beside the read
// verbs so a group-wide read is one entry rather than an enumeration of its verbs.
const READ_GROUPS = new Set(["search", "status"]);

// A gh group that does not write to a repository at all (its state is local config or the
// terminal). Anything outside this set and outside the reads above is treated as a write.
const LOCAL_GROUPS = new Set([
  "alias",
  "auth",
  "completion",
  "config",
  "extension",
  "help",
  "version",
]);

// The gh subcommands that change repository state, matching the resolver's own table.
const ADMIN_VERBS = {
  release: ["create", "edit", "delete", "upload"],
  workflow: ["run", "enable", "disable"],
  secret: ["set", "delete"],
  repo: [
    "create",
    "delete",
    "edit",
    "rename",
    "transfer",
    "archive",
    "unarchive",
  ],
};

// The gh `api` options that carry a request body, and so an implicit write.
const API_BODY_OPTIONS = ["-f", "-F", "--field", "--raw-field", "--input"];

// The gh `api` options that carry one field of a GraphQL request. A GraphQL query is sent as
// a POST body, so these are the options that can make `gh api graphql` a read.
const API_FIELD_OPTIONS = new Set(["-f", "--raw-field", "-F", "--field"]);

// A GraphQL document that names one of the writing root operations anywhere in its text. The
// whole word test is case-insensitive, so `mutation` in a comment also denies: the read is a
// narrow exception and anything ambiguous stays a conservative write.
const GRAPHQL_WRITE_TOKENS = /\b(?:mutation|subscription)\b/i;

const PRECISE_WRITE_OPERATIONS = new Map([
  [
    "pr create",
    { operation: "openPr", capability: "openPr", reason: "gh pr create" },
  ],
  [
    "pr ready",
    { operation: "openPr", capability: "openPr", reason: "gh pr ready" },
  ],
  [
    "pr comment",
    { operation: "openPr", capability: "openPr", reason: "gh pr comment" },
  ],
  [
    "issue comment",
    { operation: "openPr", capability: "openPr", reason: "gh issue comment" },
  ],
  [
    "issue create",
    { operation: "openPr", capability: "openPr", reason: "gh issue create" },
  ],
  [
    "pr merge",
    { operation: "mergePr", capability: "mergePr", reason: "gh pr merge" },
  ],
  [
    "pr edit",
    { operation: "openPr", capability: "openPr", reason: "gh pr edit" },
  ],
  [
    "pr close",
    { operation: "openPr", capability: "openPr", reason: "gh pr close" },
  ],
  [
    "pr reopen",
    { operation: "openPr", capability: "openPr", reason: "gh pr reopen" },
  ],
  [
    "pr review",
    { operation: "admin", capability: "forbidden", reason: "gh pr review" },
  ],
  [
    "pr review-comment",
    {
      operation: "admin",
      capability: "forbidden",
      reason: "gh pr review-comment",
    },
  ],
  [
    "milestone create",
    { operation: "admin", capability: "admin", reason: "gh milestone create" },
  ],
  [
    "milestone edit",
    { operation: "admin", capability: "admin", reason: "gh milestone edit" },
  ],
  [
    "milestone delete",
    { operation: "admin", capability: "admin", reason: "gh milestone delete" },
  ],
]);

// The option table for a group and its verb. An unmodeled command gets the global table only,
// so any other option it carries makes the read untrustworthy and the destination unresolved.
/**
 * @param {string[]} words
 * @param {number} start
 * @returns {{ values: Set<string>, flags: Set<string> }}
 */
function optionSpecFor(words, start) {
  const group = words[start];
  const verb = words[start + 1];
  if (group === "api") return COMMAND_OPTIONS.get("api");
  const command = COMMAND_OPTIONS.get(`${group} ${verb}`);
  if (command) return command;
  if (READ_GROUPS.has(group) || READ_VERBS.has(verb))
    return READ_TABLE.get(group) ?? GLOBAL_OPTIONS;
  return GLOBAL_OPTIONS;
}

// One gh command, classified. The `gh` program word decides, and nothing else in the command
// can change the program. `literalWords` marks the words the shell hands over unexpanded; the
// graphql read exemption requires every field value to be one of them.
/**
 * @param {string[]} words the tokens after the `gh` program word
 * @param {{ shell: "bash" | "powershell", cwd: string | null, memo: ((args: string[]) => string | null) | null }} context
 * @param {boolean[]} [literalWords]
 * @returns {import("./observation.mjs").Observation}
 */
export function classifyGh(words, context, literalWords) {
  const started = ghCommandStart(words);
  if (started.help)
    return readObservation("gh", "a gh help or version command");
  const scan = readGhArguments(
    words,
    started.index + 1,
    optionSpecFor(words, started.index),
    literalWords,
  );
  const options = [...started.options, ...scan.options];
  const ghHostnames = options
    .filter((option) => option.name === "--hostname")
    .map((option) => ({ value: option.value, literal: option.literal }));
  const strict = started.strict && scan.strict;
  const operation = classifyGhOperation(
    words,
    started.index,
    scan,
    literalWords,
  );
  const repoSync = repoSyncArguments(words, started, scan);
  const ghArgumentsLiteral =
    Array.isArray(literalWords) &&
    literalWords.length === words.length &&
    literalWords.every(Boolean);
  const ghCommandKnown = isKnownGhCommand(words, started.index);
  const ghExternalUrl = hasNonGithubUrl(words);
  const read = commandReader(context, []);
  const repoOption = ghRepoArgument(options);
  const repoPositional = ghRepoPositional(
    words,
    started.index,
    scan.positionals,
  );
  const { destination, destinationSource, resolved } = ghCommandDestination({
    words,
    started,
    scan,
    operation,
    repoSync,
    repoOption,
    repoPositional,
    strict,
    read,
    context,
  });

  // The gh facts every observation carries, read or write.
  const ghFacts = {
    destination,
    destinationSource,
    ghHostnames,
    ghArgumentsLiteral,
    ghArgumentsStrict: strict,
    ghCommandKnown,
    ghExternalUrl,
  };

  if (repoPositional?.unresolved) {
    if (operation.capability === null)
      return {
        ...unsupported("a URL-like gh repo positional could not be resolved"),
        program: "gh",
        operation: "read",
        readOnly: true,
        resolved: false,
        ...ghFacts,
      };
  }

  if (operation.capability === null) {
    const local = operation.operation === "local";
    return {
      ...baseObservation(local ? "local" : "read", "gh"),
      operation: local ? "none" : "read",
      readOnly: true,
      resolved,
      ...ghFacts,
      reason: operation.reason,
    };
  }

  const sides =
    operation.operation === "openPr"
      ? pullRequestSides(options)
      : { base: null, head: null, conflict: false };
  return writeObservation({
    program: "gh",
    operation: operation.operation,
    capability: operation.capability,
    resolved: resolved && !sides.conflict,
    ...ghFacts,
    ghRepoSync: repoSync,
    refs: [],
    force: false,
    delete: false,
    base: sides.base,
    head: sides.head,
    reason: operation.reason,
  });
}

function classifyGhOperation(words, start, scan, literalWords) {
  const group = words[start];
  const verb = words[start + 1];
  const operation = ghOperation(words, start, scan, literalWords);
  const milestoneOperation =
    (group === "pr" || group === "issue") &&
    (verb === "create" || verb === "edit") &&
    scan.options.some(
      (option) => option.name === "-m" || option.name === "--milestone",
    );
  if (milestoneOperation)
    return {
      operation: "admin",
      capability: "admin",
      reason: "milestone management requires repository administration",
    };
  if (
    operation.capability !== null &&
    group === "api" &&
    apiReviewWrite(words, start)
  )
    return {
      operation: "admin",
      capability: "forbidden",
      reason: "GitHub review writes are never allowed",
    };
  return operation;
}

function ghCommandDestination({
  words,
  started,
  scan,
  operation,
  repoSync,
  repoOption,
  repoPositional,
  strict,
  read,
  context,
}) {
  const urlTarget = ghTargetUrl(words[started.index], scan.positionals);
  const repo = ghDestinationArgument(repoSync, repoOption, repoPositional);
  let destination = ghDestination(repo ?? urlTarget, strict, read, context);
  if (words[started.index] === "api")
    destination = ghApiDestination(
      scan,
      operation.capability !== null,
      repoOption,
      destination,
      strict,
      read,
      context,
    );
  return ghUrlDestination(urlTarget, repo, destination);
}

function ghApiDestination(
  scan,
  isWrite,
  repoOption,
  fallback,
  strict,
  read,
  context,
) {
  const apiTarget = apiEndpointTarget(scan, isWrite);
  if (!apiTarget.present) return fallback;
  const current = repoOption
    ? ghDestination(repoOption, strict, read, context)
    : fallback;
  const conflict =
    !apiTarget.destination ||
    (repoOption !== null &&
      (!current.destination ||
        identityKey(apiTarget.destination) !==
          identityKey(current.destination)));
  return {
    destination: conflict ? null : apiTarget.destination,
    resolved: !conflict,
    source: "explicit",
  };
}

function ghUrlDestination(urlTarget, repo, destination) {
  if (!urlTarget || !repo || !destination.destination)
    return {
      destination: destination.destination,
      destinationSource: destination.source,
      resolved: destination.resolved,
    };
  const target = parseRepoArgument(urlTarget.value);
  if (target && identityKey(target) === identityKey(destination.destination))
    return {
      destination: destination.destination,
      destinationSource: destination.source,
      resolved: destination.resolved,
    };
  return {
    destination: null,
    destinationSource: "explicit",
    resolved: false,
  };
}

// The built-in gh groups a read verb may follow. An alias or an extension is not here: its
// expansion is never observed, and an extension is code that would receive the token.
const BUILTIN_GROUPS = new Set([
  "pr",
  "issue",
  "run",
  "repo",
  "release",
  "workflow",
  "gist",
  "label",
  "cache",
  "ruleset",
  "secret",
  "variable",
]);

// Whether the gh command is one the gate models, so its arguments were observed in full.
// The arguments of a `gh repo sync`, which the gate checks against the personal-fork grant.
/**
 * @param {string[]} words
 * @param {{ index: number, options: Array<{ name: string, value: string | null }> }} started
 * @param {{ positionals: string[], options: Array<{ name: string, value: string | null }> }} scan
 */
function repoSyncArguments(words, started, scan) {
  if (words[started.index] !== "repo" || words[started.index + 1] !== "sync")
    return null;
  return {
    positionals: scan.positionals.slice(1),
    options: [...started.options, ...scan.options],
  };
}

/**
 * @param {string[]} words
 * @param {number} start
 * @returns {boolean}
 */
function isKnownGhCommand(words, start) {
  const group = words[start];
  const verb = words[start + 1];
  return (
    group === "api" ||
    (LOCAL_GROUPS.has(group) && group !== "extension") ||
    READ_GROUPS.has(group) ||
    (BUILTIN_GROUPS.has(group) && READ_VERBS.has(verb)) ||
    COMMAND_OPTIONS.has(`${group} ${verb}`) ||
    ADMIN_VERBS[group]?.includes(verb) === true
  );
}

/**
 * @param {string[]} words
 * @returns {boolean}
 */
function hasNonGithubUrl(words) {
  return words.some((word) => {
    if (!word.includes("://")) return false;
    try {
      const host = new URL(word).hostname.toLowerCase();
      return host !== "github.com" && host !== "api.github.com";
    } catch {
      return true;
    }
  });
}

// The operation and the capability one gh invocation needs. A read verb is a read; a group
// that never writes a repository is local; a known verb takes its precise capability; every
// other verb is a conservative `admin` write, so an unmodeled verb is never granted as a read.
/**
 * @param {string[]} words
 * @param {number} start
 * @param {{ options: Array<{ name: string, value: string | null }>, positionals: string[], strict: boolean }} [scan]
 * @param {boolean[]} [literalWords]
 * @returns {{ operation: string, capability: string | null, reason: string }}
 */
export function ghOperation(words, start, scan, literalWords) {
  const group = words[start];
  const verb = words[start + 1];
  if (
    group === "pr" &&
    verb === "merge" &&
    scan?.options?.some((option) => option.name === "--admin")
  )
    return {
      operation: "admin",
      capability: "forbidden",
      reason: "admin PR merge is never allowed",
    };
  if (group === undefined)
    return { operation: "read", capability: null, reason: "bare gh" };
  if (LOCAL_GROUPS.has(group))
    return {
      operation: "local",
      capability: null,
      reason: `the local gh group "${group}"`,
    };
  if (READ_GROUPS.has(group))
    return {
      operation: "read",
      capability: null,
      reason: `the gh read group "${group}"`,
    };
  if (READ_VERBS.has(verb))
    return {
      operation: "read",
      capability: null,
      reason: `the gh read verb "${group} ${verb}"`,
    };
  if (group === "api") {
    const argumentsScan =
      scan ??
      readGhArguments(
        words,
        start + 1,
        optionSpecFor(words, start),
        literalWords,
      );
    return apiOperation(argumentsScan);
  }
  const precise = PRECISE_WRITE_OPERATIONS.get(`${group} ${verb}`);
  if (precise) return precise;
  if (ADMIN_VERBS[group]?.includes(verb))
    return {
      operation: "admin",
      capability: "admin",
      reason: `the gh admin verb "${group} ${verb}"`,
    };
  return {
    operation: "admin",
    capability: "admin",
    reason: `the gh verb "${group} ${verb ?? ""}" has no precise capability; it is treated as an admin write`,
  };
}

// `gh api` reads only when the method is absent, GET, or HEAD, and the command carries no body
// option. One body option is exempt: a GraphQL query, which GitHub requires as a POST body but
// which only reads when the document names no writing root operation. The body options and the
// method come from the same left-to-right read, so a body flag that is really another option's
// value (`--jq -f`) is not read as a body. An unknown explicit method is a conservative write. A
// repeated method is read the way gh reads it, last one wins, so an earlier GET cannot hide a
// later DELETE.
/**
 * @param {{ options: Array<{ name: string, value: string | null }>, positionals: string[], strict: boolean }} scan
 * @returns {{ operation: string, capability: string | null, reason: string }}
 */
function apiOperation(scan) {
  if (scan.strict !== true)
    return {
      operation: "admin",
      capability: "admin",
      reason: "gh api has an unmodeled option; it is treated as a write",
    };
  if (graphqlRead(scan))
    return {
      operation: "read",
      capability: null,
      reason: "gh api graphql query",
    };
  if (scan.options.some((option) => API_BODY_OPTIONS.includes(option.name)))
    return {
      operation: "admin",
      capability: "admin",
      reason: "gh api with a request body",
    };
  const methods = scan.options
    .filter((option) => option.name === "-X" || option.name === "--method")
    .map((option) => option.value);
  const method = methods.length > 0 ? methods[methods.length - 1] : null;
  if (method === null)
    return { operation: "read", capability: null, reason: "gh api read" };
  const upper = method.toUpperCase();
  if (upper === "GET" || upper === "HEAD")
    return { operation: "read", capability: null, reason: `gh api ${upper}` };
  return {
    operation: "admin",
    capability: "admin",
    reason: `gh api method ${upper} is a conservative write`,
  };
}

// A read-only `gh api graphql`: the endpoint is exactly `graphql`, the method is absent or POST,
// there is no `--input`, exactly one query field is given, and no other field reads a file. Every
// field value -- the query, the variables, and an `operationName` -- must be provably literal
// text: a value the shell would expand (`$MUT`, `$(cat q.graphql)`, a backtick substitution, an
// ANSI-C `$'...'` word) is read by the observer as the text it can see, which is not the document
// gh sends, so it stays the conservative write. The scan must be trusted, or an unmodeled option
// could be hiding a body. Every condition fails closed: a command that misses one is classified
// by the generic body rule above.
/**
 * @param {{ options: Array<{ name: string, value: string | null }>, positionals: string[], strict: boolean }} scan
 * @returns {boolean}
 */
function graphqlRead(scan) {
  if (scan.strict !== true) return false;
  if (scan.positionals.length !== 1 || scan.positionals[0] !== "graphql")
    return false;
  if (scan.options.some((option) => option.name === "--input")) return false;
  const methods = scan.options
    .filter((option) => option.name === "-X" || option.name === "--method")
    .map((option) => option.value ?? "");
  const method = methods.length > 0 ? methods[methods.length - 1] : null;
  if (method !== null && method.toUpperCase() !== "POST") return false;
  const fields = scan.options
    .filter((option) => API_FIELD_OPTIONS.has(option.name))
    .map(fieldValue);
  if (fields.some((field) => field === null)) return false;
  const queries = fields.filter((field) => field?.key === "query");
  if (queries.length !== 1) return false;
  const query = queries[0];
  if (query === undefined) return false;
  return !GRAPHQL_WRITE_TOKENS.test(query.text);
}

// One `-f`/`-F` field as the key and the text gh sends. A typed `-F` field reads a file when its
// value starts with `@`, so that value is unknown to this observer and returns null; a value
// without a `=` is not a field gh accepts; a value the shell would expand is not the text gh
// sends and also returns null. The key is everything before the first `=`, matching gh's split.
/**
 * @param {{ name: string, value: string | null, literal?: boolean }} option
 * @returns {{ key: string, text: string } | null}
 */
function fieldValue(option) {
  if (option.value === null) return null;
  if (option.literal !== true) return null;
  const equals = option.value.indexOf("=");
  if (equals === -1) return null;
  const text = option.value.slice(equals + 1);
  if (
    (option.name === "-F" || option.name === "--field") &&
    text.startsWith("@")
  )
    return null;
  return { key: option.value.slice(0, equals), text };
}

// The -R/--repo argument, wherever it appears (a gh global flag or a command flag), with how
// many times it was given. More than one is ambiguous rather than a guess; the value is the
// last one, which is the one gh uses. Only occurrences the grammar read as the option count: a
// `-R`-looking value of another option is not in the list.
/**
 * @param {Array<{ name: string, value: string | null }>} options
 * @returns {{ value: string | null, count: number } | null}
 */
function ghRepoArgument(options) {
  const found = options.filter(
    (option) => option.name === "-R" || option.name === "--repo",
  );
  if (found.length === 0) return null;
  return { value: found[found.length - 1].value, count: found.length };
}

// `gh repo delete <owner>/<repo>` pins the target with its positional repository argument.
// A simultaneous -R target is ambiguous, so the caller treats it as unresolved.
/**
 * @param {string[]} words
 * @param {number} start
 * @param {string[]} positionals
 * @returns {{ value: string, count: 1 } | null}
 */
// The positional OWNER/REPO of the modeled gh repo verbs. An unparsed URL-like positional is
// retained as explicit unresolved input so no verb falls back to the current repository.
function ghRepoPositional(words, start, positionals) {
  if (words[start] !== "repo") return null;
  const verb = words[start + 1];
  if (
    ![
      "edit",
      "rename",
      "archive",
      "unarchive",
      "delete",
      "sync",
      "fork",
      "view",
      "clone",
    ].includes(verb)
  )
    return null;
  const value = positionals[0] === verb ? positionals[1] : positionals[0];
  const identity = value
    ? (parseRepoArgument(value) ?? parseGithubRepo(value))
    : null;
  if (
    !identity &&
    value &&
    (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ||
      /^[^/]+\/[^/]+\/.+/.test(value))
  )
    return { value: null, count: 1, unresolved: true };
  return identity
    ? { value: `${identity.owner}/${identity.repo}`, count: 1 }
    : null;
}

function apiReviewWrite(words, start) {
  if (
    words.slice(start + 1).some((word) => {
      const path = normalizedApiPath(word) ?? apiUrlPath(word);
      return path !== null && isReviewApiPath(path);
    })
  )
    return true;
  return /\bmutation\b[\s\S]*\b(?:addPullRequestReview|submitPullRequestReview|dismissPullRequestReview|addPullRequestReviewThread|addPullRequestReviewComment|updatePullRequestReview|updatePullRequestReviewComment|deletePullRequestReview|deletePullRequestReviewComment|resolveReviewThread|unresolveReviewThread)\b/i.test(
    words.slice(start + 1).join(" "),
  );
}

// Canonical-looking and ambiguous pull review paths are only used to deny a write. Decoding
// and slash collapsing here make no claim about GitHub's router; uncertainty under a pull
// route is treated as forbidden rather than granted as ordinary administration.
function isReviewApiPath(path) {
  const isReviewRoute = (value) =>
    /^\/?repos\/[^/]+\/[^/]+\/pulls\/(?:\d+\/(?:reviews|comments)(?:\/|$)|comments\/\d+(?:\/|$))/i.test(
      value,
    );
  if (isReviewRoute(path)) return true;
  if (!/\/pulls?(?:\/|%2f)|%|\/\//i.test(path)) return false;
  try {
    const decoded = decodeURIComponent(path).replace(/\/{2,}/g, "/");
    if (isReviewRoute(decoded)) return true;
    return /\/pulls?(?:\/|$)/i.test(decoded);
  } catch {
    return /\/pulls?(?:\/|%2f)/i.test(path);
  }
}

/**
 * @param {{ positionals: string[] } | null} repoSync
 * @param {{ value: string | null, count: number } | null} repoOption
 * @param {{ value: string, count: 1 } | null} repoPositional
 * @returns {{ value: string | null, count: number } | null}
 */
function ghDestinationArgument(repoSync, repoOption, repoPositional) {
  if (repoSync && repoSync.positionals.length > 0)
    return { value: repoSync.positionals[0], count: 1 };
  if (repoOption && repoPositional) return { value: null, count: 2 };
  return repoOption ?? repoPositional;
}

// Which repository a gh command reaches: the explicit -R/--repo, or the clone's own
// destination when git names exactly one. gh resolves a missing -R through the API (a fork's
// pull request targets its parent by default), so a clone with more than one github
// destination is ambiguous and a governed write fails closed. That is why the org's own
// working agreements say to always pass `-R <owner>/<repo>`. A read the grammar could not trust
// does not fall back to the clone: an option value could have been mistaken for a flag, so the
// destination is unresolved rather than guessed.
/**
 * @param {{ value: string | null, count: number } | null} repo
 * @param {boolean} strict
 * @param {((args: string[]) => string | null) | null} read
 * @param {{ cwd: string | null }} context
 * @returns {{ destination: import("./observation.mjs").Destination | null, resolved: boolean, source: import("./observation.mjs").Observation["destinationSource"] }}
 */
function ghDestination(repo, strict, read, context) {
  if (repo) {
    if (repo.count > 1)
      return { destination: null, resolved: false, source: "explicit" };
    const parsed = repo.value === null ? null : parseRepoArgument(repo.value);
    return {
      destination: parsed,
      resolved: parsed !== null,
      source: "explicit",
    };
  }
  if (!strict) return { destination: null, resolved: false, source: "none" };
  if (!context.cwd || !read)
    return { destination: null, resolved: false, source: "cwd" };
  const found = cwdDestinations(read);
  if (found.length === 1)
    return { destination: found[0], resolved: true, source: "cwd" };
  return { destination: null, resolved: false, source: "cwd" };
}

// Every distinct github destination the clone's remotes name. More than one is ambiguous.
/**
 * @param {(args: string[]) => string | null} read
 * @returns {import("./observation.mjs").Destination[]}
 */
function cwdDestinations(read) {
  const found = new Map();
  for (const name of remoteNames(read)) {
    const urls = new Set([
      ...remotePushUrls(read, name),
      remoteFetchUrl(read, name),
    ]);
    for (const url of urls) {
      if (!url) continue;
      const parsed = parseGithubRepo(url);
      if (parsed) found.set(identityKey(parsed), parsed);
    }
  }
  return [...found.values()];
}

// A `gh pr <verb> <number>|<url>|<branch>` positional that names a GitHub pull request or issue
// URL, as the identity it names, or null for a positional this observer does not read as one.
const OBSERVED_TARGET_URL =
  /^https?:\/\/(?:www\.)?github\.com\/([^/?#\s]+)\/([^/?#\s]+)\/(?:pull|issues)\/\d+(?:[/?#].*)?$/i;

/**
 * @param {string} value
 * @returns {{ host: string, owner: string, repo: string } | null}
 */
function targetUrlIdentity(value) {
  const match = OBSERVED_TARGET_URL.exec(value);
  if (!match) return null;
  return { host: "github.com", owner: match[1], repo: match[2] };
}

// A GitHub PR or issue URL positional pins the repository that command targets.
/**
 * @param {string | undefined} group
 * @param {string[]} positionals
 * @returns {{ value: string, count: 1 } | null}
 */
function ghTargetUrl(group, positionals) {
  const supported = group === "pr" || group === "issue";
  if (!supported) return null;
  const target = positionals.find((positional) =>
    targetUrlIdentity(positional),
  );
  if (!target) return null;
  const identity = targetUrlIdentity(target);
  return identity
    ? { value: `${identity.owner}/${identity.repo}`, count: 1 }
    : null;
}

function apiEndpointTarget(scan, isWrite) {
  const endpoint = scan.positionals[0];
  if (endpoint === undefined) return { present: false, destination: null };
  const literal = scan.positionalsLiteral?.[0] === true;
  const normalized = normalizedApiPath(endpoint);
  if (normalized === null && /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(endpoint))
    return { present: isWrite, destination: null };
  const route = normalized ?? endpoint;
  const match = /^\/?repos\/([^/]+)\/([^/]+)(?:\/|$)/.exec(route);
  const repositoryEndpoint = /^\/?repos(?:\/|$)/.test(route);
  if (!repositoryEndpoint && literal)
    return { present: false, destination: null };
  const destination =
    literal && match ? parseRepoArgument(`${match[1]}/${match[2]}`) : null;
  if ((repositoryEndpoint || !literal) && isWrite && !destination)
    return { present: true, destination: null };
  if (!repositoryEndpoint && !literal && !isWrite)
    return { present: false, destination: null };
  return { present: repositoryEndpoint, destination };
}

function normalizedApiPath(endpoint) {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(endpoint))
    return endpoint.replace(/[?#].*$/, "");
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "api.github.com" ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    return url.pathname;
  } catch {
    return null;
  }
}

function apiUrlPath(endpoint) {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(endpoint)) return null;
  try {
    return new URL(endpoint).pathname;
  } catch {
    return null;
  }
}

// The pull request sides, from --base/-B and --head/-H. Only `pr create` reads them; an
// owner-qualified side that names an owner without a repository is kept owner-qualified so the
// resolver's same-repository test denies it. Two different values for one side are ambiguous:
// the conflict flag makes the observation unresolved rather than letting the first value stand
// for a side the command does not reach.
/**
 * @param {Array<{ name: string, value: string | null }>} options
 * @returns {{ base: import("./observation.mjs").ObservedSide | null, head: import("./observation.mjs").ObservedSide | null, conflict: boolean }}
 */
function pullRequestSides(options) {
  const base = sideValue(options, "-B", "--base");
  const head = sideValue(options, "-H", "--head");
  return {
    base: base.value === null ? null : sideOf(base.value),
    head: head.value === null ? null : sideOf(head.value),
    conflict: base.conflict || head.conflict,
  };
}

// One side's value: null when the option is absent, the single value when it is given once or
// with the same value, and a conflict when it is given two different values.
/**
 * @param {Array<{ name: string, value: string | null }>} options
 * @param {string} short
 * @param {string} long
 * @returns {{ value: string | null, conflict: boolean }}
 */
function sideValue(options, short, long) {
  const values = options
    .filter((option) => option.name === short || option.name === long)
    .map((option) => option.value)
    .filter((value) => value !== null);
  const distinct = [...new Set(values)];
  if (distinct.length === 0) return { value: null, conflict: false };
  if (distinct.length > 1) return { value: null, conflict: true };
  return { value: distinct[0], conflict: false };
}

/**
 * @param {string} value
 * @returns {import("./observation.mjs").ObservedSide | null}
 */
function sideOf(value) {
  if (value === null || value.length === 0) return null;
  const withRepo = /^([^/:\s]+)\/([^:\s]+):(.+)$/.exec(value);
  if (withRepo)
    return { owner: withRepo[1], repo: withRepo[2], branch: withRepo[3] };
  const ownerOnly = /^([^/:\s]+):(.+)$/.exec(value);
  if (ownerOnly)
    return { owner: ownerOnly[1], repo: null, branch: ownerOnly[2] };
  return { owner: null, repo: null, branch: value };
}
