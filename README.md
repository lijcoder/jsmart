# JSmart

Inspired by [pi-mono](https://github.com/earendil-works/pi).

Tools for building AI agents and managing LLM deployments.

## Share your OSS coding agent sessions

If you use JSmart or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `jsmart-mono` sessions.

I regularly publish my own `jsmart-mono` work sessions here:

- [badlogicgames/jsmart-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/jsmart-mono)

## Packages

| Package | Description |
|---------|-------------|
| **[@jsmart/jsmart-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@jsmart/jsmart-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@jsmart/jsmart-harness](packages/harness)** | Custom coding agent harness |
| **[@jsmart/jsmart-gateway](packages/gateway)** | Multi-channel gateway with agent routing |
| **[@jsmart/jsmart-coding-agent](packages/coding-agent)** | Interactive coding agent CLI with session management |
| **[@jsmart/jsmart-memory](packages/memory)** | Persistent memory system for agents across sessions |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./jsmart-test.sh         # Run pi from sources (can be run from any directory)
```

## License

MIT
