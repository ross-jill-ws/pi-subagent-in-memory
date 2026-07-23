# Changelog

## Unreleased

### Fixed

- Restored `subagent_create` compatibility with Pi 0.80.8 and later. Pi's unified model runtime removed `AgentSessionServices.modelRegistry`; the extension now resolves models through `AgentSessionServices.modelRuntime`, preventing `Cannot read properties of undefined (reading 'find')` when creating a subagent.

### Added

- Added the optional `thinkingLevel` parameter so subagents can run with `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` reasoning effort. The selected level is also recorded in the subagent session log.
