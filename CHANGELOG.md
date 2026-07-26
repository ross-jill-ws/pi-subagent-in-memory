# Changelog

## Unreleased

### Fixed

- `error.md` written on subagent failure/timeout now includes a tail of the subagent's recent activity and an explicit pointer to `events.jsonl`, so coordinators can harvest partial findings from a timed-out worker whose work previously looked lost (only tool calls, no final text).
- A subagent that finishes with no text output now returns a diagnostic result — including whether the session ended on an unexecuted tool call (provider/agent-loop fault), the recent-activity tail, and the `events.jsonl` path — instead of the bare "Subagent completed with no text output." placeholder.
- Fixed a race where the timeout timer firing just after `agent_end` could mark an already-completed subagent card as errored.

### Added

- Nested `subagent_create` tool descriptions now advertise the spawning subagent's own timeout budget, so mid-level coordinators can size child timeouts to fit inside their own deadline (child timeout + integration time) and are nudged to have children persist intermediate findings. Schema-only — no system-prompt/context injection.

- Restored `subagent_create` compatibility with Pi 0.80.8 and later. Pi's unified model runtime removed `AgentSessionServices.modelRegistry`; the extension now resolves models through `AgentSessionServices.modelRuntime`, preventing `Cannot read properties of undefined (reading 'find')` when creating a subagent.

### Added

- Added the optional `thinkingLevel` parameter so subagents can run with `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` reasoning effort. The selected level is also recorded in the subagent session log.
