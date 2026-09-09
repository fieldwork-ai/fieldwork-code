# Fieldwork Code

| Package | Purpose |
| --- | --- |
| `@fieldwork-ai/fieldwork-code` | `fwcode`: terminal chat and built-in local read/write/edit/bash handlers. |
| `@fieldwork-ai/codex-transport` | ChatGPT subscription OAuth and Codex Responses transport. |

Install `@fieldwork-ai/fieldwork-code` globally and run `fwcode` in your working directory. It signs into Fieldwork and asks you to approve the directory. Every invocation starts a new conversation; `fwcode --continue` resumes this directory's last conversation, and `fwcode --resume <id>` opens an explicit conversation. `fwcode login` lets you sign in and choose an organization again; `fwcode logout` removes this client's login.

The cloud runs the model loop, defines the full tool catalog, and executes cloud-side tools such as knowledge base and connectors. The terminal displays streamed answers and executes approved read/write/edit/bash calls through an app-hosted SSE execution stream, posting results over HTTP. Shared workspace transfer and process-control handlers support attachments, downloads, and cancellation. fwcode automatically remembers a machine identity, scoped to the Fieldwork account and organization. A conversation is created with its own-machine destination and directory already bound; resume requires the same machine and directory. Reconnecting replaces only its live session, and an offline machine never falls back to a cloud workspace. No runner pairing command or background service is needed. Bash uses your OS permissions, with the approved directory as its working directory. Electron keeps a device control stream for job notifications and starts the same conversation executor. Neither client needs a separate relay service.

Version 0.18 requires the app SSE execution API with `runner_sessions` and `runner_requests`.

Inside chat: `/model`, `/codex`, `/logs`, `/compact`, `/stop`, `/approve`, `/deny`, `/older`, `/quit`. `/codex` reuses an existing Fieldwork Codex connection or opens browser OAuth with a temporary localhost callback; after your confirmation, credentials are handed to Fieldwork cloud for encrypted storage and refresh. No model calls run locally.

Login lives under `$XDG_CONFIG_HOME/fwcode/config.json` (default `~/.config/fwcode/config.json`). JSONL conversation logs live under `$XDG_STATE_HOME/fwcode/conversations/` (default `~/.local/state/fwcode/conversations/`). Logs persist across logout until you delete them. Cloud history remains authoritative. `FWCODE_API_URL` and `FWCODE_TOKEN` support development environments independently of the asset CLI's `FIELDWORK_*` configuration.

The asset-management `fieldwork` CLI (`@fieldwork-ai/cli`) is distributed separately as a compiled npm package; its source is maintained in the private app repository.

## Development and releases

Use Node 24 and pnpm 10.32.1. Run `pnpm install --frozen-lockfile`, `pnpm build`, and `pnpm test`.

Packages release independently. Bump the changed package, update its changelog, run checks, and publish from the reviewed commit using `pnpm --filter <package-name> publish --access public --no-git-checks`. Confirm the exact version and tarball before consumers update their registry pins. The app repository owns the internal live-conversation test harness; `fwcode` has no public script mode.

## License

Fieldwork AI code is dual-licensed under MIT or Apache-2.0, at your option. The OpenAI-derived portions of Codex transport retain their Apache-2.0 terms and attribution. See LICENSE, LICENSE-MIT, LICENSE-APACHE, and the transport NOTICE. Dependencies retain their own licenses.
