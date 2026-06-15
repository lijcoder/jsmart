# Changelog

## [Unreleased]

### Changed
- Sidebar visual refresh: modernized button, workspace groups, session items, and scrollbar styling
- Initial Electron desktop application with multi-session support
- Slash command menu: type `/` in chat input to see available commands with keyboard navigation (Enter/click to send, Tab to fill, Escape to dismiss)
- Copy button on code blocks, with auto-collapse for blocks over 16 lines (click to expand/collapse)
- User message navigation: dropdown list in input bar to quickly jump to any user message with highlight animation

### Fixed
- Slash commands (`/model`, `/workspace`, `/session`, etc.) now display output in the chat
- Slash command output containing nested code fences no longer breaks code block rendering
- Slash command menu positioning restored after input layout refactor
