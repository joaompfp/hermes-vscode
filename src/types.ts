/**
 * Shared type definitions for the Hermes VS Code extension.
 * Used by both the extension host (Node.js) and webview (browser).
 */

import type { SkillGroup } from './skillCatalog';

// ── Session & History ────────────────────────────────

export interface StoredMessage {
  role: 'user' | 'agent' | 'tool' | 'error';
  text: string;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  messages: StoredMessage[];
  acpSessionId?: string;
}

// ── Todo ─────────────────────────────────────────────

export interface TodoItem {
  id?: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  activeForm?: string;
}

export interface TodoState {
  todos: TodoItem[];
  summary?: {
    total: number;
    pending: number;
    in_progress: number;
    completed: number;
    cancelled: number;
  };
}

// ── ACP Session Events ───────────────────────────────

export interface SessionUpdateEvent {
  session_id: string;
  text?: string;
  thinkingText?: string;
  toolTitle?: string;
  toolStatus?: string;
  toolCallId?: string;
  toolDetail?: string;
  toolKind?: string;
  toolLocations?: string[];
  todoState?: TodoState;
  done?: boolean;
  error?: string;
  model?: string;
  sessionTitle?: string;
  contextUsed?: number;
  contextSize?: number;
  cachedTokens?: number;
}

export type SessionUpdateHandler = (event: SessionUpdateEvent) => void;

// ── Webview Messages ─────────────────────────────────

export interface ToWebview {
  type:
    | 'append' | 'thinking' | 'toolCall' | 'done'
    | 'error' | 'status' | 'clear' | 'busy'
    | 'statusBar' | 'sessionList' | 'loadHistory';
  text?: string;
  toolName?: string;
  toolStatus?: string;
  toolCallId?: string;
  toolDetail?: string;
  toolKind?: string;
  toolLocations?: string[];
  todoState?: TodoState;
  status?: string;
  active?: boolean;
  queued?: number;
  model?: string;
  sessionTitle?: string;
  contextUsed?: number;
  contextSize?: number;
  cachedTokens?: number;
  version?: string;
  sessions?: ChatSession[];
  activeSessionId?: string;
  history?: StoredMessage[];
  switched?: boolean;
  attachedFiles?: { name: string; path: string }[];
  selectedSkills?: string[];
  skillGroups?: SkillGroup[];
  contextAnnotation?: string;
}

export interface FromWebview {
  type:
    | 'send' | 'switchModel' | 'cancel'
    | 'newSession' | 'switchSession'
    | 'attachFile' | 'pasteImage' | 'dropFiles' | 'clearAttachments'
    | 'toggleSkill' | 'renameSession' | 'deleteSession';
  text?: string;
  sessionId?: string;
  model?: string;
  data?: string;
  ext?: string;
  uris?: string[];
}

// ── Attachment ───────────────────────────────────────

export interface AttachedFile {
  name: string;
  path: string;
}
