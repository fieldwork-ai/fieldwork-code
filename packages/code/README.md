# Fieldwork Code (`@fieldwork-ai/fieldwork-code`)

| Package | Purpose |
| --- | --- |
| `@fieldwork-ai/fieldwork-code` | `fwcode`: terminal chat and built-in local read/write/edit/bash handlers. |
| `@fieldwork-ai/codex-transport` | ChatGPT subscription OAuth and Codex Responses transport. |

Install `@fieldwork-ai/fieldwork-code` globally and run `fwcode` in your working directory. It signs into Fieldwork and asks you to approve the directory. Every invocation starts a new conversation; `fwcode --continue` resumes this directory's last conversation, and `fwcode --resume <id>` opens an explicit conversation. `fwcode login` lets you sign in and choose an organization again; `fwcode logout` removes this client's login.

The cloud runs the model loop, defines the full tool catalog, and executes cloud-side tools such as knowledge base and connectors. The terminal displays streamed answers and executes approved read/write/edit/bash calls through an app-hosted SSE execution stream, posting results over HTTP. Shared workspace transfer and process-control handlers support attachments, downloads, and cancellation. fwcode automatically remembers a machine identity, scoped to the Fieldwork account and organization. A conversation is created with its own-machine destination and directory already bound; resume requires the same machine and directory. Reconnecting replaces only its live session, and an offline machine never falls back to a cloud workspace. No runner pairing command or background service is needed. Bash uses your OS permissions, with the approved directory as its working directory. Electron keeps a device control stream for job notifications and starts the same conversation executor. Neither client needs a separate relay service.

Version 0.18 requires the app SSE execution API with `runner_sessions` and `runner_requests`.

Inside chat: `/model`, `/codex`, `/logs`, `/compact`, `/stop`, `/approvals`, `/approve`, `/deny`, `/older`, `/quit`. `/codex` reuses an existing Fieldwork Codex connection or opens browser OAuth with a temporary localhost callback; after your confirmation, credentials are handed to Fieldwork cloud for encrypted storage and refresh. No model calls run locally.

Login lives under `$XDG_CONFIG_HOME/fwcode/config.json` (default `~/.config/fwcode/config.json`). JSONL conversation logs live under `$XDG_STATE_HOME/fwcode/conversations/` (default `~/.local/state/fwcode/conversations/`). Logs persist across logout until you delete them. Cloud history remains authoritative. `FWCODE_API_URL` and `FWCODE_TOKEN` support development environments independently of the asset CLI's `FIELDWORK_*` configuration.

The asset-management `fieldwork` CLI (`@fieldwork-ai/cli`) is distributed separately as a compiled npm package; its source is maintained in the private app repository.

## Development and releases

Use Node 24 and pnpm 10.32.1. Run `pnpm install --frozen-lockfile`, `pnpm build`, and `pnpm test`.

Packages release independently. Bump the changed package, update its changelog, run checks, and publish from the reviewed commit using `pnpm --filter <package-name> publish --access public --no-git-checks`. Confirm the exact version and tarball before consumers update their registry pins. The app repository owns the internal live-conversation test harness; `fwcode` has no public script mode.

Shared handlers are exposed through `@fieldwork-ai/fieldwork-code/agent/runner` for desktop hosts and `@fieldwork-ai/fieldwork-code/agent/router` for the compute HTTP service. The agent uses `bash` and `tar`, and `rsvg-convert` with installed fonts for rasterized SVGs. On Ubuntu, install `librsvg2-bin fonts-liberation` for the full test suite.

### Desktop shell sessions

On macOS, `startDeviceRunner` advertises `persistent-shell-v1`. A `/bash` request with `shell_session: true` uses the authenticated executor session's persistent login shell; `initial_cwd` sets its initial directory only. Zsh and Bash startup files run once. Later commands retain cwd, environment, aliases and functions and serialize within the same session. Relative file-tool paths remain anchored to the request workdir, not the shell's cwd. Foreground CLI clients, cloud handlers and unmarked internal calls retain isolated Bash execution.

The device host owns `ShellSessionManager`, not the short-lived SSE job stream. Idle shells expire after 30 minutes; live process-group children defer expiry. A shell exit, cancellation or timeout returns partial output without replay, and the next call creates a fresh shell. Results carry `shell`, `shell_session_id`, `shell_created`, and foreground `cwd`. Explicit `/reap`, device shutdown/disconnection and maintenance close shells and reap their process groups. `ShellSessionManager` accepts an `idleMs` override for embedding/testing.

Commands are sourced in the shell itself with stdin disconnected; this is not a terminal for interactive applications. Job control and history expansion are disabled during initialization, and completion is carried in private files separately from stdout/stderr. Background calls inherit the shell state in a child without mutating the parent; their default output is discarded, so redirect output explicitly when needed. Call-scoped environment overrides are restored afterward, and `FWCODE_TOKEN` is not passed to the shell. Shells are not an OS sandbox.

PDF interpretation belongs to the private Fieldwork app. It supplies a bounded read program through the existing process runner, using Poppler on the selected machine; no PDF parser or page-formatting implementation ships in this package.

## TUI development and visual regression checks

The interface uses the terminal's font and ANSI palette. Replies and thinking text render Markdown. Full-width labeled rules separate turns, and bordered tool blocks separate commands from their results. The transcript scrolls independently above a fixed composer and status bar; PgUp/PgDn and the mouse wheel navigate history. Enter sends, Shift+Enter inserts a newline, and Escape stops a running turn. Ctrl+C also stops a running turn and exits when idle. Approval dialogs stay directly above the composer and show the command, file contents, edit diff, or plan; PgUp/PgDn scroll long details, arrows select a decision, Enter confirms, and Escape returns to the draft without deciding and interrupts any running turn. Mode pickers also sit directly above the composer. Choose **Auto-approve tools** in an approval dialog to enable it for the conversation. **Ctrl+G** toggles auto-approval, including from a pending approval panel. `/approvals` opens the mode picker; `/approvals on` and `/approvals off` set it directly. The status bar shows the saved mode. This updates `conversations.auto_approve` in the cloud and follows a resumed turn without sending it again. Explicit plan approvals still require a decision.

```bash
pnpm --filter @fieldwork-ai/fieldwork-code tui:demo
pnpm --filter @fieldwork-ai/fieldwork-code test:tui
```

The demo starts an ephemeral localhost HTTP server and uses the real session, SSE parser, and TUI. Type `thinking`, `shell`, `edit`, `write`, `plan`, `long`, `stream`, or `fail` for deterministic scenarios. It uses an isolated temporary log directory and dummy credentials; it makes no model calls and executes no tools. It is development-only and is excluded from the published package.

The tests drive input bytes through the TUI and feed its actual ANSI output into xterm's headless terminal emulator. A second test launches `ProcessTerminal` in a real POSIX PTY and operates the demo with keyboard input. This test needs Python 3 and is skipped on Windows; the emulator tests run on all platforms. PNGs and matching text frames land in `.logs/tui-screenshots/` at the repository root, or `TUI_SCREENSHOT_DIR` when set. CI uploads them as `tui-screenshots`; failed PTY runs also retain their ANSI recording under `.logs/tui-pty-failure/` locally.

Assertions cover submission, rejection and retry, preserved drafts, cloud-side pending approvals, approval and denial, unknown tool arguments, stopping, interrupted streams, long history, and resize behavior. Screenshots rasterize the terminal emulator's actual cell buffer using a fixed font and palette. They are visual-review artifacts, not pixel-golden comparisons: font rendering differs across platforms. Inspect the PNGs when changing presentation; the assertions alone do not establish visual quality.

## License

Fieldwork AI code is dual-licensed under MIT or Apache-2.0, at your option. The OpenAI-derived portions of Codex transport retain their Apache-2.0 terms and attribution. See LICENSE, LICENSE-MIT, LICENSE-APACHE, and the transport NOTICE. Dependencies retain their own licenses.
