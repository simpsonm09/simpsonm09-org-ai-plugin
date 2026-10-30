# Prepare the plugin observer for three-level access policy

The `gh` observer classifies supported PR and issue management as `openPr`, milestone
management as `admin`, and recognized CLI, REST, and GraphQL review writes as `forbidden`.
Admin PR merge is also forbidden. The `-m` option means the merge strategy on `gh pr merge`;
milestone escalation is limited to supported PR/issue create and edit forms, where `-m` means
milestone.

Supported positional `gh repo view` and `gh repo clone` forms identify owner/repo and GitHub
URL targets. Supported compound reads carry each named destination to the ignore check before
the existing local/public-read returns. Malformed or unresolved compound read segments fail
closed. Raw Git URLs use the command's own `-c`/`-C` options when applying Git URL rewrites
through read-only `ls-remote --get-url`. Directory-changing compounds with reads are
unsupported because this observer does not emulate shell working-directory changes. The source
also fails closed on the bounded leading `command`, `env`, `time`, `exec`, and `nohup` wrappers
around `git`/`gh` and on Bash brace groups, without interpreting their command or environment
effects. Malformed URL-like `gh repo` positionals never fall back to the current repository;
ambiguous GitHub-like Git URLs and review API paths fail closed at the observer boundary, with
no claim about downstream URL normalization. Review-comment item PATCH/DELETE routes are
forbidden while GET stays read-only. The source
documentation describes these command forms only and makes no universal file, browser, MCP,
or arbitrary-script enforcement claim.

The API 5 consumer test and packaged runtime use published resolver commit
`c036a58763dec27e597871abff9ae9804f2c3f3a` (source SHA-256
`54d099acaa7d166a9f3650211b94082a5c45d19268746507a728d116fd6e6342`). This local source
proposal does not install or activate the artifact in a workspace.
