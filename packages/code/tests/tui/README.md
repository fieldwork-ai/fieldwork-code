# Terminal regression harness

`pnpm --filter @fieldwork-ai/fieldwork-code test:tui` operates the real TUI through keystrokes and captures its ANSI output in a headless terminal. Its scripted HTTP backend isolates rendering, navigation, streaming and error handling. It does not prove the cloud's approval policy or tool execution.

For the complete path, start `scripts/fwcode-test-server.ts` in a clean private app checkout as documented in `tests/cli-turn/README.md`. It starts the real app with a scratch Postgres database, a test identity and deterministic mock models. Then run from this repository:

```bash
FWCODE_TEST_CONFIG=/absolute/path/to/app/.context/fwcode-harness.json pnpm --filter @fieldwork-ai/fieldwork-code test:tui:live
```

The live test selects “Auto-approve tools” in the actual dialog, tests both three sequential Bash calls and three approvals already queued before the selection, lets the app resume all three through the real local SSE executor, and checks the saved conversation and tool results. A fourth command writes a proof file in the next turn. Turning auto-approval off restores the dialog, denying a command leaves its file absent, and plan approval stays explicit while auto-approval is on. Only the model is scripted; authentication, approval policy, continuation, Postgres persistence and shell execution use production code.

PNG screenshots and matching terminal text are written to `.logs/tui-screenshots/live-*.{png,txt}`, including a scenario-specific `*-failure` if a check fails. Override the destination with `TUI_SCREENSHOT_DIR`. The test creates and removes its own working directory and client state. It accepts only a loopback app URL and does not use the developer's login or repository.

The live suite is separate from the public repository's default tests because the private app must be running. The private app's CI runs `tests/cli-turn/auto-approve.test.ts` against the published client and real executor; this suite additionally verifies the latest TUI source against the same HTTP API without linking app dependencies to a checkout.

The scripted suite also covers servers that persist auto-approval without resuming the turn. The client reloads the saved conversation, follows an active server continuation, or submits its pending tool decisions as one batch. Mixed batches retain explicit plan and calendar-change decisions. The live suite also passes with the server bearer-header fix removed, exercising this fallback with real execution.
