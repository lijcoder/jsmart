# @jsmart/jsmart-memory

Persistent memory system for jsmart agents. Enables agents to remember facts across sessions — user preferences, project constraints, coding conventions, and past decisions.

## Design Principles

- **Agent is read-only**: The agent can only search memories via `memory_search` tool
- **Background auto-management**: Memory extraction, merging, deduplication, and expiry happen automatically via LLM hooks after each N turns and before context compaction
- **File-based storage**: Human-readable markdown files, no external dependencies
- **Cross-project reusable**: Works with any jsmart agent session

## Architecture

```
Two triggers (async, non-blocking):
  ① Every N agent turns (agent_end event)
  ② Before context compaction (compaction_start event)

         New messages since last extraction
                    │
                    ▼
           MemoryExtractor (LLM)
        new msgs + existing memories
                    │
          CREATE / UPDATE / DELETE / SKIP
                    │
                    ▼
              MemoryStore
        .jsmart/memory/
          ├── MEMORY.md       ← index injected into system prompt
          ├── user-lang-pref.md
          └── project-arch.md
```

## Usage

```typescript
import { MemoryManager } from "@jsmart/jsmart-memory";

const memoryManager = new MemoryManager({
  memoryDir: ".jsmart/memory",
  extractionModel: myModel,      // dedicated model for extraction (e.g. haiku)
  extractionApiKey: myApiKey,    // API key for the extraction model's provider
});
memoryManager.ensureDir();

// 1. Inject memory index into system prompt at session start
const agentsContent = loadAgentsFile();
const memoryContent = memoryManager.formatForPrompt(); // null if no memories yet
const customContent = [agentsContent, memoryContent].filter(Boolean).join("\n\n---\n\n");

// 2. Give the agent the read-only search tool
import { createMemorySearchTool } from "@jsmart/jsmart-harness";
const tools = [...existingTools, createMemorySearchTool(memoryManager)];

// 3. Trigger extraction (upper layer controls timing/interval)
memoryManager.generalMemory(recentMessages);
```

## Memory File Format

Each memory is stored as a markdown file with YAML frontmatter:

```markdown
---
name: user-lang-pref
description: User prefers Chinese responses and code comments
type: user
created: 2026-06-01T00:00:00.000Z
updated: 2026-06-01T00:00:00.000Z
---

User explicitly requested all replies in Chinese, including code comments.

**Why:** User corrected English output multiple times.
**How to apply:** Always respond in Chinese; write code comments in Chinese.
```

### Memory Types

| Type | Use |
|------|-----|
| `user` | User preferences, working style |
| `project` | Project architecture, constraints, tech stack |
| `feedback` | Corrections or confirmed approaches from the user |
| `reference` | External resources, links, tickets |

## Configuration

```json
// .jsmart/settings.json
{
  "memoryModel": {
    "provider": "anthropic",
    "modelId": "claude-haiku-4-5-20251001"
  },
  "memory": {
    "enabled": true,
    "extractionInterval": 5
  }
}
```
