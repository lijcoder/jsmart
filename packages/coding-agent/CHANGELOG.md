## [Unreleased]

### Added
- `--json` flag for non-interactive JSON output mode (NDJSON format). Outputs session metadata (system prompt, model, tools, skills, workspace) followed by all agent session events (messages, tool executions, compaction, retries, etc.) as JSON lines.
- `--session <filename>` CLI flag to resume a previous conversation from a saved session file
- `/sessions` CLI command to list all saved sessions in the sessions directory
- `listSessionFiles()` API to enumerate available session files in a sessions directory
