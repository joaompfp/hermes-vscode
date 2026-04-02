# hermes-vscode

VS Code extension that surfaces the Hermes AI agent as a sidebar chat panel, communicating via ACP (JSON-RPC 2.0 over stdio subprocess).

## Quick orientation

```
src/
  extension.ts       — activation, wires AcpClient + SessionManager + ChatPanelProvider
  acpClient.ts       — spawns `hermes acp`, handles JSON-RPC 2.0 framing over stdio
  sessionManager.ts  — ACP session lifecycle, streaming dedup, tool/todo extraction
  chatPanel.ts       — WebviewViewProvider: all HTML/CSS, session history, file integration
  webview/main.ts    — runs inside webview sandbox: streaming, markdown, session picker UI
  modelCatalog.ts    — loads model menu from ~/.hermes/models_dev_cache.json with fallbacks
  skillCatalog.ts    — loads skills from ~/.hermes/skills/ directory tree
resources/
  hermes-icon.svg    — SVG activity bar icon (winged sandal, currentColor)
  hermes-logo.png    — chat panel logo, transparent bg, 754x754
  hermes-logo-128.png — marketplace icon, 128x128
```

## Build

```bash
npm run build     # webpack production build → dist/
npm run package   # produces hermes-vscode-X.Y.Z.vsix (runs build first)
```

Install in VS Code: Extensions panel → `...` → Install from VSIX.

Always bump the version in `package.json` before packaging a testable build:
- patch (x.y.Z) for bugfixes
- minor (x.Y.0) for new features

## ACP protocol

- `session/new` → `{ sessionId, models?: { currentModelId } }`
- `session/prompt` → `{ sessionId, prompt: [{type:'text', text}] }` — blocks until done
- `session/cancel` → notification (no response)
- Incoming `session/update` notifications carry: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `usage_update`, `session_info_update`
- `tool_call` includes: `title`, `toolCallId`, `kind` (read/edit/execute/search/fetch/think/other), `locations[]`, `rawInput`, `status`
- `tool_call_update` includes: `toolCallId`, `status`, `rawOutput` (may contain todo JSON), `content[]`
- Token data: `PromptResponse.usage.inputTokens` = last_prompt_tokens, `_meta.contextLength` = model context window size

Hermes server patch at `~/.hermes/hermes-agent/acp_adapter/server.py` — extracts top-level token keys and injects `contextLength` into `_meta`. Also patched `/compact` to call `_compress_context()` correctly. Do not revert.

## Live file integration

When a `tool_call` with `kind: "edit"` and `locations[]` completes, the extension automatically opens the file in VS Code editor (persistent tab). Files from `kind: "read"` open as preview tabs. Focus stays on the chat panel (`preserveFocus: true`).

## Session management

Sessions stored in VS Code `workspaceState` under key `hermes.sessions`. Each session stores `acpSessionId` for resume. On extension restart, the stored ACP session ID is passed to `SessionManager` which skips `session/new` and reuses the old session (if Hermes still has it).

Rename sends `/title <name>` to Hermes for persistence in state.db.

## Todo overlay

Detects JSON with `"todos"` array in `tool_call_update` raw_output (from Hermes's todo tool). Renders persistent checklist below status bar: □ pending, ■ in-progress (gold), ✓ completed (green).

## Tool display

Tool calls use `kind` field for display labels via `KIND_LABELS` map in webview/main.ts. Labels: Read, Edit, Bash, Search, Fetch, Skill, Tool. File paths from `locations[]` shown as `~/relative` paths. Status icons: ✓ green, ⋯ gold, ✗ red.

## Hermes config notes

`~/.hermes/config.yaml`:
- Vision: `provider: ollama`, `base_url: http://100.103.119.5:11434/v1`
- Compression/summary: `provider: ollama`, `model: qwen3.5:397b-cloud`
- Main model: `claude-sonnet-4-6` via `anthropic` provider
- Toolset: `hermes-cli`

## Known limitations

- Hermes ACP context not restored on session switch if Hermes process restarted (display history shown, context reset divider added)
- Todo overlay depends on Hermes's todo tool sending JSON in rawOutput — may need prompt engineering to trigger reliably
- Clipboard image paste depends on VS Code webview clipboard access (platform-dependent)
