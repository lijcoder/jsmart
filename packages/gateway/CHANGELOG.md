## [Unreleased]

### Added
- Feishu channel: detect assistant errors (error, aborted, length stop reasons) in `agent_end` and send error text before "DONE" reaction

### Fixed
- Feishu channel: release active session on unhandled rejections in fire-and-forget message handler
