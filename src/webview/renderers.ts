/**
 * Webview rendering functions — markdown, tool calls, todo overlay, history.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { StoredMessage, TodoItem } from '../types';

// ── Markdown ─────────────────────────────────────────

export function renderMarkdown(el: HTMLElement, text: string): void {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text) as string, {
    ALLOWED_TAGS: ['p','br','strong','em','del','code','pre','ul','ol','li',
      'blockquote','h1','h2','h3','h4','h5','h6','a','hr','table','thead','tbody','tr','th','td',
      'img'],
    ALLOWED_ATTR: ['href', 'title', 'class', 'src', 'alt'],
  });
  el.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  // Copy buttons on code blocks
  el.querySelectorAll('pre').forEach(pre => {
    const btn = document.createElement('button');
    btn.className = 'copy-btn'; btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? '';
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = '✓'; btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
      });
    });
    pre.appendChild(btn);
  });
}

// ── DOM helpers ──────────────────────────────────────

export function appendDiv(container: HTMLElement, className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  container.appendChild(el);
  return el;
}

export function appendMessage(container: HTMLElement, role: 'user' | 'agent' | 'tool' | 'error', text: string): HTMLElement {
  const el = appendDiv(container, `msg ${role}`);
  el.textContent = text;
  el.scrollIntoView({ block: 'end' });
  return el;
}

export function showWaiting(container: HTMLElement): void {
  const el = appendDiv(container, 'status-line');
  el.id = 'waiting'; el.textContent = '…';
  el.scrollIntoView({ block: 'end' });
}

// ── Tool display ─────────────────────────────────────

const KIND_LABELS: Record<string, string> = {
  read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move',
  search: 'Search', execute: 'Bash', think: 'Think',
  fetch: 'Fetch', switch_mode: 'Mode', other: 'Tool',
};

export function formatToolDisplay(
  title: string, kind?: string, locations?: string[], detail?: string
): { label: string; info: string } {
  const label = KIND_LABELS[kind ?? ''] ?? title.split(':')[0]?.trim() ?? 'Tool';
  if (locations?.length) {
    const shortPath = locations[0].replace(/^\/home\/[^/]+\//, '~/');
    return { label, info: shortPath };
  }
  const colonIdx = title.indexOf(':');
  if (colonIdx > 0) {
    const info = title.slice(colonIdx + 1).trim();
    return { label, info: info.length > 70 ? info.slice(0, 67) + '…' : info };
  }
  return { label, info: detail ?? '' };
}

// ── Todo overlay ─────────────────────────────────────

const TODO_ICONS: Record<string, string> = {
  completed: '✓', in_progress: '■', pending: '□', cancelled: '✗',
};

export function renderTodoOverlay(container: HTMLElement, todos: TodoItem[]): void {
  if (!todos.length) { container.style.display = 'none'; return; }
  const completed = todos.filter(t => t.status === 'completed').length;
  const items = todos.map(t => {
    const icon = TODO_ICONS[t.status] ?? '□';
    const text = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
    return `<div class="todo-item">
      <span class="todo-icon ${t.status}">${icon}</span>
      <span class="todo-text ${t.status}">${DOMPurify.sanitize(text)}</span>
    </div>`;
  }).join('');
  container.innerHTML = `<div class="todo-header">Tasks ${completed}/${todos.length}</div>${items}`;
  container.style.display = 'block';
}

export function detectTodoUpdate(text: string, container: HTMLElement): boolean {
  const match = /\{[\s\S]*"todos"\s*:\s*\[[\s\S]*\][\s\S]*\}/.exec(text);
  if (!match) return false;
  try {
    const data = JSON.parse(match[0]);
    if (Array.isArray(data.todos) && data.todos.length > 0) {
      renderTodoOverlay(container, data.todos);
      return true;
    }
  } catch { /* not valid JSON */ }
  return false;
}

// ── History loading ──────────────────────────────────

export function loadHistory(
  container: HTMLElement, history: StoredMessage[], isSwitched = false
): void {
  if (history.length === 0) return;
  const emptyState = document.getElementById('empty-state');
  if (emptyState) emptyState.style.display = 'none';

  for (const m of history) {
    if (m.role === 'user') {
      appendMessage(container, 'user', m.text);
    } else if (m.role === 'agent') {
      const el = appendDiv(container, 'msg agent');
      renderMarkdown(el, m.text);
      el.scrollIntoView({ block: 'end' });
    } else if (m.role === 'tool') {
      const toolEl = appendDiv(container, 'msg tool');
      const isError = m.text.startsWith('✗');
      const isPending = m.text.startsWith('⋯');
      const icon = isError ? '✗' : isPending ? '⋯' : '✓';
      const cls = isError ? ' error' : isPending ? '' : ' done';
      const cleaned = DOMPurify.sanitize(m.text.replace(/^[✓✗⋯]\s*/, ''));
      const colonIdx = cleaned.indexOf(':');
      const name = DOMPurify.sanitize(colonIdx > 0 ? cleaned.slice(0, colonIdx).trim() : cleaned);
      const detail = colonIdx > 0 ? `<span class="tool-detail">${DOMPurify.sanitize(cleaned.slice(colonIdx + 1).trim())}</span>` : '';
      toolEl.innerHTML = `<span class="tool-status${cls}">${icon}</span><span class="tool-name">${name}</span>${detail}`;
    } else if (m.role === 'error') {
      appendMessage(container, 'error', m.text);
    }
  }
  if (isSwitched) {
    const divider = appendDiv(container, 'history-divider');
    divider.textContent = '— Hermes context reset — new messages start fresh —';
    divider.scrollIntoView({ block: 'end' });
  }
}

// ── Formatting ───────────────────────────────────────

export function fmtTok(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

export function fmtAge(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}
