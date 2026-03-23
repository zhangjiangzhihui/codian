# Codian

[English](./README.md)

Codian 是一个运行在 Obsidian 里的终端风格 AI 代理插件，同时支持 `Claude Code` 和 `OpenAI Codex`。它把当前 vault 作为代理工作目录，让聊天、文件编辑、搜索、命令执行和多步骤任务都能直接在知识库里完成。

## 功能特性

- 在设置中切换 `Claude Code` 或 `OpenAI Codex`
- 直接在 vault 内聊天、读写文件、搜索内容、执行 Bash 命令
- 复用同一套聊天界面、标签页、会话、附件、inline edit 和外部上下文目录
- 支持 `@文件`、slash commands、MCP 服务器、自定义 agents 和 `.claude/skills`
- 支持拖拽或粘贴图片到对话中
- 支持 `YOLO`、`Safe`、`Plan` 三种模式

## 环境要求

- Obsidian `v1.8.9+`
- 仅支持桌面端：Windows、macOS、Linux
- 至少配置一个 provider：
  - `Claude Code`：需要 Claude Code CLI 和兼容凭据
  - `OpenAI Codex`：需要 `OPENAI_API_KEY` 或 `CODEX_API_KEY`，可选 `OPENAI_BASE_URL`

## 安装方式

### Release 安装

1. 从 [latest release](https://github.com/zhangjiangzhihui/codian/releases/latest) 下载 `main.js`、`manifest.json` 和 `styles.css`
2. 放到 `你的 Vault/.obsidian/plugins/codian/`
3. 在 Obsidian 社区插件里启用 `Codian`

### BRAT 安装

1. 安装 `BRAT`
2. 添加仓库 `https://github.com/zhangjiangzhihui/codian`
3. 启用 `Codian`

### 开发模式

```bash
npm install
npm run build
```

监听构建：

```bash
npm run dev
```

## Provider 配置

### Claude Code

- 安装 [Claude Code CLI](https://code.claude.com/docs/en/overview)
- 在设置页或环境变量中配置凭据
- 可选：在设置 -> Advanced 中指定自定义 Claude CLI 路径

### OpenAI Codex

- 配置 `OPENAI_API_KEY` 或 `CODEX_API_KEY`
- 可选：配置 `OPENAI_BASE_URL`
- 可选：在设置 -> Advanced 中指定自定义 Codex CLI 路径

## 使用方式

你可以从 ribbon、命令面板或编辑器 inline edit 流程中打开 Codian。当前使用哪个 provider 由插件设置决定。

- 当前聚焦笔记会自动附加到上下文
- `@` 可以引用 vault 文件、agents、MCP 服务器和外部目录
- 编辑器选中文本会自动作为上下文带入
- 图片可以粘贴、拖入，或通过路径引用

## 安全模式

- `YOLO`：允许完整执行
- `Safe`：Claude 使用审批流程；Codex 运行在严格只读模式
- `Plan`：Claude 使用计划模式；Codex 只返回方案，等待你切换模式后执行

## Provider 差异

- Claude 专属：Claude Code Plugins、`claude-in-chrome`、读取 `~/.claude/settings.json`
- 两者共有：聊天、会话、inline edit、标题生成、MCP、slash commands、自定义 agents、外部上下文目录

## 项目结构

```text
src/
  core/
    agent/       provider 抽象层与 Claude/Codex 服务
    agents/      自定义 agent 管理
    mcp/         MCP 配置与运行时
    plugins/     Claude Code plugin 集成
    prompts/     provider 提示词
    storage/     设置与会话持久化
  features/
    chat/        主聊天界面
    inline-edit/ 行内编辑流程
    settings/    设置界面
```

## 致谢

- [Anthropic](https://anthropic.com) 提供 Claude 与 Claude Agent SDK
- [OpenAI](https://openai.com) 提供 Codex 与相关平台能力
