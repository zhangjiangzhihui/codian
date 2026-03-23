# Codian

![GitHub stars](https://img.shields.io/github/stars/YishenTu/claudian?style=social)
![GitHub release](https://img.shields.io/github/v/release/YishenTu/claudian)
![License](https://img.shields.io/github/license/YishenTu/claudian)

![Preview](Preview.png)

Codian is an Obsidian plugin that embeds a terminal-style coding agent in your vault. Users can choose between `Claude Code` and `OpenAI Codex`, and the vault becomes the agent's working directory for chat, editing, search, bash commands, and multi-step workflows.

## Features

- Choose the active provider in settings: `Claude Code` or `OpenAI Codex`
- Reuse the same chat UI, tabs, sessions, inline edit, attachments, and external context folders across providers
- Read, write, edit, and search files directly inside the vault
- Drag and drop or paste images into conversations
- Use `/commands`, `@file`, MCP servers, custom agents, and `.claude/skills`
- Run inline edit with diff preview from the editor
- Switch between `YOLO`, `Safe`, and `Plan`
- Keep Claude-only features such as Claude Code Plugins and Chrome integration when Claude is selected

## Requirements

- Obsidian `v1.8.9+`
- Desktop only: macOS, Linux, Windows
- One configured provider:
  - Claude mode: Claude Code CLI plus Anthropic-compatible credentials
  - Codex mode: `OPENAI_API_KEY` or `CODEX_API_KEY` and optional `OPENAI_BASE_URL`

## Installation

### Release

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/YishenTu/claudian/releases/latest)
2. Put them in `YOUR_VAULT/.obsidian/plugins/claudian/`
3. Enable `Codian` in Obsidian community plugins

### BRAT

1. Install `BRAT`
2. Add `https://github.com/YishenTu/claudian`
3. Enable `Codian`

### Development

```bash
npm install
npm run build
```

Watch mode:

```bash
npm run dev
```

## Provider Setup

### Claude Code

- Install [Claude Code CLI](https://code.claude.com/docs/en/overview)
- Configure Anthropic-compatible credentials in settings or environment variables
- Optional: set a custom Claude CLI path in Settings -> Advanced

### OpenAI Codex

- Set `OPENAI_API_KEY` or `CODEX_API_KEY`
- Optional: set `OPENAI_BASE_URL`
- Optional: set a custom Codex CLI path in Settings -> Advanced

## Usage

Open the chat from the ribbon or command palette, or trigger inline edit from the editor. The provider is selected in plugin settings and the rest of the workflow stays the same.

Context features:

- Focused note is attached automatically
- `@` mentions vault files, agents, MCP servers, and external folders
- Selected editor text is included automatically
- Images can be pasted, dragged in, or referenced by path

## Safety Modes

- `YOLO`: full execution
- `Safe`: Claude uses its approval flow; Codex runs in strict read-only mode
- `Plan`: Claude uses its planning workflow; Codex returns a plan only and waits for you to switch modes before implementation

## Provider-Specific Features

- Claude-only: Claude Code Plugins, `claude-in-chrome`, loading `~/.claude/settings.json`
- Shared: chat, sessions, inline edit, title generation, MCP, slash commands, custom agents, external context folders

## Troubleshooting

### CLI not found

If the plugin cannot find the selected provider CLI:

- Claude: set the Claude CLI path in Settings -> Advanced
- Codex: set the Codex CLI path in Settings -> Advanced

On Windows, prefer real executables or `cli.js` paths over `.cmd` wrappers.

### Missing credentials

- Claude mode uses Anthropic-compatible environment variables
- Codex mode uses `OPENAI_API_KEY` or `CODEX_API_KEY`

## Architecture

```text
src/
  core/
    agent/       provider abstraction and Claude/Codex services
    agents/      custom agent management
    mcp/         MCP config and runtime
    plugins/     Claude Code plugin integration
    prompts/     system prompts
    storage/     settings and session persistence
  features/
    chat/        main chat UI
    inline-edit/ inline editing flow
    settings/    settings UI
```

## Roadmap

- [x] Claude Code integration
- [x] OpenAI Codex integration
- [x] Custom agents
- [x] MCP support
- [x] Inline edit
- [x] Plan mode
- [ ] More provider-specific polish
- [ ] Additional advanced tooling

## Credits

- [Anthropic](https://anthropic.com) for Claude and the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)
- [OpenAI](https://openai.com) for Codex and the [Codex docs](https://platform.openai.com/docs/codex)
