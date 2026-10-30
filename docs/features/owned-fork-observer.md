# The command observer

The command observer answers one question for one shell command: what is this command, and
which repository does it reach? It is the layer the agent-access gate moves onto so a
decision can name a destination and a ref instead of scanning the command text for `gh` or
`git push`.

`lib/intent.mjs` is the dispatcher. It reads the shell words, decides which program the
command runs, and routes it to two domain parsers: the `git push` domain (`lib/gitpush.mjs`,
over `lib/gitflags.mjs` for the git global options and the push flag grammar and
`lib/gitrefspec.mjs` for the refspec reading) and the `gh` domain (`lib/ghcommand.mjs`, over
`lib/ghoptions.mjs` for the option tables and `lib/ghargv.mjs` for the argument reader).
`lib/shellscan.mjs` cuts the command text into commands and reads heredoc bodies, over the
lexical forms in `lib/shelllex.mjs`. `lib/observation.mjs` is the
normalized observation both return, and `lib/gitstate.mjs` is the only module that touches
git: it supplies the read-only reader (`(args) => stdout or null`) over the real `git` with
argument arrays, so nothing from a command is ever interpolated into a shell string. The
parser is pure: the command text, the tool's working directory, the shell dialect, and that
reader decide the observation. `access.mjs` exposes it as
`observeShellCommand(cwd, command, options)`.

This module is the observer the gate decides from. `gate.mjs` calls it once per command with the
tool's working directory, a read-only git port, and the environment snapshot, then sends the
destination and the structured intent to the pinned resolver (`runtime/agent-access.mjs`)
through `access.mjs`. The OpenCode plugin, the Claude/Copilot/Pi hooks, and the token launcher all
reach the same decision.

## The observation

### Policy-level GitHub command mapping

The observer maps pull request create, edit, close, reopen, ready/draft changes, issue create,
and issue/PR conversation comments to `openPr`. Positional `gh repo view` and `gh repo clone`
targets, including GitHub URL aliases, identify the requested repository; a clone's local
destination directory is not treated as a repository identity. A positional `gh repo fork`
source is checked as the policy destination. Compound commands observe supported read segments
individually and carry every named destination to the ignore check. An ignored target denies
the compound; an unmodeled or unresolved read segment fails closed. A compound that changes
directories with `cd`, `chdir`, `pushd`, `popd`, `Set-Location`, `sl`, `Push-Location`, or
`Pop-Location` and also reads is unsupported: the observer does not emulate shell directory
stack and path rules. Local-only compounds keep their existing pass behavior.
Milestone create/edit/delete are repository administration. Pull request review submissions
(`approve`, `request-changes`, or review-comment submissions) are marked `forbidden`; review REST and
GraphQL writes use the same never-granted capability. This mapping controls supported
`gh` command forms only; it does not grant access to browser, file, MCP, or arbitrary script
paths.

Repository reads remain public unless the destination is in the committed explicit ignore
list. Supported destination-bearing `gh` and Git reads consult that list before local,
unknown-repository, or public-read returns, including supported compound reads. Malformed
compound reads and unmodeled Git read forms fail closed. If the resolver cannot load the
committed ignore policy, the read fails closed. The API 5 consumer uses
`loadCommittedIgnore` and passes its validated result into `resolveDestination`. The runtime
and pin now match published API 5.

The API 5 source matches published resolver commit
`c036a58763dec27e597871abff9ae9804f2c3f3a`. This local source proposal does not install or
activate the artifact in a workspace.

```js
{
  kind,              // 'local' | 'read' | 'write' | 'unsupported' | 'ambiguous'
  program,           // 'git' | 'gh' | 'other'
  operation,         // 'none' | 'read' | 'push' | 'openPr' | 'mergePr' | 'admin' | 'unknown'
  capability,        // 'pushBranch' | 'pushMain' | 'openPr' | 'mergePr' | 'admin' | null
  readOnly,          // internal signal; unsupported compounds can carry a readlike segment
  resolved,          // the destination and the refs are pinned
  destination,       // { host, owner, repo } | null
  destinationReads,  // every supported destination-bearing read inside a compound command
  destinationSource, // 'explicit' | 'remote' | 'pushurl' | 'url' | 'git-default' | 'cwd' | 'none'
  refs,              // [{ kind: 'branch'|'tag'|'other'|'unknown', name, isDefault }]
  force, delete,     // the push flags that change what a refspec means
  base, head,        // the pull request sides, each { owner, repo, branch }
  environment,       // the destination-changing variable *names* set in the process environment
  reason,
}
```

`toResolverIntent(observation)` returns only the fields `decideTarget` validates, and
`observationDestination(observation)` returns `{ host, destination }`. The caller passes the
destination and the intent to the pinned resolver. A governed write whose `destination` is
null is denied by the caller before the resolver runs: a missing destination is not "no
repository" but "unknown repository".

## What the destination comes from

The destination is derived from git, never from a remote *name*:

- `git push <remote>`: `git remote get-url --push --all <remote>`. A `pushurl` differs from
  the fetch URL, and multiple URLs are all read. More than one distinct identity, or a URL
  that is not a GitHub identity, leaves the destination unresolved.
- `git push` with no positional and no `--repo`: `branch.<b>.pushRemote`, then
  `remote.pushDefault`, then `branch.<b>.remote`, then `origin`. That is git's own
  precedence, verified against git 2.55 with a controlled `git push --dry-run`: the
  branch's `pushRemote` wins over `remote.pushDefault`, which wins over `branch.<b>.remote`,
  which wins over `origin`.
- `git push <url>`: the URL itself.
- `gh <command> -R owner/repo` (or the global `-R`): the argument.
- `gh <command>` with no `-R`: the clone's own destination, and only when git names exactly
  one GitHub destination across all remotes. gh resolves a missing `-R` through the API, and a
  fork's pull request targets its parent by default, so more than one destination is
  `ambiguous` and a governed write fails closed. The denial says the destination is ambiguous
  and asks for `-R owner/repo`; it does not claim the repository is unknown. A real fleet clone
  has two remotes (`origin` = the personal fork, `upstream` = the organization repository), so
  the organization's working agreements require `-R <owner>/<repo>` for this reason.
- `gh pr <verb> <number>|<url>|<branch>`: a github.com pull request or issue URL names the
  repository it belongs to. When that repository is not the resolved destination
  (case-insensitively), the destination is dropped and a governed write fails closed; a URL
  to the destination itself, a number, and a branch leave the destination unchanged.

Destination-bearing Git reads are also observed for `git clone <url>`, and for `git fetch`,
`git pull`, and `git ls-remote` when one URL or one configured remote identifies the target.
Configured remote aliases are resolved through read-only Git config. An explicit URL is
resolved with Git's read-only `ls-remote --get-url` mode, which applies the command's own
`url.*.insteadOf` rules without contacting the remote. An implicit fetch/pull requires exactly
one configured remote; `git fetch --all` and other multi-target forms are unsupported and fail
closed. These are bounded forms of the existing command observer, not a general Git option
parser or a universal command sandbox.

The refs come from the refspecs, which are the positionals *after* the repository. git's
grammar is `git push [<repository> [<refspec>…]]`, so the first positional is always the
repository: a first token that is neither a URL nor a configured remote is an unknown
repository, and the push stays unresolved rather than becoming a refspec on the default
remote (`git push feat/x` is a repository named `feat/x`, not a push of the branch `feat/x`
to `origin`).

The destination side of a `src:dst` form is the ref the remote writes; without a colon the
source name is the ref; a leading `+` is a force and a leading `:` is a deletion. An empty
destination (`src:`) is not a refspec git accepts — git 2.55 answers `fatal: invalid
refspec` to `git push origin feat/x:` (verified with a local `--dry-run` against a new bare
repository) — so it is never read as the source name and never as a deletion: it stays
unresolved, which denies it. A bare name and `HEAD` are resolved through `git show-ref` and
`git rev-parse`, and a name that is both a branch and a tag is `unknown` rather than a guess.
The default branch comes from the remote-tracking `refs/remotes/<remote>/HEAD`, so a
repository whose default branch is not `main` is handled.

`isDefault` is a tri-state. `true` is the resolved default branch; `false` is a resolved
non-default branch; `null` is a branch whose default branch could not be resolved. The
resolver's push rule requires exactly `false`, so `null` denies a governed branch push for
every destination that is not the organization. When the remote records no HEAD, a branch
named `main` or `master` is treated as the default, which can only deny a push and never allow
one, and keeps the organization's current behavior for a clone that git cannot answer for.

The capability is the resolver's own vocabulary: one non-default branch refspec is
`pushBranch`; the default branch, a tag, any other ref, a deletion, a force, and the
`--tags`/`--all`/`--branches`/`--mirror`/`--follow-tags`/`--prune`/`--delete` flags are
`pushMain`; `gh pr create` and `gh pr ready` are `openPr`, `gh pr merge` is `mergePr`, the
release, workflow, secret, and repository verbs and any `gh api` write are `admin`. `--prune`
belongs with the multi-ref flags because it deletes every remote ref of the pushed namespace
that has no local counterpart, which git documents as respecting the refspecs:
`git push origin --prune feat/x` is a `pushMain`, not the `pushBranch` its single refspec
would suggest.

## Supported forms

- `git push` with the documented flags and value flags from `git push -h`: a named remote, an
  explicit URL, `--repo`, no remote at all, one or more refspecs, `+src`, `:dst`, `HEAD`,
  `refs/heads/*`, `refs/tags/*`, a tag shorthand, `--delete`, `--tags`, `--all`, `--mirror`,
  `--follow-tags`, `--prune`, `--force`, `-f`, `--force-with-lease`, and `--no-verify`.
  `--no-verify` only skips git's own hook; the observation happens before the command runs.
  A first positional that is not a URL or a configured remote, and an empty-destination
  refspec (`src:`), are observed as unresolved rather than as a destination and a ref git
  would not reach.
- `git -C <path>` and `git -c <key>=<value>`, passed through to every Git read, so the
  observation follows the command's own directory and config, including URL rewrite rules.
  For `fetch`, `pull`, `clone`, and `ls-remote`, bare `--recurse-submodules` is a flag and
  `--recurse-submodules=<value>` is also supported. A cwd that is a worktree or a
  subdirectory of a clone observes as the clone.
- `remote.<name>.push` and `remote.<name>.mirror` for a push that names no refspec, then
  `push.default` (`matching` is a multi-ref write, `current` and `upstream` name one branch),
  then the current branch.
- `gh` with `-R`/`--repo` as a global flag or a command flag, in the `[HOST/]OWNER/REPO` form
  and in every spelling gh's own flag parser accepts (`-R value`, `-Rvalue`, `-R=value`,
  `--repo=value`); `gh pr create` with `--base`/`-B` and `--head`/`-H` (including the
  `owner:branch` form); the `pr create`, `pr ready` (with `--undo`), and `pr merge` verbs; the
  release, workflow, secret, and repository admin verbs; `gh api` with `-X`/`--method` in any
  spelling (the last method wins, as it does in gh); `gh api` body flags in any spelling
  (`-f value`, `-fvalue`, `-f=value`, `-F value`, `-Fvalue`, `-F=value`, `--field=value`,
  `--raw-field=value`, `--input=value`); and the read verbs (`list`, `view`, `status`, `diff`,
  `checks`, `show`, `watch`, `clone`, `checkout`, `download`, `browse`, `get`). One such
  read is `gh api graphql` when the endpoint is exactly `graphql`, the method is absent or
  `POST`, there is no `--input`, exactly one `query` field is a literal word, a typed `-F`
  field whose value starts with `@` reads a file and denies, every other field (the
  `variables` and `operationName` fields included) is also a literal word, and the document
  contains no `mutation` or `subscription` token. A literal word is one the shell hands over
  unchanged. In Bash, an unescaped `$` or backtick outside single quotes, or an unquoted `*`,
  `?`, `[`, or `{`, makes the field non-literal. This includes ANSI-C `$'...'` quoting. In
  PowerShell, `$` or a backtick inside double quotes also makes the field non-literal. The
  command then stays the conservative `admin` write instead of trusting text the observer
  cannot see. A real query keeps its `$var` references and `{owner}` placeholders inside
  single quotes, so it stays a read. One left-to-right read of the arguments decides which
  token is an option and which is its value: a value option consumes the next word, so
  `gh pr create --title -Rsimpsonm09-org/demo-repo` reads that word as the title, not as `-R`,
  and the destination falls back to the clone. An option the per-command table does not name
  makes the read untrustworthy, so the destination is unresolved rather than guessed.
- A heredoc body (`<<`, `<<-`, or a quoted, unquoted, or escaped delimiter) is data, not
  commands: the body is skipped to its terminator line, so a script or a document written
  through bash is not decided as the commands it contains. A quoted or escaped delimiter makes
  the body literal; an unquoted delimiter still expands command substitutions, so each `$(...)`
  and backtick pair in an unquoted body is read out and observed as the command it runs. A `<<`
  the observer cannot read safely (no delimiter, an unclosed quote, a dynamic `$`/backtick
  delimiter, a body with no terminator line, a substitution that is not closed) is
  `unsupported`, so it fails closed. Heredocs are the Bash form; a PowerShell here-string
  (`@"`…`"@`, `@'`…`'@`) is not a `<<` and is not modeled.

## Pinning an account for one command

The working agreements pin a GitHub account for a single command. Each supported form is one
command, which is what the observer reads:

- Bash, a leading assignment prefix:
  `GH_TOKEN="$(gh auth token --user <account>)" gh pr create -R <owner>/<repo> …`.
  The observer skips the leading `NAME=value` assignment while it finds the program word, so the
  command is observed as the `gh` write it runs. The observer never reads the value, and the
  account that runs `gh auth token` is the caller's own.
- Git, the credential helper, in either shell:
  `git -c credential.helper= -c 'credential.helper=!…' push https://github.com/<account>/<repo>.git <branch>`.
  It is one `git push` command with an explicit URL, so it is observed as that push.

PowerShell has no inline environment prefix, so `$env:GH_TOKEN = "…"; gh …` is two statements,
not one command. On PowerShell, pin through the git credential helper, which is one command, or
let the command run under the account's ambient login. The observer does not model a
multi-statement pin.

A multi-statement pin that combines an assignment and a write (`export GH_TOKEN=…; gh …`, or
`$env:GH_TOKEN = …; gh …`) is a compound command. A compound command that contains a governed
write is denied, because the observer reads a single command and does not decide the later
statements, and the denial names that shape. Choose one of the single-command forms above when
you compose the command. If the gate denies the command you wrote, the denial is final for that
command: do not re-run it through another shell, tool, wrapper, or identity.

## Forms that are not covered

These are guardrail limits, not claims of coverage. A form below is `local` (the program word is
not `git` or `gh`, so the command reaches nothing this policy governs), `unsupported` (a
governed write signal in a form the observer does not parse, which the caller denies for a
non-organization destination and treats conservatively for the organization), or state the
observer cannot read at all (a persistent environment variable, which keeps its own reading of
the repository).

- A wrapper or interpreter: `bash -c '…'`, `iex …`, `Start-Process …`, `xargs …`, an alias.
  These remain outside the observer's scope. The finite leading forms `command`, `env`,
  `time`, `exec`, and `nohup` followed by a `git` or `gh` program, plus Bash brace groups,
  subshells, negation, and the bounded `if`/`then`/`else`/`elif`/`for`/`do`/`while`/`until`
  forms containing a governed Git/GitHub command, are `unsupported` because the observer does
  not emulate their command, environment, or working-directory effects. Grouped Git/GitHub
  commands classified as local (such as `git status`) and other local-only groups remain local.
  Static assignment-only segments such as `X=1` remain local; assignments with shell expansion
  are unsupported. For the bounded dynamic-assignment form, the observer sets `ghWriteSignal`
  when the command text contains a `gh` program word, including a write inside `$(…)`; the gate
  denies that signal outside the fleet without resolving or evaluating the expression. An
  unsupported expanded assignment with no `gh` signal does not extend the outside-fleet Git
  policy and may pass outside the fleet. Other
  interpreters, aliases, scripts, and browser/file/MCP paths are not covered by this observer.
- A git alias: `git <name>` where `alias.<name>` is a shell alias (`!…`) or expands to
  `push` is `unsupported`, so it is not granted. Any other alias is read as the command its
  name is, and an alias chain or a variable-built alias is not resolved. A gh alias
  (`gh alias set`) is the same limit and is `local`.
- A compound command: an unquoted `;`, `&`, `|`, or newline splits the command. If any part
  looks like a governed write, the whole command is `unsupported`. Otherwise supported parts
  are observed so each named read destination reaches the ignore check. An unresolved or
  unsupported read part fails closed; a compound with only local commands stays `local`. Opaque
  grouped or prefixed parts aggregate readlike and GitHub-write signals across all segments.
  Here, `readOnly` is an internal signal: any recognized read or unsupported segment sets it,
  even when the overall compound also contains a write. This makes mixed write/read composites
  (including merge plus view) conservatively deny as unsupported reads. Single-command
  outside-fleet Git policy is unchanged; mixed commands containing a governed write and a read
  now conservatively deny, including Git-only push-plus-fetch compounds. A quoted mention of a
  write and a pipeline whose later stage only mentions one stay `local`.
  A heredoc body is not part of this split: it is skipped to its terminator line as data (see
  Supported forms), and only an unquoted body's command substitutions are read.
- A PowerShell here-string (`@"`…`"@`, `@'`…`'@`): a newline inside it splits the command as any
  other newline would, because the observer models the Bash `<<` heredoc only. Put a here-string
  in a script file, or use a single-quoted argument, rather than a multi-line body.
- A leading `NAME=value` assignment: skipped while finding the program word. When the name
  changes which repository git or gh would use (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`,
  `GIT_NAMESPACE`, `GIT_CONFIG`, `GH_HOST`, `GH_REPO`, `GH_CONFIG_DIR`), the command is
  `unsupported` rather than observed against the wrong repository.
- A destination-changing variable in the hook process's own environment (`GH_HOST`, `GH_REPO`,
  `GH_CONFIG_DIR`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_NAMESPACE`, `GIT_CONFIG`,
  and the inline-config overrides) is not visible in the command text, so the observer reads its
  *name* — never its value — into `observation.environment`. The gate refuses a governed write
  when that list is non-empty, rather than observing the wrong repository; a local or read command
  is unaffected. Only the allowlisted names are read, so a credential in the environment
  (`GH_TOKEN`, `GITHUB_TOKEN`) is never observed, printed, or logged.
- A git global option other than `-C` and `-c` (`--git-dir`, `--work-tree`, `--namespace`),
  and a `git push` flag outside the documented set: `unsupported`.
- A malformed URL-like `gh repo` positional stays unresolved for view, clone, fork, edit,
  rename, archive, unarchive, sync, and delete forms. GitHub-like Git URLs with unparsed path/escape forms stay unsupported
  reads. The observer does not claim how Git, GitHub, or an API router normalizes those URLs.
- Review-comment item mutations (`gh api` PATCH/DELETE under `pulls/comments/<id>`) are
  `forbidden`; GET remains a read. Encoded or repeated-slash review paths that are ambiguous
  at this boundary are also forbidden for writes. This is a conservative classification, not
  a claim about server-side path normalization.
- A gh verb with no precise capability in the observer (for example `gh label create`,
  `gh codespace …`): the catch-all `admin` write. An
  unmodeled verb is never a read, so it can never be granted as one.
- `gh api` with an unknown explicit method (`-X OPTIONS`, `-XPOSTED`): a conservative `admin`
  write, as is any request body in any of gh's spellings (`-f`, `-F`, `--field`,
  `--raw-field`, `--input`, each separate, attached, or with `=`), except the narrow
  `gh api graphql` read above. `GET` and `HEAD` with no body are reads. A method smuggled
  through a `-H` header is not modeled.
- `gh` groups whose state is local (`alias`, `auth`, `completion`, `config`, `extension`,
  `help`, `version`) are `local`.

## Trust

The destination comes from git state. The operation, the ref text, `-R`/`--repo`,
`--base`/`--head`, and everything inside a compound command come from the command, which is
untrusted. Local git state is the best local evidence and the same user can edit it. The
observer is a guardrail input for the pinned resolver, not a boundary, and it holds no
credential and makes no network call.
