# Session Persistence Bug — VSCode Extension

**Date:** 2026-04-05
**Reporter:** Hermes (diagnostic session)
**Severity:** High — sessions created by the extension are lost from the shared session database.

## TL;DR

Sessions created via the VSCode extension are no longer being persisted to `~/.hermes/state.db`. As a result:

- `hermes sessions list` (TUI) does not show them.
- `SessionDB.get_messages_as_conversation()` cannot retrieve them.
- Cross-tool continuity (extension ↔ TUI ↔ gateway) is broken.
- Session titles set via `/title` inside the extension never reach the database.

The last ACP session with content in the DB is from **2026-04-02 14:18** (id prefix `44f1be63`). Today is 2026-04-05 and I have just processed 5+ turns through the extension — none are in the DB.

## Evidence

### 1. Database state

```
sqlite3 ~/.hermes/state.db "SELECT source, COUNT(*) FROM sessions GROUP BY source ORDER BY 2 DESC;"

cron      | 87
telegram  | 85
acp       | 71     ← all stale
cli       | 13
```

```
sqlite3 ~/.hermes/state.db "SELECT substr(id,1,8), title, datetime(started_at,'unixepoch','localtime'), message_count FROM sessions WHERE source='acp' ORDER BY started_at DESC LIMIT 5;"

44f1be63 | (empty) | 2026-04-02 14:18:34 | 60
864995d3 | (empty) | 2026-04-02 12:41:49 | 15
30c3d1e5 | (empty) | 2026-04-02 05:26:50 | 24
34304ff2 | (empty) | 2026-04-02 05:03:58 | 0
01577227 | (empty) | 2026-04-02 04:53:51 | 91
```

Observations:
- **Every ACP session has an empty title.** No `/title` command has ever reached the DB via the extension.
- **No ACP sessions from 2026-04-03, 04, or 05 exist** despite active extension use.
- Sessions with `message_count = 0` exist even inside the working window — meaning session creation sometimes succeeds but message persistence fails.

### 2. Error log confirms root cause

`~/.hermes/logs/errors.log` contains **61 occurrences** of `database is locked`, clustered around ACP persistence:

```
2026-03-30 23:52:28 WARNING acp_adapter.session: Failed to persist ACP session fe9de384-...
Traceback (most recent call last):
  File "/home/joao/.hermes/hermes-agent/acp_adapter/session.py", line 291, in _persist
    db.create_session(
  File "/home/joao/.hermes/hermes-agent/hermes_state.py", line 257, in create_session
    self._conn.execute(
sqlite3.OperationalError: database is locked
```

The contention source is predictable: the gateway process (`hermes gateway run --replace`, PID 1607930 at time of diagnosis) holds write transactions on `state.db` for cron/telegram sessions, and the ACP adapter's `_persist()` call times out trying to get a write lock.

### 3. Live ACP subprocess

```
ps auxf | grep "hermes acp"
joao  430415  /home/joao/.hermes/venv/bin/python /home/joao/.local/bin/hermes acp
```

The subprocess is alive and sessions exist **in-memory** inside that process. When the extension disconnects or the process dies, everything evaporates. No persistence = no recovery.

## Root cause — the extension side

There are **three independent bugs** compounding each other. Two are in the extension, one is in the adapter. All three need fixing.

### Bug 1 — `ensureSession()` fabricates session IDs (extension)

**File:** `src/sessionManager.ts` lines 97–103

```ts
// Try to resume a stored session first (Hermes persists sessions in SQLite)
if (this.storedSessionId) {
  this.log(`[session] attempting resume of ${this.storedSessionId}`);
  this.sessionId = this.storedSessionId;
  this.storedSessionId = null;
  return this.sessionId;
}
```

**Problem:** When a stored session ID exists (from previous run), the extension assumes the ID and skips ACP entirely. It does **not** call `session/new` **or** `session/load` / `session/resume`. It then uses that ID as if it were a live session in subsequent `session/prompt` calls.

The ACP adapter has three relevant endpoints (`acp_adapter/server.py`):

- `new_session()` — creates a session in the in-memory manager and persists it (line 222)
- `load_session()` — requires the session to already exist in-memory or DB (line 224)
- `resume_session()` — loads from DB, creates new if not found (line 239)

The extension should be calling `resume_session` (or `load_session`) when it has a stored ID. Instead it calls nothing, and the subsequent `session/prompt` with an unknown sessionId either:

- fails silently on the adapter side, or
- creates an orphaned in-memory session that is never persisted because it never went through the creation codepath

**Fix required:** When `storedSessionId` is set, call `session/load` (or `session/resume`) via ACP. On failure (session not found), fall back to `session/new`.

```ts
// Proposed:
if (this.storedSessionId) {
  try {
    await this.client.call('session/load', {
      sessionId: this.storedSessionId,
      cwd,
      mcpServers: [],
    });
    this.sessionId = this.storedSessionId;
    this.storedSessionId = null;
    this.log(`[session] resumed ${this.sessionId}`);
    return this.sessionId;
  } catch (err) {
    this.log(`[session] resume failed, creating new: ${err}`);
    this.storedSessionId = null;
    // fall through to session/new
  }
}
```

### Bug 2 — `/title` command never reaches the DB (extension)

**File:** `src/chatPanel.ts` lines 439–443

```ts
if (s.id === this.activeSessionId) {
  this.post({ type: 'statusBar', sessionTitle: s.title });
  // Sync title to Hermes session DB
  void this.runPrompt(`/title ${s.title}`);
}
```

**Problem:** The `/title` slash command is only sent during **rename**, not when the user types `/title X` directly in the chat input. When you type `/title ctx` in the chat, the text goes through `handleFromWebview()` → `runPrompt()` → `session/prompt`. On the adapter side, slash commands are handled before reaching the model, but **the result is not persisted to the `sessions.title` column** unless the adapter explicitly updates it.

Additionally, even the rename path only fires if the session is active AND the user clicked rename — which is not how most users change titles.

**Fix required:**
- Extension: normalize title handling. Whether the user uses the rename UI or types `/title`, both should update local state AND propagate to the adapter.
- Adapter: when `/title` is processed, call `db.set_session_title(session_id, title)` and ensure `save_session()` is called after.

### Bug 3 — `_persist()` fails silently when DB is locked (adapter)

**File:** `acp_adapter/session.py` line 263

```python
def _persist(self, state: SessionState) -> None:
    db = self._get_db()
    if db is None:
        return
    # ...
    try:
        existing = db.get_session(state.session_id)
        if existing is None:
            db.create_session(...)
        # ...
    except Exception:
        logger.warning("Failed to persist ACP session %s", state.session_id, exc_info=True)
```

**Problem:** The exception is caught and logged but not retried, queued, or surfaced to the extension. The user has zero signal that persistence is failing. The in-memory session continues working fine — until the process dies or the extension disconnects, at which point the conversation is lost forever.

The gateway holding long write transactions during cron/telegram runs is the direct cause of the `database is locked` errors. SQLite WAL mode allows concurrent readers but only one writer, and the default busy timeout is insufficient for the extension's needs.

**Fix required (adapter-side, not extension):**
- Increase SQLite `busy_timeout` from default to at least 30 seconds (set via `PRAGMA busy_timeout = 30000;` on connection open).
- Add retry-with-backoff around `_persist()` for `OperationalError: database is locked`. Three retries at 500ms / 1s / 2s would handle 99% of cases.
- If persistence still fails after retries, emit a visible warning to the ACP client so the extension can show it in the UI.

## Full picture — two separate storage systems

The extension currently maintains **two independent storage systems** with no synchronization guarantee:

1. **`vscode.ExtensionContext.workspaceState`** (`hermes.sessions` key)
   - Contains the session picker list visible in the extension
   - Holds messages, titles, timestamps, and the `acpSessionId` bridge
   - Per-workspace, local to VSCode
   - Survives VSCode restarts
   - **Invisible to the Hermes TUI**

2. **`~/.hermes/state.db`** (SQLite, `sessions` + `messages` tables)
   - Shared across all Hermes surfaces (CLI, TUI, gateway, ACP, cron, telegram)
   - Should contain the authoritative conversation history for resume and search
   - **Currently missing all recent ACP sessions from the extension**

The `acpSessionId` stored in workspace state is supposed to be the bridge. Today it is not, because bug 1 prevents the adapter from ever being told about it, and bug 3 prevents successful persistence even when the adapter is told.

## Action items (prioritized)

### P0 — extension

1. **Fix `ensureSession()` to call `session/load` or `session/resume` when `storedSessionId` is set.** This is the single most important fix — without it, session IDs are phantoms.

2. **Handle the `session/load` failure case:** if the adapter reports the session is not found, clear `storedSessionId`, drop the local history reference to it, and fall through to `session/new`. Do NOT keep trying to use a dead ID.

### P1 — adapter

3. **Add SQLite busy_timeout + retry logic to `_persist()`.** 30-second busy timeout, 3 retries with exponential backoff.

4. **Surface persistence failures to the ACP client.** The extension should know if its session is not being saved, so it can warn the user before valuable work is lost.

### P2 — extension

5. **Propagate `/title` commands from the chat input (not just the rename UI) to the adapter.** The adapter already handles `/title` as a slash command; make sure the extension lets it through without eating it in webview logic.

6. **Verify on startup:** when restoring a session from workspace state, query the adapter to confirm the ACP session exists. If not, show a "resumed as new session" indicator in the UI instead of silently creating a fresh session with the same local history.

### P3 — adapter (nice to have)

7. **Set `sessions.title` in the DB when the adapter processes `/title`.** Currently the title lives only in the model's internal session state, which never makes it to the DB schema column.

8. **Add a `source='acp-vscode'` variant or a `client` column** so we can distinguish extension sessions from other ACP consumers if more surface area is added later.

## How to verify after fixes

```bash
# 1. Start with a clean slate
sqlite3 ~/.hermes/state.db "SELECT MAX(started_at), COUNT(*) FROM sessions WHERE source='acp';"

# 2. Use the extension — send a couple of prompts, set a title with /title

# 3. Check the DB again — a new row with today's date should exist
sqlite3 ~/.hermes/state.db "SELECT substr(id,1,8), title, datetime(started_at,'unixepoch','localtime'), message_count FROM sessions WHERE source='acp' ORDER BY started_at DESC LIMIT 3;"

# 4. Confirm in TUI
hermes sessions list 2>&1 | head -20

# 5. Check error log is clean
grep -c "database is locked" ~/.hermes/logs/errors.log
grep -c "Failed to persist ACP" ~/.hermes/logs/errors.log
```

A successful fix means:
- New rows appear in `sessions` with `source='acp'` and non-empty `title`
- `message_count > 0` for active sessions
- `hermes sessions list` shows the extension sessions alongside cron/telegram/cli
- No new `database is locked` entries in `errors.log`

## Files to touch

- `src/sessionManager.ts` — fix `ensureSession()` resume logic, add `session/load` call
- `src/chatPanel.ts` — normalize `/title` handling
- `~/.hermes/hermes-agent/acp_adapter/session.py` — add busy_timeout + retry in `_persist()`
- `~/.hermes/hermes-agent/acp_adapter/server.py` — surface persistence failures to the client
- Optionally `~/.hermes/hermes-agent/hermes_state.py` — set `busy_timeout` pragma globally on connection
