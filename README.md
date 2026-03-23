# Codian

[中文说明](./README.zh-CN.md)

![GitHub stars](https://img.shields.io/github/stars/zhangjiangzhihui/codian?style=social)
![GitHub release](https://img.shields.io/github/v/release/zhangjiangzhihui/codian)
![License](https://img.shields.io/github/license/zhangjiangzhihui/codian)

Codian is an Obsidian plugin that embeds a terminal-style AI agent inside your vault. It supports both `Claude Code` and `OpenAI Codex`, reusing the same chat UI, editing workflow, session model, and vault-aware context system.

## Features

- Switch between `Claude Code` and `OpenAI Codex` in settings
- Chat, edit files, search the vault, run bash commands, and execute multi-step workflows
- Reuse tabs, sessions, attachments, inline edit, and external context folders across providers
- Use `@file`, slash commands, MCP servers, custom agents, and `.claude/skills`
- Paste or drag images into conversations
- Choose between `YOLO`, `Safe`, and `Plan` modes

## Requirements

- Obsidian `v1.8.9+`
- Desktop only: Windows, macOS, or Linux
- One configured provider:
  - `Claude Code`: Claude Code CLI and compatible credentials
  - `OpenAI Codex`: `OPENAI_API_KEY` or `CODEX_API_KEY`, with optional `OPENAI_BASE_URL`

## Installation

### Release

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/zhangjiangzhihui/codian/releases/latest)
2. Put them in `YOUR_VAULT/.obsidian/plugins/codian/`
3. Enable `Codian` in Community Plugins

### BRAT

1. Install `BRAT`
2. Add `https://github.com/zhangjiangzhihui/codian`
3. Enable `Codian`

### Development

```bash
npm install
npm run build
```

For watch mode:

```bash
npm run dev
```

## Provider Setup

### Claude Code

- Install [Claude Code CLI](https://code.claude.com/docs/en/overview)
- Configure credentials in settings or environment variables
- Optional: set a custom Claude CLI path in Settings -> Advanced

### OpenAI Codex

- Set `OPENAI_API_KEY` or `CODEX_API_KEY`
- Optional: set `OPENAI_BASE_URL`
- Optional: set a custom Codex CLI path in Settings -> Advanced

## Usage

Open Codian from the ribbon, command palette, or editor inline-edit flow. The active provider is selected in plugin settings.

- The focused note is attached automatically
- `@` can reference vault files, agents, MCP servers, and external folders
- Selected editor text is included automatically
- Images can be pasted, dragged in, or referenced by path

## Safety Modes

- `YOLO`: full execution
- `Safe`: Claude uses its approval flow; Codex runs in strict read-only mode
- `Plan`: Claude uses planning mode; Codex returns a plan and waits for execution in another mode

## Provider-Specific Notes

- Claude-only: Claude Code Plugins, `claude-in-chrome`, loading `~/.claude/settings.json`
- Shared: chat, sessions, inline edit, title generation, MCP, slash commands, custom agents, external context folders

## Architecture

```text
src/
  core/
    agent/       provider abstraction and Claude/Codex services
    agents/      custom agent management
    mcp/         MCP config and runtime
    plugins/     Claude Code plugin integration
    prompts/     provider prompts
    storage/     settings and session persistence
  features/
    chat/        main chat UI
    inline-edit/ inline editing flow
    settings/    settings UI
```

## Credits

- [Anthropic](https://anthropic.com) for Claude and the Claude Agent SDK
- [OpenAI](https://openai.com) for Codex and the Codex platform/docs
