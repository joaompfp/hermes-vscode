# hermes-vscode v3.0.0 — Overhaul Plan

## Goals

1. **Decompose the two monoliths** — `chatPanel.ts` (1,316 lines) and `webview/main.ts` (860 lines)
2. **Fix outstanding bugs** — model routing (GPT-5.4 → OpenRouter), message dedup residuals
3. **Clean the UX** — remove broken sticky prompt, polish empty state, consistent spacing
4. **Add typed protocol layer** — replace `Record<string, unknown>` with proper TypeScript interfaces
5. **Add testing infrastructure** — dedup logic, protocol parsing, session persistence
6. **Preserve all v1.0.4 security hardening** — trust checks, binary approval, content escaping, media sandboxing

## Non-goals

- No new major features (this is a quality release)
- No framework adoption (React, Svelte, etc.) — keep plain TypeScript
- No workspace/gateway integration (dropped)

---

## Phase 1 — Protocol & Types (foundation)

### 1.1 Create `src/types.ts`
Shared type definitions for both extension host and webview:
- `AcpToolCall` — typed tool_call with `kind`, `toolCallId`, `title`, `locations[]`, `rawInput`
- `AcpToolCallUpdate` — typed tool_call_update with `toolCallId`, `status`, `rawOutput`
- `AcpUsageUpdate` — typed usage with `size`, `used`
- `ToWebview` — the message union (currently inline in chatPanel.ts)
- `FromWebview` — the message union (currently inline in chatPanel.ts)
- `ChatSession`, `StoredMessage` — session types (currently inline)
- `TodoItem`, `TodoState` — todo types (currently inline in main.ts)

### 1.2 Create `src/protocol.ts`
Extract protocol parsing from `sessionManager.ts`:
- `parseAgentMessageChunk()` — with dedup logic
- `parseToolCall()` — extract kind, locations, rawInput detail
- `parseToolCallUpdate()` — extract status, detect todo JSON
- `parseUsageUpdate()` — extract token counts
- `parseTodoFromRawInput()` — dedicated todo JSON parser (replace regex sniffing)

### 1.3 Update `sessionManager.ts`
- Import from `protocol.ts` instead of inline parsing
- Replace large `switch` with dispatcher + per-event handlers
- Create explicit `SessionState` object (replace scattered mutable fields)
- Verify stored session ID before blind resume attempt

**Estimated: ~400 lines moved/rewritten**

---

## Phase 2 — Split chatPanel.ts (the big one)

### 2.1 Create `src/sessionStore.ts`
Extract session persistence:
- `SessionStore` class — load/save/create/delete/rename sessions
- Wraps `workspaceState` access
- Owns `ChatSession[]` and `activeSessionId`
- Handles title auto-generation and `/title` sync
- Max sessions/messages limits

### 2.2 Create `src/promptController.ts`
Extract prompt orchestration:
- `PromptController` class — busy state, message queue, interrupt-on-queue
- IDE context collection (`collectIdeContext()`)
- File attachment injection (path references)
- Skill injection
- Context annotation building

### 2.3 Create `src/attachmentController.ts`
Extract file/skill attachment state:
- `AttachmentController` class — attached files, selected skills
- `setAttachedFile()`, `clearAttachments()`
- Paste image handling (save to temp, attach)
- Drop file handling

### 2.4 Create `src/htmlTemplate.ts`
Extract the giant `buildHtml()` method:
- `buildChatHtml(webview, options)` — returns the HTML string
- CSS extracted to a separate template string or file
- Model menu HTML builder
- Proper HTML escaping throughout (preserve v1.0.4 security)

### 2.5 Slim down `chatPanel.ts`
What remains:
- `ChatPanelProvider` class — WebviewViewProvider lifecycle
- `resolveWebviewView()` — wiring only
- `handleFromWebview()` — delegates to controllers
- `onUpdate()` — routes session events to webview
- File-open integration (`openFileInEditor()`)
- Media path conversion (`convertMediaPaths()`)

**Target: chatPanel.ts drops from 1,316 to ~400 lines**

---

## Phase 3 — Split webview/main.ts

### 3.1 Create `src/webview/state.ts`
Explicit state model (replace 15+ mutable globals):
```typescript
interface WebviewState {
  currentModel: string;
  activeSessionId: string;
  isBusy: boolean;
  knownContextSize: number;
  pendingQueuedTexts: string[];
  selectedSkills: Set<string>;
  // streaming state
  currentAgentText: string;
  pendingFlushText: string;
  // etc.
}
```

### 3.2 Create `src/webview/renderers.ts`
Extract rendering functions:
- `renderMarkdown()` — marked + DOMPurify + copy buttons
- `appendMessage()` — user/agent/tool/error messages
- `renderToolCall()` — kind label, status, detail
- `renderTodoOverlay()` — persistent checklist
- `loadHistory()` — restore saved messages
- `showWaiting()` — loading indicator

### 3.3 Create `src/webview/menus.ts`
Extract menu builders and handlers:
- `buildSessionPicker()` — session dropdown with rename/delete
- `buildSkillsMenu()` — alphabetical skill picker
- Model menu click handlers
- Overflow menu handler
- `closeAllDropdowns()`

### 3.4 Create `src/webview/handlers.ts`
Extract event handlers:
- `handleMessage()` — the big message switch (delegates to renderers)
- `handleSend()` — input submission
- `handleDragDrop()` — file drop
- `handlePaste()` — clipboard image
- `handleDragResize()` — input area drag handle

### 3.5 Slim down `src/webview/main.ts`
What remains:
- DOM ref initialization
- State initialization
- Import and wire handlers
- `window.addEventListener('message', handleMessage)`

**Target: main.ts drops from 860 to ~100 lines**

---

## Phase 4 — Bug fixes & UX cleanup

### 4.1 Remove sticky prompt
- Delete `.msg.user.sticky` CSS
- Remove sticky class toggling in `send()`
- Clean scroll: messages just flow normally

### 4.2 Fix model routing
- Investigate why `gpt-5.4` routes to OpenRouter despite explicit `openai-codex:` prefix
- Add model switch validation: if response shows wrong provider, show warning to user
- Consider sending just the model ID and letting Hermes detect the provider

### 4.3 Fix message deduplication
- Add test cases for edge cases: partial resend after tool call, multi-paragraph resend
- Consider a more robust approach: hash-based dedup instead of string comparison

### 4.4 Empty state polish
- Prompt chips should actually send the message (not just fill the input)
- Add a subtle animation on first load
- Chips disappear after first message OR history load

### 4.5 Consistent spacing
- Audit all `gap`, `margin`, `padding` values
- Define spacing scale in CSS variables: `--space-xs`, `--space-sm`, `--space-md`, `--space-lg`

### 4.6 Clean message scroll
- No more sticky/pinned behavior
- Auto-scroll to bottom during streaming (already works)
- "Jump to bottom" button when user scrolls up during response

---

## Phase 5 — Testing infrastructure

### 5.1 Set up test framework
- Add `vitest` or `jest` to devDependencies
- Add `test` script to package.json
- Create `src/__tests__/` directory

### 5.2 Protocol tests
- `protocol.test.ts` — dedup logic (exact, prefix, suffix)
- `protocol.test.ts` — tool call parsing (kind, locations, rawInput)
- `protocol.test.ts` — todo detection from rawInput
- `protocol.test.ts` — usage update extraction

### 5.3 Session store tests
- `sessionStore.test.ts` — create/delete/rename
- `sessionStore.test.ts` — auto-title from first message
- `sessionStore.test.ts` — max sessions/messages limits
- `sessionStore.test.ts` — ACP session ID persistence

### 5.4 Model catalog tests
- `modelCatalog.test.ts` — label resolution
- `modelCatalog.test.ts` — cache-driven vs fallback
- `modelCatalog.test.ts` — provider:model command format

---

## Phase 6 — Build & publish

### 6.1 Webpack update
- Split webview bundle: main entry imports from modules
- Consider source maps for dev builds
- Add `lint` script (eslint)

### 6.2 Version & release
- Reset to v3.0.0
- Clean git history (squash into release commit)
- Update CHANGELOG.md, README.md, CLAUDE.md
- Publish to marketplace
- Create GitHub release with VSIX

---

## File structure after v3.0.0

```
src/
  types.ts              (~80 lines)   — shared interfaces
  protocol.ts           (~150 lines)  — ACP protocol parsing
  extension.ts          (~360 lines)  — activation, trust, status bar
  acpClient.ts          (~220 lines)  — JSON-RPC transport
  sessionManager.ts     (~200 lines)  — session lifecycle (slimmed)
  chatPanel.ts          (~400 lines)  — WebviewViewProvider (slimmed)
  sessionStore.ts       (~150 lines)  — session persistence
  promptController.ts   (~120 lines)  — prompt orchestration
  attachmentController.ts (~80 lines) — file/skill attachments
  htmlTemplate.ts       (~400 lines)  — HTML/CSS template
  modelCatalog.ts       (~115 lines)  — model menu
  skillCatalog.ts       (~74 lines)   — skill loader
  webview/
    main.ts             (~100 lines)  — entry, wiring
    state.ts            (~60 lines)   — explicit state model
    renderers.ts        (~200 lines)  — message/tool/todo rendering
    menus.ts            (~150 lines)  — session/model/skills pickers
    handlers.ts         (~200 lines)  — event handlers
    tsconfig.json
  __tests__/
    protocol.test.ts
    sessionStore.test.ts
    modelCatalog.test.ts
```

**Total: ~3,300 lines across 18 files (from 7)**
**Average file size: ~180 lines (from ~470)**
**Largest file: ~400 lines (from 1,316)**

---

## Execution order

| Phase | Work | Risk | Dependencies |
|-------|------|------|--------------|
| 1     | Protocol & types | Low | None |
| 2     | Split chatPanel.ts | Medium | Phase 1 |
| 3     | Split webview/main.ts | Medium | Phase 1 |
| 4     | Bug fixes & UX | Low | Phases 2-3 |
| 5     | Testing | Low | Phases 1-3 |
| 6     | Build & publish | Low | All |

Phases 2 and 3 can run in parallel (different files, no overlap).
Phase 4 can start as soon as the relevant module is split.
Phase 5 can start as early as Phase 1 is complete.

---

## Migration safety

Every phase produces a **buildable, testable, shippable** extension. No big-bang rewrite.
Each split is a pure refactor: move code, fix imports, verify build. Behavior unchanged.
Security hardening from v1.0.4 is preserved through every phase — it lives in `extension.ts`
and `htmlTemplate.ts` (extracted from chatPanel.ts) and is never removed.
