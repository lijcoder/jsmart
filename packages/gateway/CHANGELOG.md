## [Unreleased]

### Added
- Feishu channel: detect assistant errors (error, aborted, length stop reasons) in `agent_end` and send error text before "DONE" reaction
- Feishu channel: calculate and display token usage (input, output, total) and cost in the response card on `agent_end`

### Fixed
- Feishu channel: release active session on unhandled rejections in fire-and-forget message handler
