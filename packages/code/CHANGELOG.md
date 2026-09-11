# 0.21.0

Add a TypeScript-only Codex-style patch executor at `/apply-patch`, without capability negotiation or feature flags. Approval covers patch text; execution validates current files and applies without pre-approval staging or caches. Support multi-file add/update/delete/move, exact unambiguous context, BOM and line-ending preservation, exclusive destinations, bounded inputs, and explicit partial/uncertain failure reporting. Serialize patches with write/edit and render patch text in terminal approvals.

Add independently authored operation/race/failure tests and a pinned upstream fixture corpus with explicit safety divergences, running on Linux, macOS, and Windows. No Rust runtime or implementation is included.

Add opt-in persistent login shells for macOS desktop runners. Advertise `persistent-shell-v1`; model `/bash` calls with `shell_session: true` reuse a session-scoped Zsh or Bash shell, while unmarked internal operations and foreground CLI/cloud calls retain isolated execution. Preserve cwd, exports, aliases and functions across calls and desktop executor stream turnover. Serialize commands, report shell creation/reset, retain partial failure output, and never replay interrupted commands.

Expire idle shells after 30 minutes, keep shells with running jobs alive, and reap owned processes on explicit teardown or device disconnection. Cancellation and timeouts retire the affected shell; the next command creates a fresh one. Per-call environment overrides are restored before the next command. Add Bash/Zsh lifecycle tests, an SSE stream-turnover test, and macOS CI coverage.

# 0.20.0

Render Markdown in thinking text, separate turns with labeled rules, and group tool inputs and outputs in bordered blocks.

Add awaited device preparation hooks, capability advertisement, and idle-only maintenance callbacks for embedding applications. Preserve legacy directory authorization and reap background processes when an executor closes.

Anchor approval panels and mode pickers directly above the composer, including after resizing and with multiline drafts. Add an **Auto-approve tools** option in approval dialogs, Ctrl+G, and `/approvals on|off` to update the cloud auto-approval setting, display its saved state, and follow resumed turns. If the server only saves the setting, fwcode approves the queued tools in one continuation; plans and calendar-change decisions remain explicit. Escape interrupts a running turn, including while a picker is open. Plans still require explicit approval.

# 0.19.0

Keep submitted messages visible immediately, preserve drafts on rejected sends, and reconcile streaming replies by message ID. Use a full-screen transcript with a fixed composer and status bar. Render shell commands, file contents, edit diffs, plans, and unfamiliar tool arguments as readable approval dialogs. Leave `conversations.auto_approve` under cloud control instead of sending an approval override on every turn.

Add a scripted local HTTP/SSE backend, terminal-emulator interaction tests, a real PTY smoke test, and PNG captures of the rendered terminal cells. CI retains the screenshots for review. Run `pnpm --filter @fieldwork-ai/fieldwork-code tui:demo` to operate the mock-backed interface without an account or model calls.

# 0.18.0

Replace the WebSocket relay with app-hosted SSE execution and HTTP results. fwcode opens the conversation executor directly; Electron starts the same executor from its device control stream. Reject duplicate requests and interrupt foreground work on cancellation or disconnect. Requires the matching app SSE execution API.

Offer Fieldwork AI code under MIT or Apache-2.0 and include both license texts in package distributions. Retain Apache-2.0 terms and attribution for the OpenAI-derived Codex transport implementation.

# 0.17.0

Remove PDF processing from the shared file handler. Fieldwork owns document interpretation privately and uses the selected machine's process runner; the public package retains generic file and process operations.

# 0.16.0

Create own-machine conversations with a durable machine and directory binding. Reconnect through renewable runner sessions without changing affinity. Support workspace transfers alongside read/write/edit/bash so the cloud can expose its normal tools. Requires the app release with `conversations.compute_backend` and `/runner-session`.

# 0.15.2

Remove the remaining unused asset-bundling helpers from the terminal package; their implementation and tests belong to the asset CLI.

# 0.15.1

Redact known Fieldwork credentials from conversation log content and remove the client authentication token from local tool environments.

# 0.15.0

Publish `fwcode` as a standalone terminal chat client with built-in local tools, foreground connections, independent Fieldwork login, Codex browser sign-in, directory resume and JSONL conversation logs. Asset commands move to the independent `@fieldwork-ai/cli`; remove runner commands and public script mode. Shared compute/Electron handler imports remain supported.

# 0.14.0

Rename the npm package to `@fieldwork-ai/fieldwork-code`. Keep the `fieldwork` and `fieldwork-code` executables and all library subpaths unchanged. Replace the old package when upgrading: `npm uninstall -g @fieldwork-ai/cli`, then `npm install -g @fieldwork-ai/fieldwork-code`.

# 0.13.0

Move Fieldwork Code, the existing asset CLI, and the shared laptop/compute tool agent into the public `fieldwork-ai/fieldwork-code` monorepo under `packages/code`. Keep both executable names and the existing `@fieldwork-ai/cli` npm identity.

# Changelog

## 0.10.0

**App pull/publish preserves binary files and nested directories.** Videos, images and fonts round-trip through `apps.files` without being read as UTF-8 or embedded in HTML. Binary files use the server's base64 JSON representation automatically; text files remain compatible. The local bundle reader enforces the 10 MiB decoded / 40-file limits and rejects symlinks, while pull rejects unsafe paths. Publishing binary files requires the server release that supports revision-specific app assets.

## 0.9.0

**`automations runs` reports what caused a run.** Every run is now born from the event ledger, so the server derives the cause from the occurrence that produced it and returns it as `source`. The CLI read the old `triggered_by` field, which the server no longer sends, so 0.8.1 prints `triggered by undefined` against a current server.

The vocabulary is wider than the single label it replaces: `schedule`, `email`, `whatsapp`, `booking`, `webhook`, `user`, `agent`. A run created before this change cites no occurrence and reports `unknown`.

## 0.8.1

**Fixes, all in the Knowledge Base commands.** The Files/KB merge collapsed `/kb/pages` and `/datalake/files` into one `/knowledge-base` surface and dropped the `kind` field, but only part of the CLI followed. Kind was still read in five places and no longer on the wire, so every comparison was false:

```
kb get     always 404'd
kb pull    wrote zero files and exited 0
kb ls      labeled every page as a file
kb rm|mv   prompted "Delete undefined"
```

Page writes and uploads failed outright as well, the first still addressing the old `/kb/pages` route and the second sending an empty confirm body. Kind is now derived from `content_type`.

`kb get` also gains `--out <file>`, which writes the bytes to a file, or streams them to stdout with `-`. Markdown pages previously had no download at all.

## 0.8.0

**Labels on tasks, without reaching for the browser.** `fieldwork tasks update` gains `--label`, `--remove-label`, `--no-labels` and `--new-label`; `tasks create` gains `--label` and `--new-label`.

The deltas are additive over the labels a task already wears, which is not how the underlying API field behaves (it takes the complete set and replaces). At a prompt, a `--label` that silently dropped the others is how a label gets lost, so `--no-labels` is the one way to say none.

`--new-label` mints a label that does not exist yet. Applying one previously needed the Tasks page, and correcting a mistyped one meant going to the database.

## 0.7.0

**Breaking, and a fix for a surface that was already broken.** A connector is now named by its SYSTEM rather than by a connection id: `fieldwork connectors test|secrets` and the `db` commands take a definition key (`shopify`, `postgres`) — or a definition id for an org-authored system, whose key is generated — and `connectors list` prints that key as the handle.

```
fieldwork connectors test <connection-uuid>   →  fieldwork connectors test shopify
fieldwork connectors secrets set <uuid>       →  fieldwork connectors secrets set klaviyo
```

The fix half: these commands read a `connector_id` field off the wire that the server renamed during the connector tier collapse, so they had been operating on `undefined` — `connectors list` printed a blank handle and `db schema`/`db query` could not resolve their target at all.

## 0.6.0

**Breaking.** The `org_files` group is renamed `kb`, and every endpoint it calls moved from `/api/organizations/{org}/files` to `/api/organizations/{org}/knowledge-base`. The old routes are gone rather than redirected, so 0.5.0 fails with 404 against a current server.

```
fieldwork org_files ls|get|put|search|rm|mv|pull|push  →  fieldwork kb …
```

Verbs, flags, and argument order are unchanged — only the group name and the URLs it hits. The surface is called the Knowledge Base everywhere now (the agent's tools are `kb_read`/`kb_write`/…, the browser is at `/knowledge-base`), and "Org Wiki" is retired.

Also fixed: `kb get` and `kb put` for documents were still calling `/datalake/files`, an endpoint removed in 0.4.0 — uploads and downloads of non-page files had been failing with 404 since then.

## 0.5.0

New `tasks` command group for the org's work items — projects, statuses, and blocked-by relationships.

```
fieldwork tasks projects                          # projects, with open and ready counts
fieldwork tasks list [--project OPS] [--status todo,in_progress]
                     [--assignee me] [--ready] [--parent OPS-9] [--all]
fieldwork tasks ready [--project OPS]             # what can be started right now
fieldwork tasks show OPS-42                       # sub-tasks, blockers, comments
fieldwork tasks create --project OPS --title "…" [--description - ]
fieldwork tasks update OPS-42 [--status …] [--assignee …|--unassign]
                              [--parent OPS-9|--no-parent] [--after/--before OPS-7]
                              [--project OPS2] [--due …|--no-due]
fieldwork tasks done OPS-42
fieldwork tasks comment OPS-42 "text" | -
fieldwork tasks block OPS-42 --by OPS-9
fieldwork tasks unblock OPS-42 --by OPS-9
fieldwork tasks delete OPS-42 [--cascade]
```

Tasks are addressed by their display identifier (`OPS-42`), resolved server-side so the CLI, the agent tools, and the UI share one grammar. `--ready` is the queue query: open, unblocked, and with no open sub-tasks of its own — a blocker in a project you cannot see still blocks, so it is computed on the server rather than filtered here.

`tasks update --project` moves a task and renumbers it from the target project's counter; the new identifier is printed to stderr (`OPS-42 → OPS2-7`), because a silent renumber is how people lose a task.

Requires a server with the Tasks feature; against an older deployment these commands 404.

## 0.4.1

No user-facing changes. Dev-dependency lockfile bump: `nanoid` 3.3.17 → 3.3.18 (CVE-2026-67213), pulled in transitively through vitest's vite/postcss.

## 0.4.0

**Breaking. Upgrade required — 0.3.0 no longer works against production.**

The `kb` and `files` command groups are replaced by a single `org_files` group, and every org-file endpoint moved. The server routes 0.3.0 calls (`/kb/pages`, `/datalake/files`) have been removed, so those commands now fail with 404.

```
fieldwork kb list                   →  fieldwork org_files ls
fieldwork kb get <path>             →  fieldwork org_files get <path>
fieldwork kb search <q>             →  fieldwork org_files search <q>
fieldwork kb put <path>             →  fieldwork org_files put <path>
fieldwork kb rm|mv                  →  fieldwork org_files rm|mv
fieldwork kb pull|push --dir <d>    →  fieldwork org_files pull|push --dir <d>
fieldwork files list [prefix]       →  fieldwork org_files ls [prefix]
fieldwork files get <path>          →  fieldwork org_files get <path> [--out <f>]
fieldwork files put <local> [remote] →  fieldwork org_files put <remote> <local>
```

Why: the knowledge base and the Files tier became one tree — the Org Wiki (APP-103). Two command groups split it by storage kind, which is exactly the distinction the merge removed, so keeping them would have kept teaching it. `org_files` matches the `org_files_*` tools the agent uses, so a person and an agent name the same operation the same way.

`org_files get` and `put` dispatch on the kind the server reports, not on the file extension — so an uploaded `.md` document is not mistaken for a page.

Note `put`'s argument order differs from the old `files put`: the wiki path comes first, the local file second (`org_files put reports/q1.csv ./q1.csv`), matching `org_files put <path>` for pages.

## 0.3.0 and earlier

Not tracked here. See the git history.
