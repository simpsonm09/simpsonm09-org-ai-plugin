// The `git` half of the command observer: the alias check and the whole `git push`
// observation. It reads git state through the injected read-only reader (lib/gitstate.mjs) and
// returns the shared Observation shape (lib/observation.mjs). It is pure: the same words and
// the same git state always give the same observation. The git global options and the push
// flag grammar live in lib/gitflags.mjs, and the refspec reading in lib/gitrefspec.mjs.
//
// Bounded forms only, and the bounds are the contract:
//   - `git` global options are `-C <path>` and `-c <key>=<value>` (passed through to every
//     read). Any other global option is `unsupported`.
//   - `git push` flags and value flags are the documented set from `git push -h`; an
//     unmodeled flag is `unsupported`.
//   - `--no-verify` is parsed as an ordinary flag. It is not a reason to stop observing:
//     the observation happens before the command runs and the hook cannot be skipped by it.

import {
  commandDirectory,
  gitGlobalOptions,
  hasBulk,
  hasForce,
  parsePushArguments,
} from "./gitflags.mjs";
import {
  implicitRefspecs,
  pushCapability,
  refspecRefs,
} from "./gitrefspec.mjs";
import {
  commandReader,
  configValue,
  currentBranch,
  defaultBranchName,
  identityKey,
  parseGithubRepo,
  remoteFetchUrl,
  remoteNames,
  remotePushUrls,
} from "./gitstate.mjs";
import {
  localObservation,
  readObservation,
  unsupported,
  writeObservation,
} from "./observation.mjs";

/**
 * One `git` command, classified. Only `push` is observed; every other subcommand is local.
 * @param {string[]} words the tokens after the `git` program word
 * @param {{ shell: "bash" | "powershell", cwd: string | null, memo: ((args: string[]) => string | null) | null }} context
 * @returns {import("./observation.mjs").Observation}
 */
export function classifyGit(words, context) {
  const globals = gitGlobalOptions(words);
  if (!globals)
    return unsupported("a git global option this observer does not model");
  if (globals.printOnly)
    return localObservation("a git option that only prints");
  if (globals.subcommand === undefined)
    return localObservation("a git command with no subcommand");
  const alias = governedAlias(
    commandReader(context, globals.globalArgs),
    globals.subcommand,
  );
  if (alias) return unsupported(alias.reason);
  if (["clone", "fetch", "pull", "ls-remote"].includes(globals.subcommand))
    return observeGitRead(
      globals.subcommand,
      globals.options,
      globals.globalArgs,
      context,
    );
  if (globals.subcommand !== "push")
    return localObservation(`the local git command "${globals.subcommand}"`);
  if (globals.options.includes("-h") || globals.options.includes("--help"))
    return localObservation("the git push help text");
  return observePush(globals.options, globals.globalArgs, context);
}

// Resolve the single GitHub destination of common read commands. A form that can read several
// remotes (or whose options obscure the remote) remains unsupported so it cannot bypass an
// explicit ignore entry through the public-read path.
function observeGitRead(subcommand, tokens, globalArgs, context) {
  const parsed = readPositionals(subcommand, tokens);
  if (!parsed) return unsupported(`an unmodeled git ${subcommand} read form`);
  const read = commandReader(context, globalArgs);
  if (!read)
    return {
      ...unsupported(
        `git ${subcommand} cannot resolve its remote without the git reader`,
      ),
      readOnly: true,
    };
  const target = gitReadTarget(subcommand, parsed.positionals, read);
  if (target.invalid)
    return {
      ...unsupported(`an unresolved git ${subcommand} destination`),
      readOnly: true,
    };
  const destination = target.url ? parseGithubRepo(target.url) : null;
  if (destination === null && target.url && isAmbiguousGithubUrl(target.url))
    return {
      ...unsupported(`an ambiguous git ${subcommand} URL destination`),
      readOnly: true,
    };
  return {
    ...readObservation("git", `a single-destination git ${subcommand} read`),
    ...(destination
      ? { destination: { host: "github.com", ...destination } }
      : {}),
    ...(destination ? { destinationSource: target.source } : {}),
    resolved: destination !== null,
  };
}

// These strings are deliberately not normalized into a repository identity. They mark URL
// forms that may be interpreted differently by downstream URL handling, so the read fails
// closed at the observer boundary without asserting how any remote resolves them.
function isAmbiguousGithubUrl(value) {
  return (
    /(?:^|[/:@])github\.com\.?(?=[:/?#]|$)/i.test(value) ||
    /\/\.\.?\/|%/i.test(value)
  );
}

function gitReadTarget(subcommand, positionals, read) {
  if (subcommand === "clone")
    return rewrittenUrlTarget(positionals[0] ?? null, read);
  const remotes = remoteNames(read);
  const first = positionals[0] ?? null;
  if (first && isUrlLike(first)) return rewrittenUrlTarget(first, read);
  const remote = first ?? (remotes.length === 1 ? remotes[0] : null);
  if (!remote) return { url: null, source: "remote", invalid: true };
  const url = remoteFetchUrl(read, remote);
  if (!url) return { url: null, source: "remote", invalid: true };
  return {
    url,
    source: "remote",
  };
}

function rewrittenUrlTarget(url, read) {
  if (!url || !isUrlLike(url)) return { url, source: "url" };
  // This read-only Git command applies insteadOf rules without contacting the remote.
  // `read` is bound to the command's own -c and -C options.
  const rewritten = read(["ls-remote", "--get-url", url]);
  return rewritten
    ? { url: rewritten, source: "url" }
    : { url: null, source: "url", invalid: true };
}

const GIT_READ_VALUE_OPTIONS = new Set([
  "-o",
  "--origin",
  "-b",
  "--branch",
  "--depth",
  "--filter",
  "--upload-pack",
  "--server-option",
  "--refmap",
  "--negotiation-tip",
]);
const GIT_READ_FLAGS = new Set([
  "--all",
  "--prune",
  "--tags",
  "--no-tags",
  "--force",
  "--keep",
  "--dry-run",
  "--atomic",
  "--quiet",
  "-q",
  "--verbose",
  "-v",
  "--progress",
  "--no-recurse-submodules",
  "--update-head-ok",
  "--allow-unrelated-histories",
  "--ff",
  "--ff-only",
  "--rebase",
  "--no-rebase",
  "--squash",
  "--recurse-submodules",
  "--unshallow",
  "--universe",
]);
const GIT_READ_OPTIONAL_VALUE_OPTIONS = new Set(["--recurse-submodules"]);

function readPositionals(subcommand, tokens) {
  const positionals = [];
  let options = true;
  for (let index = 0; index < tokens.length; index += 1) {
    const step = readPositionToken(subcommand, tokens, index, options);
    if (!step) return null;
    options = step.options;
    if (step.positional !== null) positionals.push(step.positional);
    index += step.skip;
  }
  if (!validReadPositionals(subcommand, positionals.length)) return null;
  return { positionals };
}

function readPositionToken(subcommand, tokens, index, options) {
  const token = tokens[index];
  if (options && token === "--")
    return { options: false, positional: null, skip: 0 };
  if (!options || !token.startsWith("-"))
    return { options, positional: token, skip: 0 };
  const kind = readOptionKind(token, tokens[index + 1], subcommand);
  if (!kind) return null;
  return { options, positional: null, skip: kind === "value" ? 1 : 0 };
}

function readOptionKind(token, next, subcommand) {
  if (
    [...GIT_READ_OPTIONAL_VALUE_OPTIONS].some((option) =>
      token.startsWith(`${option}=`),
    )
  )
    return "flag";
  if (
    [...GIT_READ_VALUE_OPTIONS].some((option) => token.startsWith(`${option}=`))
  )
    return "flag";
  if (GIT_READ_VALUE_OPTIONS.has(token))
    return next === undefined ? null : "value";
  if (
    !GIT_READ_FLAGS.has(token) ||
    (subcommand === "fetch" && token === "--all")
  )
    return null;
  return "flag";
}

function validReadPositionals(subcommand, count) {
  if (subcommand === "clone") return count >= 1 && count <= 2;
  return count <= (subcommand === "pull" ? 2 : 3);
}

// A git alias can stand in for a write, and the alias name says nothing about it. A shell
// alias (`!…`) is outside this observer entirely, and an alias whose expansion starts with
// `push` (including one that shadows the built-in) is a governed write this observer does not
// resolve, so both are `unsupported`. Any other alias is `local`, and an alias chain or a
// variable-built alias is not resolved, which is a documented limit rather than a claim.
/**
 * @param {((args: string[]) => string | null) | null} read
 * @param {string | undefined} subcommand
 * @returns {{ alias: string, reason: string } | null}
 */
export function governedAlias(read, subcommand) {
  if (!read || subcommand === undefined) return null;
  const alias = configValue(read, `alias.${subcommand}`);
  if (!alias) return null;
  const first = alias.trim().split(/\s+/)[0] ?? "";
  if (!alias.trimStart().startsWith("!") && first !== "push") return null;
  return {
    alias,
    reason: `the git alias "${subcommand}" stands for a governed write this observer does not resolve`,
  };
}

// The whole `git push` observation: the destination from git's own push configuration, and
// the refs from the refspecs (or, when there are none, from `remote.<r>.push`, then
// push.default, then the current branch).
/**
 * @param {string[]} tokens
 * @param {string[]} globalArgs
 * @param {{ shell: "bash" | "powershell", cwd: string | null, memo: ((args: string[]) => string | null) | null }} context
 * @returns {import("./observation.mjs").Observation}
 */
function observePush(tokens, globalArgs, context) {
  const parsed = parsePushArguments(tokens);
  if (!parsed)
    return unsupported("a git push option this observer does not model");
  const read = commandReader(context, globalArgs);
  const bulk = hasBulk(parsed.flags);
  const deleting = parsed.flags.has("-d") || parsed.flags.has("--delete");
  const destination = pushDestination(parsed, read);
  const implicit =
    destination.defaultRefspecs && destination.refspecs.length === 0
      ? implicitRefspecs(read, destination.remoteName)
      : null;
  const force =
    hasForce(parsed.flags) ||
    destination.refspecs.some((spec) => spec.startsWith("+")) ||
    implicit?.force === true;
  const defaultName = destination.destination
    ? defaultBranchFor(read, destination.destination)
    : null;
  const refs = implicit
    ? implicit.refs(defaultName)
    : refspecRefs(destination.refspecs, read, { defaultName });
  const effectiveBulk = bulk || implicit?.bulk === true;
  const capability = pushCapability(effectiveBulk, refs);
  const refsResolved =
    refs.length > 0
      ? refs.every((ref) => ref.kind !== "unknown")
      : effectiveBulk;
  const resolved =
    destination.resolved && refsResolved && implicit?.none !== true;

  return writeObservation({
    program: "git",
    operation: "push",
    capability,
    resolved,
    destination: destination.destination,
    destinationSource: destination.source,
    refs,
    force,
    delete: deleting || parsed.deleteRefspec,
    // The directory the command's own `-C` options named, so the caller can resolve the
    // destination's local repository there too — the git state it sent already came from it.
    commandDirectory: commandDirectory(globalArgs, context.cwd),
    reason: pushReason(capability, destination, refs),
  });
}

// Which repository a push reaches, how it was learned, and which tokens are its refspecs.
// git's grammar is `git push [<repository> [<refspec>…]]`: the first positional is always the
// repository, so it is a refspec only after a repository token is taken. A named remote is
// resolved through its push URL list (pushurl when set, every one of them), never through a
// remote *name*. `defaultRefspecs` is true only when the command named a repository git can
// actually push to, which is what lets `remote.<r>.push` and `push.default` fill in the refs;
// an unknown repository has none.
/**
 * @param {{ repoArgument: string | null, positionals: string[] }} parsed
 * @param {((args: string[]) => string | null) | null} read
 * @returns {{
 *   destination: import("./observation.mjs").Destination | null,
 *   resolved: boolean,
 *   source: import("./observation.mjs").Observation["destinationSource"],
 *   remoteName: string | null,
 *   refspecs: string[],
 *   defaultRefspecs: boolean,
 * }}
 */
function pushDestination(parsed, read) {
  const unresolved = (remoteName, refspecs, defaultRefspecs = false) => ({
    destination: null,
    resolved: false,
    source: /** @type {const} */ ("none"),
    remoteName,
    refspecs,
    defaultRefspecs,
  });

  let remoteToken = parsed.repoArgument;
  let refspecs = parsed.positionals;
  if (remoteToken === null && refspecs.length > 0) {
    remoteToken = refspecs[0];
    refspecs = refspecs.slice(1);
    // A token that is neither URL-like nor a configured remote is an unknown repository,
    // not a refspec on the default remote: git reads it as a path or refuses it, and
    // neither is a GitHub push this observer can name. Treating it as a refspec would
    // report a destination and a branch the command never reaches.
    if (!isUrlLike(remoteToken) && !namesRemote(read, remoteToken))
      return unresolved(null, refspecs);
  }
  if (remoteToken === null) {
    const name = read ? defaultPushRemote(read) : null;
    if (name === null) return unresolved(null, refspecs);
    return {
      ...remoteDestination(read, name),
      source: "git-default",
      remoteName: name,
      refspecs,
      defaultRefspecs: true,
    };
  }
  if (isUrlLike(remoteToken)) {
    const parsedUrl = parseGithubRepo(remoteToken);
    return {
      destination: parsedUrl,
      resolved: parsedUrl !== null,
      source: "url",
      remoteName: remoteNameForDestination(read, parsedUrl),
      refspecs,
      defaultRefspecs: true,
    };
  }
  if (!read) return unresolved(remoteToken, refspecs);
  return {
    ...remoteDestination(read, remoteToken),
    remoteName: remoteToken,
    refspecs,
    defaultRefspecs: true,
  };
}

// The destination a named remote reaches: every push URL it has, as github identities. More
// than one distinct identity, or a URL this observer cannot parse, leaves the destination
// unresolved so a governed write fails closed.
/**
 * @param {((args: string[]) => string | null) | null} read
 * @param {string} name
 * @returns {{ destination: import("./observation.mjs").Destination | null, resolved: boolean, source: import("./observation.mjs").Observation["destinationSource"] }}
 */
function remoteDestination(read, name) {
  if (!read) return { destination: null, resolved: false, source: "remote" };
  const urls = remotePushUrls(read, name);
  if (urls.length === 0)
    return { destination: null, resolved: false, source: "remote" };
  const identities = urls.map(parseGithubRepo);
  if (identities.some((identity) => identity === null))
    return { destination: null, resolved: false, source: "remote" };
  const distinct = new Map(
    identities.map((identity) => [identityKey(identity), identity]),
  );
  if (distinct.size !== 1)
    return { destination: null, resolved: false, source: "pushurl" };
  const fetch = remoteFetchUrl(read, name);
  const source = fetch && fetch !== urls[0] ? "pushurl" : "remote";
  return { destination: [...distinct.values()][0], resolved: true, source };
}

// git's documented default push remote: branch.<b>.pushRemote, then remote.pushDefault, then
// branch.<b>.remote, then origin. (Verified against git 2.55 with `git push --dry-run` in a
// controlled repo: the branch's pushRemote wins over remote.pushDefault, which wins over
// branch.<b>.remote, which wins over origin.)
/**
 * @param {(args: string[]) => string | null} read
 * @returns {string | null}
 */
function defaultPushRemote(read) {
  const branch = currentBranch(read);
  if (branch) {
    const pushRemote = configValue(read, `branch.${branch}.pushRemote`);
    if (pushRemote) return pushRemote;
  }
  const pushDefault = configValue(read, "remote.pushDefault");
  if (pushDefault) return pushDefault;
  if (branch) {
    const remote = configValue(read, `branch.${branch}.remote`);
    if (remote) return remote;
  }
  return "origin";
}

// The branch the remote's HEAD points at, found through a remote that reaches the
// destination. A push to an explicit URL still resolves its default branch when that URL is
// also a configured remote. The remote-tracking symbolic ref is the only local evidence, and
// an unset one leaves the default branch unresolved.
/**
 * @param {((args: string[]) => string | null) | null} read
 * @param {import("./observation.mjs").Destination} destination
 * @returns {string | null}
 */
function defaultBranchFor(read, destination) {
  const name = remoteNameForDestination(read, destination);
  return name === null ? null : defaultBranchName(read, name);
}

// The first configured remote whose push or fetch URL reaches the destination, or null.
/**
 * @param {((args: string[]) => string | null) | null} read
 * @param {import("./observation.mjs").Destination | null} destination
 * @returns {string | null}
 */
function remoteNameForDestination(read, destination) {
  if (!read || !destination) return null;
  const key = identityKey(destination);
  for (const name of remoteNames(read)) {
    const urls = [
      ...remotePushUrls(read, name),
      remoteFetchUrl(read, name),
    ].filter(Boolean);
    const reaches = urls.some((url) => {
      const parsed = parseGithubRepo(url);
      return parsed !== null && identityKey(parsed) === key;
    });
    if (reaches) return name;
  }
  return null;
}

/**
 * @param {string} capability
 * @param {{ destination: import("./observation.mjs").Destination | null, source: string }} destination
 * @param {import("./observation.mjs").ObservedRef[]} refs
 * @returns {string}
 */
function pushReason(capability, destination, refs) {
  const target = destination.destination
    ? `${destination.destination.owner}/${destination.destination.repo}`
    : "an unresolved destination";
  const names =
    refs.map((ref) => `${ref.kind}:${ref.name}`).join(", ") || "no named ref";
  return `a push to ${target} (${destination.source}) needing ${capability} for ${names}`;
}

// Whether a token is a URL git could reach, rather than a remote name or a local path.
/**
 * @param {string} word
 * @returns {boolean}
 */
function isUrlLike(word) {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(word)) return true;
  return /^(?:[^@/]+@)?[A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+:/.test(word);
}

/**
 * @param {((args: string[]) => string | null) | null} read
 * @param {string} candidate
 * @returns {boolean}
 */
function namesRemote(read, candidate) {
  if (!read) return false;
  const wanted = candidate.toLowerCase();
  return remoteNames(read).some((name) => name.toLowerCase() === wanted);
}
