# @jsmart/jsmart-coding-agent

Interactive coding agent CLI with session management.

## Features

- **Multi-model support** - Configure and switch between different LLM providers
- **Session management** - Persistent conversation history in JSONL format
- **Skill system** - Load custom skills for specialized tasks
- **Context compaction** - Automatic context window management
- **Layered configuration** - Global and project-level settings

## Installation

```bash
npm install @jsmart/jsmart-coding-agent
```

## Usage

### Initialize global configuration

```bash
npx jsmart-coding --init
```

This creates `~/.jsmart-coding/` with default `settings.json` and `models.json`.

### Run in a project

```bash
cd /path/to/your/project
npx jsmart-coding
```

The CLI automatically detects the project directory (looks for `.jsmart/` or `.git`).

### Commands

| Command | Description |
|---------|-------------|
| `/model` | Show current model |
| `/models` | List all available models |
| `/set model <provider> <model>` | Change model |
| `/compact` | Compact context |
| `/tokens` | Show token count |
| `/session` | Show session file path |
| `/quit` | Exit |

## Configuration

### Global Configuration (`~/.jsmart-coding/settings.json`)

```json
{
  "defaultModel": {
    "provider": "openai",
    "model": "gpt-4o"
  },
  "skillPaths": [
    "~/.jsmart-coding/skills"
  ]
}
```

### Project Configuration (`<project>/.jsmart/settings.json`)

```json
{
  "defaultModel": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514"
  },
  "skillPaths": [
    "./skills"
  ]
}
```

Project settings override global settings. `skillPaths` are merged (global + project).

The directory `<project>/.jsmart/skills` is always loaded as a skill path automatically, no configuration needed.

### Model Configuration (`models.json`)

Models are configured in `models.json` (project or global):

```json
{
  "providers": {
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "${OPENAI_API_KEY}",
      "api": "openai-completions",
      "models": [
        {
          "id": "gpt-4o",
          "contextWindow": 128000,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

Supports `${ENV_VAR}` syntax for API keys.

## Session Files

Sessions are stored in `<project>/.jsmart/sessions/<hash>-<uuid>.jsonl`.

Each session file contains:
- Session header (ID, version, timestamp)
- Messages (user, assistant, tool results)
- Compaction entries (when context is compacted)

## API

```typescript
import { CodingSession, loadConfig } from "@jsmart/jsmart-coding-agent";

// Load configuration
const { config } = loadConfig();

// Create session
const session = new CodingSession(config.projectDir, config);

// Subscribe to events
session.subscribe((event) => {
  if (event.type === "message_update") {
    // Handle streaming text
  }
});

// Send prompt
await session.prompt("Hello, world!");
```

## License

MIT
