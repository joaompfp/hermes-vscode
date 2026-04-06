# Change Log

## A note on versioning

The `v1.x` and `v2.x` majors were premature — milestones in the author's head, not real semver breaking changes. From `v3.0.0` onward, proper semver applies.

---

## [3.0.0] — 2026-04-06

Release candidate. Ships the full v3.0.0 architecture plus a major slash-command surface expansion, session-persistence and context-loading fixes, and a redesigned composer layout — all validated against live Hermes usage.

### Added

**Composer redesign (Claude Code-style)**
- Textarea and bottom toolbar now share a single rounded "composer" pill with a gold border that glows during agent turns.
- Logo moved to the center of the bottom bar.
- Send / Stop / Queue buttons moved to the right of the bottom bar (alongside the logo and left-side action buttons).
- Textarea claims the full width of the composer — no more logo-shaped dead zone on the right.
- Todo overlay now pops up as a floating card directly above the composer, anchored to it, instead of being pinned to the top of the messages pane.

**Grouped slash-command menu**
A new `/` button in the bottom toolbar opens a grouped dropdown organised into four sections:

- **Session**: `/title` (rename — inline popover), `/new` (clear history), `/retry` (remove last exchange), `/compact` (compress context), `/save` (write conversation JSON to workspace — inline popover), `/btw` (ephemeral side question using session context — inline popover)
- **Info**: `/context` (message counts + model), `/usage` (token breakdown: prompt, completion, cache, reasoning, cost), `/tools` (list available tools), `/help` (command list)
- **Configuration**: `/yolo` (toggle dangerous-command auto-approval; red composer glow when ON), `/reasoning` (show or set effort level — inline popover)
- **Danger**: `/reset` (clear conversation — confirmation dialog)

Menu items use three dispatch modes: `execute` (runs immediately), `prompt` (shows an inline argument input next to the button), and `confirm` (shows a confirmation dialog for destructive actions).

**Slash-command message styling**
Slash command inputs and their responses no longer render as normal conversation bubbles. Recognised commands from a hardcoded allowlist mirroring the ACP adapter's dispatch table render as centered "system" messages — muted background, no `YOU`/`Hermes` avatars — reflecting that they're controls, not conversation. Unrecognised `/foo` inputs still go to the LLM and render as normal messages.

**YOLO mode with live visual feedback**
`/yolo` toggles the `HERMES_YOLO_MODE` env var inside the ACP adapter subprocess, bypassing dangerous-command approvals (mirrors the CLI). Supports explicit `/yolo on` / `/yolo off` args. The extension parses the adapter's response text to drive a persistent red composer glow while YOLO is active — ground-truth driven, not optimistic client state.

**`/title` round-trip to state.db**
Renaming a session in the extension now persists the title to Hermes's SQLite state store. `hermes sessions list` in the terminal shows the titles. Requires the matching Hermes adapter patch (see below).

**Token display rework**
Total context usage is now the headline metric (e.g. `17.1k (17.1k cached) / 1M`), with cache reads shown in parentheses as a cost signal. Replaces the earlier "fresh tokens" display which could read `0` during fully-cached continuations and looked broken.

### Fixed
- **Session reset leak** — clicking "new session" no longer silently resumes the previous ACP session. `SessionManager.reset()` now clears both `sessionId` and `storedSessionId`, matching the semantic promise of the name. Symptom before the fix: a fresh chat would arrive with 40+ messages of phantom history and burn ~40k tokens per first turn.
- **ACP session persistence** (P0 from 2026-04-05 Hermes diagnosis) — `ensureSession()` now prefers `session/load` for stored IDs and only falls through to `session/new` when the adapter reports the session missing, fixing the earlier phantom-session bug where messages were silently lost.
- **Cron session IDs** (Hermes side) — cron jobs now reuse a stable `cron_{job_id}` session per job instead of creating a timestamped throwaway on every run. One job = one continuous conversation, not 48 sessions/day per cron.
- **`skip_context_files` for ACP** (Hermes side) — the ACP adapter no longer auto-loads `~/CLAUDE.md` / `AGENTS.md` / `HERMES.md` from the editor's CWD, which was injecting ~25k tokens of ambient home-directory docs into every session. Opt-in via `HERMES_ACP_LOAD_CONTEXT=1`.

### Changed
- **Marketplace metadata** — extension now declared in `AI`, `Chat`, `Machine Learning`, and `Other` categories. Keywords expanded for discoverability: `ai agent`, `coding assistant`, `autonomous agent`, `claude`, `codex`, `copilot alternative`, `pair programmer`, `remote ssh`, etc.
- **Activation events** simplified to `[]` — VSCode now infers activation from `views` and `commands` contributions (modern API since 1.74).

### Architecture
The v3.0.0 line decomposed two monoliths that had grown through v1 and v2:
- `chatPanel.ts` (1,316 → 509 lines) — extracted `sessionStore.ts`, `htmlTemplate.ts`, `types.ts`, `protocol.ts`
- `webview/main.ts` (853 → 435 lines) — extracted `webview/state.ts`, `webview/renderers.ts`, `webview/menus.ts`

Pre-v3, there was no typed protocol layer; parsing was scattered through `Record<string, unknown>` call sites. `src/types.ts` and `src/protocol.ts` now centralise ACP schema knowledge.

### Security — preserved from v1.0.4
All v1.0.4 security hardening carries forward: trusted-workspace gate, machine-scoped `hermes.path`, explicit binary-approval prompts, per-request permission dialogs, sandboxed media cache, HTML escaping throughout.

---

## [2.0.5] — 2026-04-02

- **Fixed**: Ambiguous Codex model names (e.g. `gpt-5.4`) were routing to OpenRouter because of a model-catalog collision. Those entries are removed from the catalog; Codex models reach Codex OAuth subscription.

## [2.0.4] — 2026-04-02

- **Fixed**: Sticky-prompt bubble now shows more lines and clicks scroll back + unpin. (Feature later removed in v3.0.0-beta — it never stopped looking "bizarre".)

## [2.0.3] — 2026-04-02

- **Added**: Experimental sticky last-prompt pinned at top while scrolling.

## [2.0.2] — 2026-04-02

- **Fixed**: Model picker now shows friendly labels from the catalog instead of raw `provider:model-id` strings.

## [2.0.1] — 2026-04-02

- **Fixed**: Model picker was trapped inside a hidden `#model-switcher` div and never dropped down. Moved to the header.

## [2.0.0] — 2026-04-02

**Council-driven UI overhaul.** A four-reviewer design council gave the v1 UI a 3/10 on UX and 3.5/10 on visual design. This release responded to that feedback.

### Redesign
- **Two-row header** — Row 1: `☤ Hermes · claude-sonnet-4-6 ▾` (brand + model picker). Row 2: session name · token counter with progress bar.
- **Empty state** — four prompt chips ("Review this file", "Explain the selected code", "Find bugs in this project", "Write tests for this module") disappear after first message.
- **Toolbar collapsed** to three buttons: `⊕` attach, `✦` skills, `···` overflow.
- **Model selector promoted** from buried toolbar button to the header.

---

## [1.0.4] — 2026-04-02

Security and stability hardening.

### Security
- Require trusted-workspace behavior before launching Hermes.
- Ignore workspace-scoped `hermes.path` overrides and constrain the setting to machine scope.
- Prompt before launching a new Hermes binary path and remember approved binaries.
- Replace blanket permission auto-approval with explicit per-request prompts.
- Restrict webview local resource access to the extension media cache instead of `~` and `/tmp`.
- Reduce default log exposure by turning diagnostic logging off by default and trimming prompt payload logging.
- Escape model menu content and remove HTML string insertion for skill/session/file-chip UI built from local metadata.

### UI
- Normalize bottom-toolbar button sizing and focus styles.
- Tighten toolbar layout for narrow sidebars.
- Keep attachment chips and dropdown labels consistent without HTML injection glitches.

---

## [1.0.0] — 2026-04-02

**First public release.** Marketing-named `v1.0.0` as "initial stable" — see the note at the top of this file for honest commentary. In practice this was closer to a `v0.6.0` or so: feature-complete enough to use daily, but still finding its shape.

### Chat & Streaming
- Sidebar chat panel with streaming markdown rendering and DOMPurify sanitization.
- Extended thinking display (gold italic status line).
- Inline image rendering via Hermes `MEDIA:/path` protocol.
- Copy buttons on all code blocks.
- Queued prompts with interrupt mode — new messages cancel the current turn.
- Logo pulses gold and input border glows while agent is working.

### Tool Integration
- Claude Code-style tool call display with bold kind labels (Read, Edit, Bash, Search, Fetch).
- Tool status icons: `✓` green (done), `⋯` gold (running), `✗` red (error).
- Tool calls rendered in monospace code-block frames.
- Live file integration — edited files auto-open in VS Code editor; reads open as preview tabs.

### Context & Attachments
- IDE context awareness — active file, selection, and open tabs sent with each message.
- File attachment via ⊞ button, drag & drop from explorer, or clipboard paste (Ctrl+V).
- Multiple file attachments accumulate as chips, cleared after send.

### Skills
- Dynamic skills picker (✦ button) loads 100+ skills from `~/.hermes/skills/`.
- Skills grouped alphabetically with multi-select toggles.
- Selected skills injected as advisory prefix in the prompt.

### Sessions
- Persistent sessions stored in VS Code workspaceState (survive reloads).
- Session picker with rename (`✎`), delete (`✕`), switch.
- Auto-titled from first user message.
- ACP session ID persistence for context resume across restarts.

### Models
- Multi-provider model switching: Anthropic Claude + OpenAI Codex.
- Grouped model picker with `provider:model` syntax for seamless provider changes.
- Dynamic catalog from `~/.hermes/models_dev_cache.json` with hard-coded fallbacks.

### Token Tracking
- Live token counter with gold current value and progress bar.
- Color-coded warnings: gold at 70%, red at 90% context usage.
- Context window size from Hermes `_meta.contextLength`.

### Todo Overlay
- Persistent task checklist below status bar when Hermes uses its todo tool.
- Status icons: □ pending, ■ in-progress (gold), ✓ completed (green), ✗ cancelled.

### Technical
- ACP (Agent Client Protocol) over JSON-RPC 2.0 stdio subprocess.
- Runs on workspace/server side for VS Code Remote SSH.
- Auto-resolves hermes binary from `~/.local/bin`, `/usr/local/bin`.
- Streaming text deduplication (exact, prefix, suffix match).
- CSP with DOMPurify for all agent-generated content.
- `extensionKind: ["workspace"]` for remote compatibility.

---

## Pre-history (unreleased, late March → 2026-04-02)

Days of private iteration against Hermes's evolving ACP adapter. Every time Hermes added a protocol feature — session persistence, model switching, tool updates, todo tool, usage metadata — this extension integrated it. Much of what shipped as "v1.0.0" was the cumulative result of that work, which in a less hurried timeline would have been `v0.0.1` through `v0.9.x`.
