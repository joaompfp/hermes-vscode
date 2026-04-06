# Hermes AI Agent — VS Code Extension

VS Code sidebar for the [Hermes CLI](https://github.com/collinear-ai/hermes-agent) agent runtime. Streams chat, executes tools, manages sessions, and tracks context usage over the Agent Client Protocol (ACP).

Requires Hermes CLI installed and authenticated. The extension spawns `hermes acp` as a local subprocess — no cloud proxy, no hosted backend.

## Features

### Chat
- Sidebar panel with streaming markdown rendering (DOMPurify-sanitized)
- Extended thinking shown as gold status line
- Inline image rendering from Hermes `MEDIA:/path` protocol
- Copy buttons on code blocks

### Tool Use
- Tool calls displayed with kind labels (Read, Edit, Bash, Search, Fetch) and file paths
- Status: `✓` done, `⋯` running, `✗` error
- Edited files auto-open in VS Code; reads open as preview tabs
- Todo overlay from Hermes's todo tool

### Skills
- Skills picker (`✦` button) loads from `~/.hermes/skills/`
- Multi-select — injected as advisory prefix in the prompt

### Slash Commands
Grouped command menu (`/` button). Three dispatch modes: immediate execute, inline argument prompt, or confirmation dialog.

| Section | Commands |
|---------|----------|
| **Session** | `/title`, `/new`, `/retry`, `/compact`, `/save` |
| **Info** | `/context`, `/usage`, `/tools`, `/help` |
| **Config** | `/yolo` (auto-approve dangerous ops, red glow), `/reasoning` |
| **Danger** | `/reset` (with confirmation) |

Slash command responses render as centered system messages, not conversation bubbles.

### Context & Attachments
- Active file, selection, and open tabs sent automatically
- File attachment via `⊕` button, drag & drop, or `Ctrl+V` paste
- Files sent as path references — Hermes reads on demand

### Sessions
- Persistent across VS Code reloads (stored in `workspaceState`)
- Session picker: switch, create, rename, delete
- Auto-titled from first user message
- ACP session ID stored for context resume

### Models
- Anthropic Claude + OpenAI Codex in grouped picker
- Switch via header dropdown or `/model provider:model-id`
- Dynamic catalog from `~/.hermes/models_dev_cache.json`

### Token Tracking
- Context usage displayed as `Xk / 1M` with progress bar
- Color warnings at 70% (gold) and 90% (red)

### Queue & Interrupt
- Send follow-ups while busy (queued)
- New messages cancel the current turn
- Gold glow on composer while agent is working

## Requirements

- [Hermes CLI](https://github.com/collinear-ai/hermes-agent) installed (`pip install hermes-agent`)
- Hermes authenticated (`hermes setup`)
- VS Code 1.85+
- Remote SSH: runs on the workspace/server side (`extensionKind: ["workspace"]`)

## Getting Started

1. `pip install hermes-agent && hermes setup`
2. Install extension from Marketplace or `.vsix`
3. Open Hermes panel from the activity bar
4. Send a message

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `hermes.path` | `hermes` | Path to the Hermes binary (machine scope) |
| `hermes.debugLogs` | `false` | ACP diagnostic logs in the Output channel |

## Architecture

```
Extension Host (Node.js)
├── extension.ts       — activation, wiring
├── acpClient.ts       — JSON-RPC 2.0 over stdio
├── sessionManager.ts  — ACP session lifecycle, streaming dedup
├── sessionStore.ts    — workspaceState persistence
├── chatPanel.ts       — WebviewViewProvider, message dispatch
├── htmlTemplate.ts    — HTML/CSS builder
├── protocol.ts        — typed ACP parsing
├── types.ts           — shared type definitions
├── modelCatalog.ts    — model menu loader
└── skillCatalog.ts    — skill directory loader

Webview (sandboxed)
├── main.ts      — event handlers, send logic
├── state.ts     — state factory
├── renderers.ts — markdown, messages, todo overlay
└── menus.ts     — dropdowns, status bar
```

Communication: JSON-RPC 2.0 over stdio to `hermes acp` subprocess. Webview sandboxed with CSP + DOMPurify. Media isolated to extension storage.

## Credits

- [Hermes Agent](https://github.com/collinear-ai/hermes-agent) by [Nous Research](https://nousresearch.com/) — the AI agent runtime this extension connects to
- [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) — the communication protocol between extension and agent
- [marked](https://github.com/markedjs/marked) — Markdown parsing for chat rendering
- [DOMPurify](https://github.com/cure53/DOMPurify) — HTML sanitization for agent-generated content
- [VS Code Extension API](https://code.visualstudio.com/api) — WebviewViewProvider, workspace state, editor integration

## License

MIT
