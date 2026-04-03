/**
 * Session persistence layer.
 *
 * Manages ChatSession[] in VS Code workspaceState.
 * Owns: create, delete, rename, auto-title, message storage, ACP ID persistence.
 */

import * as vscode from 'vscode';
import type { ChatSession, StoredMessage } from './types';

const SESSIONS_KEY = 'hermes.sessions';
const MAX_SESSIONS = 20;
const MAX_MESSAGES_PER_SESSION = 300;

export class SessionStore {
  private sessions: ChatSession[] = [];
  private activeSessionId = '';

  constructor(private readonly context: vscode.ExtensionContext) {
    const saved = context.workspaceState.get<ChatSession[]>(SESSIONS_KEY);
    if (saved && saved.length > 0) {
      this.sessions = saved.map(s => ({ ...s, messages: s.messages ?? [] }));
      this.activeSessionId = this.sessions[this.sessions.length - 1].id;
    }
  }

  // ── Getters ────────────────────────────────────────

  get activeId(): string { return this.activeSessionId; }

  active(): ChatSession | undefined {
    return this.sessions.find(s => s.id === this.activeSessionId);
  }

  allSessions(): ChatSession[] { return this.sessions; }

  allSessionsReversed(): ChatSession[] { return [...this.sessions].reverse(); }

  // ── Create / Switch / Delete ───────────────────────

  createSession(title: string): string {
    const id = `s${Date.now()}`;
    this.sessions.push({ id, title, createdAt: Date.now(), messages: [] });
    this.activeSessionId = id;
    if (this.sessions.length > MAX_SESSIONS) {
      this.sessions = this.sessions.slice(-MAX_SESSIONS);
    }
    this.persist();
    return id;
  }

  switchTo(sessionId: string): ChatSession | undefined {
    const target = this.sessions.find(s => s.id === sessionId);
    if (!target || target.id === this.activeSessionId) return undefined;
    this.activeSessionId = sessionId;
    this.persist();
    return target;
  }

  deleteSession(sessionId: string): boolean {
    if (sessionId === this.activeSessionId) return false;
    this.sessions = this.sessions.filter(s => s.id !== sessionId);
    this.persist();
    return true;
  }

  rename(sessionId: string, newTitle: string): boolean {
    const s = this.sessions.find(s => s.id === sessionId);
    if (!s) return false;
    s.title = newTitle.slice(0, 60);
    this.persist();
    return true;
  }

  // ── Auto-title ─────────────────────────────────────

  /** Auto-title the active session from the first user message. Returns the new title or null. */
  autoTitle(text: string): string | null {
    const s = this.active();
    if (!s) return null;
    if (s.messages.some(m => m.role === 'user')) return null; // already titled
    s.title = text.slice(0, 38).replace(/\s+/g, ' ').trim();
    if (text.length > 38) s.title = s.title.slice(0, 35) + '…';
    this.persist();
    return s.title;
  }

  // ── Message storage ────────────────────────────────

  addUserMessage(text: string): void {
    const s = this.active();
    if (s) {
      s.messages.push({ role: 'user', text });
      this.persist();
    }
  }

  addTurnMessages(tools: StoredMessage[], agentText: string): void {
    const s = this.active();
    if (!s) return;
    for (const t of tools) s.messages.push(t);
    if (agentText.trim()) s.messages.push({ role: 'agent', text: agentText });
    if (s.messages.length > MAX_MESSAGES_PER_SESSION) {
      s.messages = s.messages.slice(-MAX_MESSAGES_PER_SESSION);
    }
    this.persist();
  }

  // ── ACP session ID ─────────────────────────────────

  setAcpSessionId(acpId: string): void {
    const s = this.active();
    if (s && s.acpSessionId !== acpId) {
      s.acpSessionId = acpId;
      this.persist();
    }
  }

  getAcpSessionId(): string | undefined {
    return this.active()?.acpSessionId;
  }

  // ── Ensure first session ───────────────────────────

  ensureSession(): void {
    if (this.sessions.length === 0) {
      this.createSession('new session');
    }
  }

  // ── Persistence ────────────────────────────────────

  private persist(): void {
    void this.context.workspaceState.update(SESSIONS_KEY, this.sessions);
  }
}
