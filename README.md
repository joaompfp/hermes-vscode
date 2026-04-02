# Hermes — AI Coding Agent for VS Code

Hermes is an AI coding agent that runs directly in your VS Code sidebar. It streams responses in real time, executes tools, manages sessions, and tracks live context usage through the [Hermes CLI](https://github.com/collinear-ai/hermes-agent) over the Agent Client Protocol (ACP).

## Features

### Chat & Streaming
- **Sidebar chat panel** — Hermes lives in the VS Code activity bar with a custom winged sandal icon
- **Streaming markdown** — responses render live with debounced markdown formatting and DOMPurify sanitization
- **Thinking display** — extended reasoning shown as gold italic status line
- **Inline images** — Hermes `MEDIA:/path` protocol renders images directly in chat
- **Copy buttons** — hover any code block to copy its contents

### Tools & Skills
- **Claude Code-style tool display** — tool calls show with bold kind labels (Read, Edit, Bash, Search, Fetch) and file paths from ACP locations
- **Status icons** — `✓` green (done), `⋯` gold (running), `✗` red (error)
- **Live file integration** — edited files auto-open in VS Code editor; read files open as preview tabs
- **Skills picker** — `✦` button dynamically loads 100+ skills from `~/.hermes/skills/`, grouped alphabetically
- **Todo progress overlay** — persistent checklist appears when Hermes uses its todo tool

### Context & Attachments
- **IDE context awareness** — active file, selection, and open tabs automatically sent with each message
- **File attachment** — `⊞` button, drag & drop from explorer, or Ctrl+V to paste images
- **Multiple attachments** — files accumulate as chips, all cleared after send
- **Path references** — attached files sent as paths (not content), Hermes reads on demand

### Sessions
- **Persistent sessions** — conversations stored in VS Code workspaceState, survive reloads
- **Session picker** — click the session name to switch, create, rename (`✎`), or delete (`✕`)
- **Auto-titled** — first user message becomes the session title
- **ACP session resume** — stored session IDs allow Hermes to resume context across restarts
- **Title sync** — renaming sends `/title` to Hermes for persistence in its session DB

### Model Switching
- **Multi-provider** — Anthropic Claude + OpenAI Codex models in grouped picker
- **Provider:model syntax** — seamless provider switching via `/model anthropic:claude-opus-4-6`
- **Dynamic catalog** — reads from `~/.hermes/models_dev_cache.json` with hard-coded fallbacks

### Queue & Interrupt
- **Queued prompts** — send follow-ups while Hermes is busy
- **Interrupt mode** — new messages cancel the current turn (matches Hermes TUI `busy_input_mode: interrupt`)
- **Visual feedback** — logo pulses gold, input border glows while agent is working

### Status & Tokens
- **Session name + token counter** fill the top status bar
- **Gold current tokens** — e.g. **45.2k** / 1M with progress bar
- **Color warnings** — gold at 70%, red at 90% context usage
- **Bottom toolbar** — model picker, file/skill attach, slash command buttons

## Requirements

- [Hermes CLI](https://github.com/collinear-ai/hermes-agent) installed (`pip install hermes-agent`)
- Hermes authenticated (`hermes setup`)
- For Remote SSH: extension runs on the workspace/server side where Hermes is installed

## Getting Started

1. Install Hermes: `pip install hermes-agent`
2. Authenticate: `hermes setup`
3. Install the `.vsix` file (Extensions → `...` → Install from VSIX)
4. Open the Hermes panel from the Activity Bar (winged sandal icon)
5. Start chatting

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `hermes.path` | `hermes` | Path to the `hermes` binary (auto-resolves `~/.local/bin/hermes`) |
| `hermes.debugLogs` | `true` | Show ACP protocol logs in the Hermes Output channel |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line in input |
| `Ctrl+V` | Paste image from clipboard |

## Commands

| Command | Description |
|---------|-------------|
| `Hermes: Open Chat` | Focus the Hermes panel and connect |
| `Hermes: New Session` | Start a fresh agent session |

## Slash Commands

| Command | Button | Description |
|---------|--------|-------------|
| `/model [provider:model]` | ⚡ | Switch model and provider |
| `/context` | ≡ | Show current context usage |
| `/compact` | ⤓ | Compress conversation context |
| `/reset` | ↺ | Clear conversation history |
| `/help` | ? | List all available commands |

## Architecture

```
Extension Host (Node.js, runs on workspace/server side)
├── extension.ts      — activation, AcpClient + SessionManager + ChatPanelProvider
├── acpClient.ts      — JSON-RPC 2.0 over stdio (hermes acp subprocess)
├── sessionManager.ts — session lifecycle, streaming dedup, tool/todo extraction
├── chatPanel.ts      — WebviewViewProvider, HTML/CSS, session persistence, file integration
├── modelCatalog.ts   — dynamic model menu from Hermes cache
└── skillCatalog.ts   — skill loader from ~/.hermes/skills/

Webview (Browser sandbox)
└── webview/main.ts   — streaming renderer, markdown, session/model/skills UI
```

The extension spawns `hermes acp` as a subprocess and communicates via **JSON-RPC 2.0 over stdio**. File edits and reads auto-open in VS Code. The webview is sandboxed with CSP and DOMPurify for all agent content.

## License

MIT
