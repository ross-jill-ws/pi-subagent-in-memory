# Changelog

## 0.3.0 - 2026-08-09

### Added

- New `subagent_kill` tool: stops a stuck subagent immediately instead of waiting out its timeout. Identify the target by `sessionId` (reported back when a subagent detaches) or by its TUI card number; calling with no arguments lists the running subagents. A killed subagent is finalized like a timed-out one — `error.md`, `partial-result.md`, and `events.jsonl` are still written — and its own nested subagents detach rather than dying. Nested coordinators get the tool too, scoped so a subagent can only kill subagents at or below the nesting level it spawns.

### Changed

- Migrated to the `@earendil-works/*` pi packages (pi 0.84): renamed all imports and peer dependencies (`@sinclair/typebox` → `typebox`), removed the dead `model.ts` helper that used the removed `AuthStorage`/`ModelRegistry`/`getApiKey` APIs, and fixed `Key.ctrl()` casts for the strict `KeyId` type.
- A warning is now printed when spawning an `openai-codex` subagent: two codex sessions in one process leave the parent session's next request hanging (pi 0.8x / ChatGPT backend limitation, reproduced on both transports — see README "Known Limitations").
- Default subagent timeout raised from 900s to 1800s (30 minutes). `--saim-timeout` / `/saim-timeout` and the per-call `timeout` parameter still override it.
- The `timeout` parameter description now tells the calling LLM to leave it unset unless it can estimate the runtime accurately, and not to pass small values such as 300s, which in practice abort subagents mid-job.

### Fixed

- `error.md` written on subagent failure/timeout now includes a tail of the subagent's recent activity and an explicit pointer to `events.jsonl`, so coordinators can harvest partial findings from a timed-out worker whose work previously looked lost (only tool calls, no final text).
- A subagent that finishes with no text output now returns a diagnostic result — including whether the session ended on an unexecuted tool call (provider/agent-loop fault), the recent-activity tail, and the `events.jsonl` path — instead of the bare "Subagent completed with no text output." placeholder.
- Fixed a race where the timeout timer firing just after `agent_end` could mark an already-completed subagent card as errored.

### Added

- Nested `subagent_create` tool descriptions now advertise the spawning subagent's own timeout budget, so mid-level coordinators can size child timeouts to fit inside their own deadline (child timeout + integration time) and are nudged to have children persist intermediate findings. Schema-only — no system-prompt/context injection.

- Restored `subagent_create` compatibility with Pi 0.80.8 and later. Pi's unified model runtime removed `AgentSessionServices.modelRegistry`; the extension now resolves models through `AgentSessionServices.modelRuntime`, preventing `Cannot read properties of undefined (reading 'find')` when creating a subagent.

### Added

- Added the optional `thinkingLevel` parameter so subagents can run with `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` reasoning effort. The selected level is also recorded in the subagent session log.
