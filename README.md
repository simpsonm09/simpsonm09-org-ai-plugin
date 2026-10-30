# simpsonm09-org-ai-plugin

The shared OpenCode layer for the `simpsonm09-org` organization, and the Claude Code plugin that applies the same agent-access gate.

The original lives in `simpsonm09-org/simpsonm09-org-ai-plugin`; work happens on the personal fork. See [`repo-standard`](https://github.com/simpsonm09-org/simpsonm09-repo-standard).

See the [documentation index](docs/README.md) for the packaged resolver and its release note.

It is CLI-first and contributes no MCP server. It contributes the shared skills every repository in the organization should have, and nothing personal. The `service-integrations` registry is general and portable; accounts, boards, workspaces, clusters, identities, and bundles live in the personal layer, which the org skills defer to. `maxstack` composes this layer above the faithful PStack port and below the personal layer.

## Contents

- `layer.json` describes the layer: its name, kind, config fragment, and plugin files.
- `opencode.fragment.jsonc` is the fragment `maxstack` merges into the workspace config.
- `index.ts` and `package.json` are the OpenCode plugin entrypoint. `index.ts` is an adapter; the rules are in `gate.mjs`.
- `gate.mjs` is the shared decision for one shell command. Both harnesses use it, and nothing else decides.
- `access.mjs` loads the pinned resolver from `runtime/` and the token broker from the repo-standard clone, caches tokens per repository, and bounds each call with a timeout.
- `lib/` holds the fleet lookup (`fleet.mjs`), the trusted-workspace rule (`location.mjs`), the Git Bash lookup (`bash.mjs`), the program-name rule that makes `gh.exe` and `GIT` the plain names (`program.mjs`), and the hook time budget (`budget.mjs`).
- `.claude-plugin/plugin.json` and `hooks/` are the Claude Code plugin: a `PreToolUse` gate for the Bash and PowerShell tools, and a `SessionStart` line.
- `pi/index.ts` is the Pi coding agent extension, declared in `package.json`'s `pi` manifest. `hooks/lib/pi.mjs` is its adapter over the Claude adapter.
- `.github/plugin/plugin.json` and `hooks/copilot-hooks.json` are the GitHub Copilot CLI build of the same plugin. `hooks/lib/copilot.mjs` is its adapter, and `hooks/lib/runtime.mjs` picks the adapter from the hook's first argument.
- `bin/with-gh-token.mjs` is the launcher that runs an allowed `gh` command with a token. `bin/payload.mjs` is the payload it reads.
- `skills/` holds the skills the plugin registers.
- `workspace-instructions.md` contains the layer's always-on working agreements. Every session pays for this text, so detailed procedures belong in skills.

## The agent access gate

A shell command that runs in a fleet repository is gated by the destination it reaches and the repository's agent access level, read from the committed repo-catalog ref. A command observer (`lib/intent.mjs`, over the `git push` domain (`lib/gitpush.mjs`, `lib/gitflags.mjs`, `lib/gitrefspec.mjs`), the `gh` domain (`lib/ghcommand.mjs`, `lib/ghoptions.mjs`, `lib/ghargv.mjs`), the shell scanner (`lib/shellscan.mjs`, `lib/shelllex.mjs`), `lib/observation.mjs`, and `lib/gitstate.mjs`) reads the command once, joins it to read-only git state, and names the destination, the refs, and any inherited environment conflict. The plugin loads the resolver bundled at `runtime/agent-access.mjs` only after its SHA-256 matches `runtime/agent-access.pin.json` and the required API exports (`loadCommittedCatalog`, `loadCommittedOwnedForks`, `loadCommittedOwnedRepositories`, `loadCommittedIgnore`, `resolveLevel`, `resolveDestination`, and `decideTarget`) are present. The resolver reads the roster from `upstream/main` or `main` and the owned-fork, owned-repository, and ignore policies from `upstream/main` only, in the trusted catalog clone; it does not fall back to an uncommitted catalog file. A missing, corrupt, or older resolver denies writes. A fleet repository is a clone at `<workspace>/projects/repos/<repo>`, or a worktree at `<workspace>/projects/worktrees/<name>`, which resolves to its clone through git's common directory. Outside those directories, every governed `gh` write must name one resolvable GitHub destination, normally with `-R OWNER/REPO`; an unpinned, ambiguous, or environment-overridden write is denied. Reads keep passing, and other commands are outside the gate's scope.

The decision is the resolver's, from the observer's destination and structured intent. A recognized governed write is denied when the destination or the ref cannot be pinned, when a destination-changing environment variable is set, or when the destination's kind does not grant the capability. PowerShell adds one rule: a leading call operator with a literal program name is read as that program, so `& git push origin main` is decided as `git push origin main`. A denied command is rewritten (OpenCode) or denied (hook runtimes). In a fleet repository, an allowed `gh` command to an organization destination gets a GitHub App token in its environment (`GH_TOKEN`); a destination outside the organization — an owned fork, or the clone's own personal push fork — runs under the caller's own ambient authentication, and the gate mints nothing for it. Outside a fleet repository, an allowed `gh` write must resolve to exactly one GitHub destination and uses ambient authentication; the gate never injects a token. A write the gate cannot resolve is denied; a read it cannot resolve passes.

The App token is injected only when the observed `gh` command is a fully literal, strictly parsed, recognized command pinned to `github.com`, with no external URL or destination-changing environment override.

`gh pr comment` and `gh issue comment` require `openPr`, like `gh pr create` and `gh pr ready`: `propose` and above allow them; `read` and `none` deny them.

From a fleet clone, `gh repo sync <personal-fork>` may fast-forward that clone's personal fork from its organization parent at `propose` or higher, with only an optional `--branch main` and matching `--source <org>/<repo>`; the server chooses the parent. Any other sync shape, including `--force`, stays an `admin` write that only `full` grants.

When a literal sync names the matching organization source for a rostered repository with `propose` access or higher, but the gate cannot resolve a local clone identity, it remains denied. The denial identifies the missing local repository context and the clone by repository name, and says the denial is final and the blocked command cannot be automatically retried.

- **OpenCode** calls `gateShellEdit` from `gate.mjs` in the `create.before` shell hook. It rewrites a denied command and sets `GH_TOKEN` directly.
- **Claude Code** calls `decideShell` from `gate.mjs` in a `PreToolUse` hook for the `Bash` and `PowerShell` tools. A deny is a deny. An allowed `gh` command in the Bash tool is rewritten to run through the launcher, as `allow` when it is clearly a read (`pr view|list|checks|diff|status`, `issue view|list|status`, `run view|list|watch`, `repo view`, `release view|list`, `workflow view|list`, `search`, `status`, and `api` with no method, field, or input flag) and as `ask` otherwise. The `updatedInput` keeps every original tool input field. A `gh` command in the PowerShell tool is denied with a hint to use the Bash tool, because the launcher runs under Git Bash.
- **Codex** calls the same gate from a `PreToolUse` hook for `Bash`, including Codex unified exec. Its command string is read as PowerShell on Windows and Bash elsewhere, and Bash payloads must contain an absolute `cwd`. Codex 0.162.1's unified `exec_command` accepts `workdir` but exposes only `{ "command": args.cmd }` to hooks, dropping the command's working folder (`codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs:514-525`, tag `rust-v0.162.1`). The Codex adapter signals its runtime to `decideShell`; the gate denies every command it classifies as a GitHub write in every folder and repository, regardless of access level. Reads continue through the resolver for the reported `cwd`. Pushes and pull requests must be run through Claude, OpenCode, or Copilot. A gate `ask` becomes a deny because Codex PreToolUse cannot request human approval; the human must approve the action outside Codex before it is run. Copilot and Pi have explicit allow switches for promptless sessions (`AGENT_ACCESS_COPILOT_ASK=allow` and `AGENT_ACCESS_PI_ASK=allow`); Codex has no allow-on-ask switch, so every ask stays denied. Other tools, including `apply_patch`, MCP tools, and hosted tools, are outside this shell-command gate. `write_stdin` to an existing session does not run PreToolUse again. A hook that is untrusted, cannot start at all, times out, or crashes before it can emit a JSON deny lets the command through. A worker-start or gate failure after the adapter starts is converted to the exit-0 JSON deny. The measured Windows behavior is that only the exit-0 JSON deny blocks; a non-zero exit lets the command run. If stdout closes, the adapter cannot deliver a denial; it exits zero and reports that failure on stderr, but Codex may proceed. Codex support is therefore a guardrail, not a hard boundary. maxstack's installer wires the hook through T3 launch arguments.
- **Cursor** uses `hooks/cursor-hooks.json` for `beforeShellExecution` and runs `hooks/cursor.mjs` from the project root. It gates shell commands only; file edits, MCP calls, other tools, and commands sent through an already-running shell session are outside the hook. The adapter uses Cursor's `command` and `cwd`, defaults to PowerShell on Windows and Bash elsewhere, maps gate asks to Cursor asks, and rewrites approved `gh` calls through the token launcher. Cursor's documented payload does not identify the shell dialect, so the Windows default is an assumption. Its hook definition sets `failClosed: true`; malformed input and internal errors also return a deny. The command uses ambient authentication when the gate does not request a launcher rewrite. Live Cursor IDE, CLI, and T3 behavior has not been verified.
- **Antigravity** uses `hooks/antigravity-hooks.json` for `PreToolUse` matching `run_command` and runs `hooks/antigravity.mjs` from the project root. Other tools, file edits, MCP calls, and commands sent through an already-running shell session are outside the hook. It reads `toolCall.args.CommandLine` and `Cwd`, defaults to PowerShell on Windows and Bash elsewhere, preserves the gate's denial reason, and returns rewritten approved `gh` commands through the documented shallow-merge `overwrite` field so the token launcher runs. The docs do not identify the shell dialect, so that mapping needs live validation. Internal errors and malformed input return a deny. The hook documentation does not define failure behavior for process errors or timeouts, and live App, CLI, IDE, and T3 behavior has not been verified.
- **The launcher** (`bin/with-gh-token.mjs`) takes its workspace from its own real file location, not from the environment or the working directory. It checks the payload's workspace and repository, runs the same `decideShell` from its own working directory and its own environment snapshot, and runs the command only for an allowed `gh` command that the decision routes to the organization App. It mints the organization installation token for the classified destination, cached per destination, and runs the whole command in Git Bash with `GH_TOKEN` in the child's environment. On Windows the Git Bash is `CLAUDE_CODE_GIT_BASH_PATH` when that is set (it must exist), else the Git Bash beside `git` on `PATH`. If neither exists the launch is refused, never run under a bare `bash`. On other platforms the launcher runs `bash` from `PATH`.
- **The SessionStart hook** adds the same line OpenCode adds: `agent-access: the repository <repo> has agent access level "<level>".`

Fail-closed behavior on the Claude side: the PreToolUse hook exits 2 with a short reason on any internal failure. The SessionStart hook never blocks a session. A write with a relative or missing working directory is denied, as is a write when the plugin is not in a trusted layout and so cannot find the resolver. The git and child-process calls the plugin makes are bounded (5 to 20 seconds each). The PreToolUse hook has a 40 second internal budget and a 45 second outer kill, both inside the 60 second timeout in `hooks/hooks.json`; the SessionStart hook has 15 and 20 seconds inside its 30 second timeout. When the budget runs out, or the outer kill fires, a write is denied and a read passes. The exceptions are listed under Known limits.

The Claude hook also denies a command that runs the launcher as its program, so the agent cannot skip the prompt by calling it directly. This is a cheap check on the program position, and the launcher's own decision is the control.

### Adding a repository to the fleet

When a repository is not in the fleet catalog, write commands are denied with instructions to add it first. Add the repository to `repo-catalog/repos.json` in [`simpsonm09-org/simpsonm09-repo-catalog`](https://github.com/simpsonm09/simpsonm09-repo-catalog), then its configured access level will govern agent writes.

## Plugin and skills

The layer is configuration and a plugin at the same time. `maxstack`'s `Install-Workspace.ps1` merges the fragment into `opencode.jsonc` and copies the files named in `layer.json` into `.opencode/plugins/simpsonm09-org-ai-plugin`, where OpenCode loads the plugin. The plugin registers every `skills/<id>/SKILL.md` through `ctx.skill.transform`. Claude Code can load that tree through a junction from `.claude/plugins/<name>`, or from a direct copy at that path.

| Skill | Purpose |
| --- | --- |
| `service-integrations` | The general integration registry: which CLI owns an external-service job, the command, and the best practices. |
| `repo-tasks` | Run, build, test, or verify a repository through its `justfile`. |
| `repo-standard` | The gates, the definition of done, and the branch and pull request flow. |
| `local-services` | The container stack on this machine: Docker, Portainer, Infisical, and DbGate. |
| `review-session-history` | Mine stored sessions for recurring corrections, cluster and rank the themes, and route each to a named skill edit. |
| `machine-inventory` | The fleet machine classes: id, role, storage class, and capability flags, from the `simpsonm09-machine-inventory` records. |

To add a skill, create `skills/<id>/SKILL.md` with `name` and `description` frontmatter. The plugin picks it up on the next install and restart.

## How it gets loaded

This repository is not installed on its own. [`simpsonm09-maxstack`](https://github.com/simpsonm09-org/simpsonm09-maxstack)'s `scripts/Install-Workspace.ps1 -Apply` copies the files listed in `layer.json` into `<workspace>/.opencode/plugins/simpsonm09-org-ai-plugin` and `<workspace>/.claude/plugins/simpsonm09-org-ai-plugin`. `runtime/` is part of that list and contains the pinned resolver and its provenance metadata.

- OpenCode needs no setting. It finds the workspace `.opencode` folder by walking up from the repository or worktree.
- Claude Code must be started with `--plugin-dir <workspace>/.claude/plugins`. In T3 Code that goes in the Claude provider instance's "Launch arguments". Without it a Claude Code session has neither the skills nor the access gate.

maxstack's [`docs/t3-setup.md`](https://github.com/simpsonm09-org/simpsonm09-maxstack/blob/main/docs/t3-setup.md) is the full reference. A new session is needed after each install.

## GitHub Copilot CLI build

The same folder is a GitHub Copilot CLI plugin. Copilot reads `.github/plugin/plugin.json`, whose `"hooks"` key names `hooks/copilot-hooks.json`, so Copilot runs the Copilot hooks and not `hooks/hooks.json`. The name and version match `.claude-plugin/plugin.json`, and `tests/copilot-plugin.test.ts` checks that.

Load it with the plugin folder, which is the directory that holds `.github/plugin/plugin.json`:

```bash
copilot --plugin-dir <workspace>/projects/worktrees/simpsonm09-org-ai-plugin-copilot plugin list
copilot --plugin-dir <workspace>/projects/worktrees/simpsonm09-org-ai-plugin-copilot
```

The gate trusts only the layouts in `lib/location.mjs`: a checkout under `projects/repos` or `projects/worktrees`, an installed `.opencode/plugins/<name>` copy, a direct `.claude/plugins/<name>` copy, or the pinned fetch in `.claude/cache/<name>` that Pi loads as a package. A Claude junction to the OpenCode copy resolves to the `.opencode/plugins` layout. A copy in another directory trusts no workspace, so the gate denies every write it cannot check.

The hooks file (`hooks/copilot-hooks.json`) uses the camelCase event keys, flat entries, and `version: 1`. Each entry has `bash` and `powershell` command keys. The `preToolUse` entry has `"matcher": "powershell|bash"`, and the `sessionStart` entry has none. The contract below was measured on Copilot CLI 1.0.93 on Windows with a probe plugin, and the tests use those payloads verbatim (`tests/copilot-hooks.test.ts`).

**Input.** The `preToolUse` payload is `{"sessionId", "timestamp", "cwd", "toolName", "toolArgs"}`. The shell's dialect is the tool name: `powershell` is read as PowerShell, and `bash` as Bash. The `sessionStart` payload is `{"sessionId", "timestamp", "cwd", "source", "initialPrompt"}`.

With the PascalCase keys (`PreToolUse`) Copilot sends Claude's payload instead, where a PowerShell call is reported as `"tool_name":"Bash"`. The dialect cannot be known from that, so the Copilot adapter denies such a call with a reason that names the cause. The hooks file must keep the camelCase keys.

**Output.** The hook answers with one JSON object on stdout, and exits 0.

- `{"permissionDecision":"allow","modifiedArgs":{...toolArgs,"command":"<new>"}}` rewrites the call. `modifiedArgs` keeps every field of `toolArgs`, such as `description`, and replaces `command`. The rewritten command ran. Our allow answer also carries a `permissionDecisionReason`, which the measurement did not show.
- `{"permissionDecision":"deny","permissionDecisionReason":"..."}` shows the agent `Denied by preToolUse hook: <reason>`.
- A call the gate does not govern prints nothing.
- Exit code 2 denies the call and shows `Denied by preToolUse hook from "<plugin>" (hook errored)`. A malformed payload exits 2.

`sessionStart` prints `{"additionalContext":"..."}` for a fleet repository, and nothing elsewhere. Its stdout reached the model. It never exits non-zero.

**Rewrites.** A gh call is rewritten through the launcher, as on Claude. The PowerShell tool gets a PowerShell line, `& '<node>' '<launcher>' '<payload>'`. The Bash tool gets the POSIX form. The launcher then runs the command in the shell the tool used, and the payload carries the original command in base64.

**Launcher lines the model writes.** In a live run the model saw two of its gh calls shown in rewritten form, and then began composing launcher lines by hand, with payloads of its own. Those were denied. The measured fact is that the model imitates the rewritten form. Copilot did not run the hook a second time on a rewrite. The hook answers a launcher line this way:

- The line must have exactly the shape of the rewrite for its dialect: a PowerShell call operator or none, a node path, a launcher path, and one base64 argument, each single-quoted, with nothing before or after. A line of any other shape is denied.
- The node and launcher paths are discarded. They are not compared with this checkout's.
- From the base64 payload the hook takes only `command`, which must be a non-empty string. Its `workspace`, `repo`, and `shell` fields are ignored. A payload that does not decode, or has no string `command`, is denied.
- The plain command is decided from scratch, as if the agent had sent it plain, in the current call's directory, dialect, and access level. A denied command is denied with the gate's reason. A gh command gets a fresh rewrite built with this checkout's paths and payload. Any other command is denied, with a message that says to type it plain. The plain command then gets the normal permission flow, which the wrapper cannot skip.
- A line that fails any of these is denied with `do not call the GitHub token launcher yourself; run the plain command (for example "gh pr list") and the gate adds the token`.

The answer grants nothing the plain command would not get. Claude is unchanged: any launcher line is denied with `the GitHub token launcher is not for direct use`.

On Copilot the SessionStart context adds one sentence: gh commands may appear rewritten through a token launcher, the agent should keep typing plain `gh` and `git` commands, and it must never write the launcher line itself. That sentence is an instruction to the model, not a control.

**The ask switch (`AGENT_ACCESS_COPILOT_ASK`).** The gate answers a gh write that the access level permits with `ask`, so Copilot prompts the user. A session where nobody can answer a prompt denies every such call. A session launched from T3 in ACP mode is one: at the `propose` level, no gh write works there. When the hook process is started with `AGENT_ACCESS_COPILOT_ASK=allow`, the Copilot adapter turns that `ask` into `allow`, with the same reason text and the same rewrite. Any other value, or no value, keeps the prompt. The workspace's generated Copilot launcher sets the variable for T3 sessions. A plain interactive `copilot` keeps the prompt.

The switch changes only an `ask`. A denial stays a denial, and the access level still decides what is permitted. The agent cannot set the switch for its own session: the hook reads it from its own process environment, which a tool call does not control, and a tool argument with the same name is ignored. The agent's shell can start a child process with the variable in its command, but a child has no person at its prompt and denials still apply to it. The Claude path ignores it.

**Environment.** In the hook process both `COPILOT_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` are set. The tool's own shell does not have them.

**Several plugins.** Hooks from several plugins run in sequence, and a later hook sees the command as an earlier one rewrote it. The gate decides on the command it receives, so a rewrite by another plugin is what it reads. Its own rewrite is not re-checked by a later hook.

The Copilot limits are listed under Known limits.

## Pi coding agent build

`pi/index.ts` is a Pi extension. Pi loads it from the package's `pi` manifest, and it registers one handler, for `tool_call`. The handler is `hooks/lib/pi.mjs`, which reads a `bash` call as a Bash call in the directory Pi reports (`ctx.cwd`) and asks the Claude adapter (`hooks/lib/claude.mjs`) for the answer. The decision is still `decideShell` in `gate.mjs`.

- A denial blocks the call with the gate's reason.
- A read-only gh call is rewritten to run through the launcher, with no prompt.
- Any other allowed gh call is an ask. A session with a prompt asks the person: yes runs it through the launcher, no blocks it. A session with no prompt blocks it.
- With `AGENT_ACCESS_PI_ASK` set to exactly `allow`, an ask is rewritten through the launcher without a prompt in two cases: an rpc session (`ctx.mode` is `"rpc"`), and a session with no prompt (`ctx.hasUI` is not true, or `ctx.ui.confirm` is not a function). Every other session with a prompt still asks the person, including a TUI session and a session whose `ctx.mode` is missing or unknown. An unanswered prompt resolves false, so it blocks. The switch changes only an ask. It is read from the extension process's own environment.

**rpc mode.** A live probe of `pi --mode rpc` (how T3 Code drives Pi) found that `ctx.hasUI` is true, `ctx.mode` is `"rpc"`, and `ctx.ui.confirm` exists. With nobody answering, Pi emits an `extension_ui_request` and resolves the confirm to `false` after 3000 ms. Without the switch, every ask in that session is therefore refused after a 3 s stall. With the switch, the ask is rewritten at once and no confirm is sent.

**Child agents.** A child `pi --mode rpc` does not inherit a parent's `-e` extension. Install this package through Pi's saved settings `packages` list, so each child loads the gate too.
- The workspace is the one this plugin is installed in, never `ctx.cwd` or the environment. Only `.opencode/plugins/<name>`, `.claude/plugins/<name>`, `.claude/cache/<name>` (the pinned fetch Pi loads), and development checkouts under `projects/repos` or `projects/worktrees` are trusted. A copy elsewhere trusts no workspace, so it denies every gh call it cannot check.
- An error in the gate blocks the call.

**Known limits (Pi)**

- **Child agents do not inherit a parent's `-e` extension.** A child `pi --mode rpc` is gated only when this package is in the saved settings `packages` list, not when the parent was started with `-e`.
- **`pi -p` in bash passes.** The gate reads the first word, so `pi -p "..."` run through the bash tool is decided as a `pi` command, not by what the child agent runs.
- **The ask switch reaches child processes.** The launcher wrapper sets `AGENT_ACCESS_PI_ASK` for the whole Pi process tree, and the agent cannot set it for its parent. The agent's bash can, however, start a child `pi` with the variable in its command. A child has no person at its prompt, so its asks are rewritten. Under the wrapper the variable is already set, so this adds nothing a wrapped session does not have, and denials still apply to a child. The same shape as the Copilot switch.
- **The edit and write tools are not gated.** They can change this extension's files, and no gh call goes through them.
- **Extensions run with full privileges.** The gate is a control on the agent's own tool calls. It is not a sandbox for code the agent can run.
- **No time budget.** The gate runs in the Pi process, not in a worker, so the resolver's catalog read, which has no timeout (see the resolver limit under Known limits), is not bounded by a hook budget.
- **Not measured.** That Pi runs the rewritten `event.input.command`, and that `ui.confirm(title, message)` has that signature, have not been checked against a live Pi session. The rpc findings above come from a probe; the tests use a fake ExtensionAPI and a stub context.

## Differences from the previous gate

The gate resolves a working directory to its real path before it names the repository, and it decides from the destination the command reaches rather than a whole-string write scan. Every committed cell gives either the decision `main` recorded (`tests/fixtures/parity-golden.json`) or a declared, intentional new decision (`tests/fixtures/parity-decisions.json`, one entry per cell carrying the HEAD action, the new action, and the reason). A `pass` keeps the command text and the environment exactly; an `inject` keeps the command text and sets the same fixture token; a `deny` rewrites the command. Four cases differ in how a directory is resolved (below), and the destination-aware decision adds a declared set of changes to the decisions fixture.

- **A worktree is gated as its repository.** A worktree at `<workspace>/projects/worktrees/<name>` resolves to its clone through git's common directory, so it gets the clone's level. Before, a worktree was not a fleet repository, and its commands passed. Covered by `tests/fleet.test.ts`, `tests/index.test.ts`, and the `worktree` cells of `tests/parity.test.ts`.
- **A letter-case variant resolves to the real repository.** On Windows, `projects\REPOS\DEMO-REPO` names the clone `demo-repo`. Before, the name came from the path as typed, so the same commands were decided for a repository called `DEMO-REPO` at the default level, not the clone's level. Covered by a test in `tests/fleet.test.ts` and the `case-variant` cells of `tests/parity.test.ts`. Both run only on a case-insensitive file system, so on Linux they are skipped.
- **A junction from outside `projects/repos` into a clone is gated as that clone.** A junction or symlink that points at `projects/repos/demo-repo` resolves to `demo-repo`. Before, its path named no repository, so its commands passed. Covered by `tests/fleet.test.ts` and the `junction` cells of `tests/parity.test.ts`. The fleet test is skipped where a junction cannot be created.
- **An executable spelling of gh or git is gated as the plain name.** The first shell word is read the way Bash and PowerShell read it: adjacent quoted and unquoted pieces join into one word (`"gh".exe`, `g"h"`, `'g'it`), and a backslash escapes in Bash but separates a path in PowerShell. The gate tries both readings, so `g\h`, `gh\.exe`, `.\gh.exe`, `C:\tools\gh.exe`, and `C:/Program\ Files/GitHub\ CLI/gh.exe` all name gh. A path with spaces is one word only when it is quoted, or when each space is escaped in Bash, so an unquoted `C:\Program Files\GitHub CLI\gh.exe` names no program in either reading. The program name then drops the directory, trailing dots and spaces, case, and one trailing `.exe`, `.cmd`, `.bat` or `.com`. So `gh.exe`, `GH`, `"gh".exe`, `./gh`, `gh.exe.`, and `"gh.exe "` get the decision of the plain name, and so does the same spelling of `git`. A leading tab is handled as a leading space is. An allowed gh call gets its token. Before, a quoted or escaped spelling was not gated at all, and an allowed gh call got no token and ran under the user's own login. Covered by `tests/spelling.test.ts`, `tests/gate.test.ts`, and `tests/with-gh-token.test.ts`.
- **A destination-aware decision replaces the write scan.** The gate observes the command once and sends the destination and the structured intent to the pinned resolver. The declared changes are grouped in `tests/fixtures/parity-decisions.json`:
  - a bare `git push` resolves git's real default push remote and the current branch, so a push on `main` is a `pushMain`;
  - a first positional after `git push` that is neither a URL nor a configured remote leaves the destination unresolved, and a governed write with an unresolved destination is denied rather than allowed as an out-of-scope URL;
  - a gh verb with no precise capability (`repo delete`, `release create`, `workflow run`) is a conservative `admin` write, denied below `full`;
  - the clone's own fork of a governed repository is that governed destination at the roster level, so its default branch is denied;
  - a `git -C <path> push` observes the `<path>` clone's remotes and refs, so its local repository is looked up in `<path>` too and the push is classified against that clone's own fork at the same roster level — the same push run with its cwd in that clone is decided the same way; a `-C` directory the lookup cannot resolve to a fleet repository denies a governed write instead of letting it pass as an out-of-scope command;
  - a destination outside the organization uses the caller's ambient authentication, so the gate mints no App token for it;
  - a compound command that contains a governed write is an unsupported shape and is denied, rather than decided by its first word, and the denial names that shape rather than an unknown destination;
  - a heredoc body is data: a script or a document written through bash is not decided as the commands in it, while an unquoted body's `$(...)` and backtick substitutions are still decided as the commands they run;
  - a `gh` write in a real two-remote clone (`origin` = the personal fork, `upstream` = the organization repository) with no `-R` names no single destination, so it is denied at every level with a denial that asks for `-R owner/repo` rather than claiming the repository is unknown; the cells are declared in `tests/fixtures/parity-two-remote.json`, because the historical golden file models a single-remote clone;
  - a benign leading `NAME=value` assignment is skipped to find the program word, so the command is observed as the `git push` it runs.
  The gh argument grammar is one left-to-right read: each option consumes its value, so an option value that begins with `-R`, `--repo`, `-B`, or `-H` can never be read as that flag, and an option the table does not name leaves the destination unresolved. A denial names the destination's own policy level, not the local clone's, and a `gh` command with an explicit `-R`/`--repo` is denied in the name of the repository it reaches rather than the clone it ran in; that name is the message only, and every verdict still comes from the resolver. Covered by `tests/agent-observer.test.ts`, `tests/gate.test.ts`, `tests/shared-decision.test.ts`, `tests/account-pin-shapes.test.ts`, `tests/heredoc.test.ts`, `tests/two-remote-parity.test.ts`, `tests/gh-repo-flag.test.ts`, and `tests/parity.test.ts`.

## Known limits

- **The observer reads one command, in both dialects.** A compound command (an unquoted `;`, `&`, `|`, or a newline) is decided as a whole: if any segment is a governed write, the command is an unsupported shape and a governed write with no single destination is denied; if none is, it is local. A heredoc body is excluded: it is data, read only for the command substitutions an unquoted delimiter would expand. A wrapper or interpreter (`bash -c '…'`, `iex …`, `Start-Process …`, `xargs …`, an alias) is the program word, so the command is local — a documented limit, not coverage. A quoted mention of a write is not a program word and stays local. Codex denies every governed write it observes, in every folder; its reads continue through the resolver.
- **Scripts a command runs are not read.** A command that runs `bash scripts/x.sh`, or any other program, is decided by its own first word, not by what the program does.
- **The observer is a guardrail, not a shell parser.** It does not evaluate variables, resolve an alias chain, or reconstruct a program name assembled at runtime; a wrapper or interpreter escapes it. The real boundary is the GitHub App identity plus rulesets and branch protection, not this client-side decision.
- **A local script named `git` or `gh` is decided as that program.** The program name is the last path segment, so `./scripts/git push origin main` is decided as `git push origin main`, and `./scripts/gh pr merge 1` gets a gh token, as the real gh would. The gate cannot tell the script from the program, so the script is governed by the program's rules.
- **An unmodeled gh option leaves the destination unresolved.** The observer's per-command option table is bounded: an option the table does not name (or an unknown option on a write) makes the destination unresolved, so a governed write is denied and a read gets no token. The left-to-right read means an option value is never mistaken for `-R`, `--repo`, `-B`, or `-H`.
- **A destination-changing environment variable denies a governed write.** When `GH_HOST`, `GH_REPO`, `GH_CONFIG_DIR`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_NAMESPACE`, `GIT_CONFIG`, or an inline-config override (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*`) is set in the hook process's environment, the gate refuses a governed write rather than observing the wrong repository. Only the variable's *name* is read; no value, and no credential, is ever read or logged. Local and read commands are unaffected, and an inline `NAME=value` prefix inside the command text is unsupported for the same reason.
- **An owned fork uses the caller's own authentication.** A destination the catalog records as an owned fork, or the clone's own personal push fork, is not served by the organization App. The gate mints no token for it and the `gh` command runs under the ambient login; the App installation and its ruleset cover organization repositories only.
- **Codex cannot identify the command's repository.** In Codex 0.162.1, unified `exec_command` drops its `workdir` before building the hook payload (`codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs:514-525`, tag `rust-v0.162.1`), so the hook's `cwd` is the session folder and may not be the command folder. The gate blocks its classified GitHub writes everywhere; reads still use the reported `cwd`. This restriction can be relaxed if Codex reports the folder where each command runs.
- **A space or a tab before `gh` removes the token.** The token test is on the first word after the spelling is normalised, as it was on `main`, so ` gh pr merge 1` or a tab before it gets no token and no launcher. Where the resolver allows the write it runs under the user's own login, in both harnesses. A tab and a space behave identically. The parity golden pins ` gh pr list` to this behaviour, so it is not changed here.
- **Administrative gh verbs are denied below `full`.** `gh repo delete`, `gh secret set`, `gh release create`, `gh workflow run`, and any `gh api` write are conservative `admin` writes, so a destination that does not grant `admin` denies them. This is a declared change from `main` for the organization, where the resolver allowed them at every level (`tests/fixtures/parity-decisions.json`).
- **The ask prompt shows at most 300 characters of a command.** A longer command is cut with `...`, so the person approving it does not see all of it.
- **A same-user process can reach the token broker.** The broker and its App key are in the user's profile, and the hook denies only a direct run of the launcher. Anything else running as the same user can mint a token.
- **The token is in the launched command's environment**, so that command can print it. The launcher never prints it, and it is never written to a file or put in the command text.
- **If `node` is not on the hook shell's PATH, the Claude hook does not run.** The hook command is `node "${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-use.mjs"`. When node cannot be found, the shell fails before any hook code runs, Claude Code treats that failure as non-blocking, and the call runs without the gate.
- **A hook timeout fails open.** Claude Code runs a hook past its timeout as allowed. The internal budget stops the hook before that, but a hook killed by Claude Code's own timeout is not denied.
- **A hard-killed launcher on Windows may leave its child running.** The launcher stops its child on SIGINT, SIGTERM, and SIGHUP, and on normal exit. A forced kill cannot run that handler.
- **The launched command has no time limit of the plugin's own.** A `gh` command that hangs runs until it exits or the launcher is stopped.
- **The Claude side mints nothing in the hook.** A token that cannot be minted is refused by the launcher at run time, not by the hook at decision time.
- **The resolver and the broker are not ours.** The resolver's catalog read runs git without a timeout, and the broker's HTTP calls have none. The launcher bounds a token mint at 20 seconds and gives up on it, but cannot cancel the call underneath.
- **Read-only `allow` is a prompt choice, not a control.** The gate decision is the same with `allow` or `ask`; only the prompt differs.
- **Copilot: a hook timeout is not measured here.** The Copilot docs summary says a `PreToolUse` hook that times out falls through to Copilot's normal permission flow, not to a deny. The hook has a 60 second `timeoutSec`, and the plugin answers at its 45 second outer kill, so the plugin's own deny comes first. The timeout behaviour itself has not been measured.
- **Copilot: the PowerShell rewrite is not yet measured live.** The `modifiedArgs` rewrite was measured with a POSIX-style command, and the new command ran. The PowerShell form of the rewrite is tested by running it through `powershell.exe` in `tests/copilot-powershell.test.ts`, not in a live Copilot session.
- **Copilot: a PowerShell gh call runs under Windows PowerShell 5.1.** The launcher starts `powershell.exe` on Windows (`pwsh` elsewhere) with `-EncodedCommand`. A double quote inside a single-quoted argument to a native command is not passed intact by 5.1: `'say "hi"'` reaches `gh` as `say hi` when `gh` is a `.cmd` shim. Not verified against the real `gh.exe`.
- **Copilot: the Git Bash lookup uses the Claude variable.** A Bash gh call on Windows still reads `CLAUDE_CODE_GIT_BASH_PATH` and then `git` on `PATH`. Copilot has no variable of its own here.
- **Copilot: the model writes launcher lines.** Measured: after seeing its gh calls in rewritten form, the model composed launcher lines with payloads of its own. The hook answers them as described above, and denies any it cannot read. The session note asks the model not to write them. That is an instruction, not a control.
- **Copilot: a later hook can rewrite the command after this one.** Hooks from several plugins run in sequence, and a later hook sees this hook's rewrite. The gate does not run again on what a later hook changes.
- **Copilot: `ask` in a cloud agent run.** The Copilot docs summary says a cloud agent treats `ask` as `deny`. This is not measured here.

## MCP servers

The org layer contributes no MCP server. `opencode.fragment.jsonc` is empty. Every shared service is reached through a CLI documented in the `service-integrations` registry. Keep an MCP server for a job only when no CLI covers it, and add it on demand.

GitHub, Postman and its `newman` runner, library docs, browsers, Kubernetes, secrets, tool versions, container runtime, repository tasks, and scanning are handled by `gh`, `postman`, `newman`, `npx ctx7`, `@playwright/cli`, the `chrome-devtools` CLI, `kubectl`, `helm`, and `kustomize`, `infisical`, `mise`, `docker`, `just`, and `trivy`. The Agent Vault brokers a service credential to a tool through a local proxy, and `with-vault` is the path to a brokered service. `with-secrets` puts the values for one command into its environment. Code search uses the local `grep` tool, and repo tasks use `just`. See the `service-integrations` registry for the owner of each job and the `local-services` skill for the container stack. Accounts, boards, workspaces, clusters, identities, bundles, and personal services such as Discord and email live in the personal layer, which this layer defers to.

## Layering

Precedence is personal over org over the PStack base. A layer overrides a same-key server from a lower layer. `maxstack` records the repo and commit of every layer in `stack.lock.json`.

## Layer shapes

A layer can contribute configuration, a plugin, or both. This layer contributes a plugin and an empty config fragment. A layer that only contributes configuration needs no `index.ts`. Add a plugin entry when the layer has something to register, not before.

## Local checks

Install the pinned tools, then run what CI runs.

```bash
mise install
npm ci
mise run lint    # flint over the changed files; CI runs flint run --full
mise run test    # node --test over tests/
```

The tests run the packaged resolver against temporary catalog git repositories with committed refs. They do not need a sibling checkout or credentials. `tests/parity.test.ts` compares the current code with recorded HEAD outcomes in `tests/fixtures/parity-golden.json`. The suite covers the skill loader and layer contract, the gate and its helpers, the fleet lookup against real git worktrees, the Claude hook and its entry points, the launcher's trust checks and a real Git Bash run, and the runtime's import graph.

## Refresh the pinned resolver

The resolver source is pinned to `simpsonm09-org/simpsonm09-repo-standard` commit `c036a58763dec27e597871abff9ae9804f2c3f3a`, path `scripts/agent-access.mjs`. The plugin verifies the bundled bytes against SHA-256 `54d099acaa7d166a9f3650211b94082a5c45d19268746507a728d116fd6e6342` before importing them. API version `5` requires the committed ignore loader as well as the catalog and owned-target loaders; missing or invalid ignore policy fails closed before public-read decisions.

To check the bundle, run `just check-gate-resolver`. To reproduce it, run `just refresh-gate-resolver`. The command reads the exact commit from the local standard clone and never fetches. Restart OpenCode or start a new Claude Code session after installing an updated plugin so each host loads the packaged resolver again.

## License

MIT. See [`LICENSE`](LICENSE).
