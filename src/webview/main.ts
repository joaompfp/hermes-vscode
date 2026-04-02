/**
 * Webview entry point — runs in the sandboxed browser context.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { ToWebview, FromWebview, StoredMessage } from '../chatPanel';

function fmtTok(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function fmtAge(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

declare function acquireVsCodeApi(): { postMessage(msg: FromWebview): void; };
const vscode = acquireVsCodeApi();

marked.setOptions({ breaks: true, gfm: true });

// DOM refs
const messagesEl       = document.getElementById('messages')!;
const inputEl          = document.getElementById('input') as HTMLTextAreaElement;
const attachBtn        = document.getElementById('attach-btn') as HTMLButtonElement;
const attachChip       = document.getElementById('attach-chip') as HTMLDivElement;
const sendBtn          = document.getElementById('send-btn') as HTMLButtonElement;
const busyBtns         = document.getElementById('busy-btns') as HTMLDivElement;
const stopBtn          = document.getElementById('stop-btn') as HTMLButtonElement;
const queueBtn         = document.getElementById('queue-btn') as HTMLButtonElement;
const queueStatus      = document.getElementById('queue-status') as HTMLDivElement;
const dragHandle       = document.getElementById('input-drag') as HTMLDivElement;
const inputRow         = document.getElementById('input-row') as HTMLDivElement;
const statusSessionEl  = document.getElementById('status-session') as HTMLButtonElement;
const statusContextEl  = document.getElementById('status-context')!;
const statusVersionEl  = document.getElementById('status-version')!;
const ctxBarWrap       = document.getElementById('ctx-bar-wrap') as HTMLDivElement;
const ctxBar           = document.getElementById('ctx-bar') as HTMLDivElement;
const modelBtn         = document.getElementById('model-btn') as HTMLButtonElement;
const modelBtnHeader   = document.getElementById('model-btn-header') as HTMLButtonElement;
const modelMenu        = document.getElementById('model-menu') as HTMLDivElement;
const overflowBtn      = document.getElementById('overflow-btn') as HTMLButtonElement;
const overflowMenu     = document.getElementById('overflow-menu') as HTMLDivElement;
const emptyState       = document.getElementById('empty-state') as HTMLDivElement;
const sessionPicker    = document.getElementById('session-picker') as HTMLDivElement;
const logoMark         = document.getElementById('logo-mark')!;

// ── Drag handle ───────────────────────────────────────
let dragActive = false, dragStartY = 0, dragStartH = 0;
dragHandle.addEventListener('mousedown', (e: MouseEvent) => {
  dragActive = true; dragStartY = e.clientY; dragStartH = inputEl.offsetHeight;
  document.body.style.userSelect = 'none'; e.preventDefault();
});
document.addEventListener('mousemove', (e: MouseEvent) => {
  if (!dragActive) return;
  inputEl.style.height = `${Math.max(44, Math.min(400, dragStartH + (dragStartY - e.clientY)))}px`;
});
document.addEventListener('mouseup', () => {
  if (dragActive) { dragActive = false; document.body.style.userSelect = ''; }
});

// ── State ─────────────────────────────────────────────
let knownContextSize = 0;
let currentModel = '';
let currentActiveSessionId = '';
let isBusy = false;

// Current turn streaming state
let currentAgentEl: HTMLElement | null = null;
let currentAgentText = '';
let thinkingStatusEl: HTMLElement | null = null;
let pendingText = '';
let flushScheduled = false;
let markdownDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingQueuedTexts: string[] = [];
let prevQueueCount = 0;

// ── Todo overlay ──────────────────────────────────────
const todoOverlay = document.getElementById('todo-overlay')!;

interface TodoItem { id?: string; content: string; status: string; activeForm?: string; }

const TODO_ICONS: Record<string, string> = {
  completed: '✓', in_progress: '■', pending: '□', cancelled: '✗',
};

function renderTodoOverlay(todos: TodoItem[]): void {
  if (!todos.length) { todoOverlay.style.display = 'none'; return; }
  const completed = todos.filter(t => t.status === 'completed').length;
  const total = todos.length;
  const items = todos.map(t => {
    const icon = TODO_ICONS[t.status] ?? '□';
    const cls = t.status;
    const text = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
    return `<div class="todo-item">
      <span class="todo-icon ${cls}">${icon}</span>
      <span class="todo-text ${cls}">${DOMPurify.sanitize(text)}</span>
    </div>`;
  }).join('');
  todoOverlay.innerHTML = `<div class="todo-header">Tasks ${completed}/${total}</div>${items}`;
  todoOverlay.style.display = 'block';
}

/** Try to detect and parse todo JSON from tool output or agent text. */
function detectTodoUpdate(text: string): boolean {
  // Look for JSON with "todos" array
  const match = /\{[\s\S]*"todos"\s*:\s*\[[\s\S]*\][\s\S]*\}/.exec(text);
  if (!match) return false;
  try {
    const data = JSON.parse(match[0]);
    if (Array.isArray(data.todos) && data.todos.length > 0) {
      renderTodoOverlay(data.todos);
      return true;
    }
  } catch { /* not valid JSON */ }
  return false;
}

// ── Tool kind → display label mapping ─────────────────
const KIND_LABELS: Record<string, string> = {
  read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move',
  search: 'Search', execute: 'Bash', think: 'Think',
  fetch: 'Fetch', switch_mode: 'Mode', other: 'Tool',
};

/** Build a clean tool display: kind label + file path or title detail. */
function formatToolDisplay(
  title: string, kind?: string, locations?: string[], detail?: string
): { label: string; info: string } {
  const label = KIND_LABELS[kind ?? ''] ?? title.split(':')[0]?.trim() ?? 'Tool';

  // Prefer file path from locations, fall back to title detail
  if (locations?.length) {
    const shortPath = locations[0].replace(/^\/home\/[^/]+\//, '~/');
    return { label, info: shortPath };
  }
  // Extract useful part from title (after the colon)
  const colonIdx = title.indexOf(':');
  if (colonIdx > 0) {
    const info = title.slice(colonIdx + 1).trim();
    return { label, info: info.length > 70 ? info.slice(0, 67) + '…' : info };
  }
  return { label, info: detail ?? '' };
}

// ── Helpers ───────────────────────────────────────────
function appendDiv(className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  messagesEl.appendChild(el);
  return el;
}

function appendMessage(role: 'user' | 'agent' | 'tool' | 'error', text: string): HTMLElement {
  const el = appendDiv(`msg ${role}`);
  el.textContent = text;
  el.scrollIntoView({ block: 'end' });
  return el;
}

function renderMarkdown(el: HTMLElement, text: string): void {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text) as string, {
    ALLOWED_TAGS: ['p','br','strong','em','del','code','pre','ul','ol','li',
      'blockquote','h1','h2','h3','h4','h5','h6','a','hr','table','thead','tbody','tr','th','td',
      'img'],
    ALLOWED_ATTR: ['href', 'title', 'class', 'src', 'alt'],
  });
  el.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  // Add copy buttons to code blocks
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

function showWaiting(): void {
  const el = appendDiv('status-line');
  el.id = 'waiting'; el.textContent = '…';
  el.scrollIntoView({ block: 'end' });
}

function setBusy(active: boolean, queued = 0): void {
  isBusy = active;
  logoMark.classList.toggle('busy', active);
  inputEl.classList.toggle('busy-glow', active);
  sendBtn.style.display = active ? 'none' : 'block';
  busyBtns.style.display = active ? 'flex' : 'none';
  if (queued > 0) {
    queueStatus.style.display = 'block';
    queueStatus.textContent = `${queued} queued`;
  } else {
    queueStatus.style.display = 'none';
    queueStatus.textContent = '';
  }
  requestAnimationFrame(syncComposerHeight);
}

function syncComposerHeight(): void {
  const target = Math.max(44, inputRow.offsetHeight - 10);
  inputEl.style.height = `${target}px`;
}

function closeAllDropdowns(): void {
  modelMenu.style.display = 'none';
  sessionPicker.style.display = 'none';
  skillsMenu.style.display = 'none';
  overflowMenu.style.display = 'none';
}

// ── RAF batching ──────────────────────────────────────
function scheduleMarkdownRender(): void {
  if (markdownDebounceTimer) clearTimeout(markdownDebounceTimer);
  markdownDebounceTimer = setTimeout(() => {
    markdownDebounceTimer = null;
    if (currentAgentEl && currentAgentText) {
      renderMarkdown(currentAgentEl, currentAgentText);
      currentAgentEl.scrollIntoView({ block: 'end' });
    }
  }, 400);
}

function flushPending(): void {
  if (!pendingText) { flushScheduled = false; return; }
  if (!currentAgentEl) {
    document.getElementById('turn-thinking')?.remove();
    document.getElementById('waiting')?.remove();
    currentAgentEl = appendDiv('msg agent');
  }
  currentAgentText += pendingText;
  currentAgentEl.textContent = currentAgentText;
  pendingText = ''; flushScheduled = false;
  currentAgentEl.scrollIntoView({ block: 'end' });
  scheduleMarkdownRender();
}

function scheduleFlush(): void {
  if (!flushScheduled) {
    flushScheduled = true;
    setTimeout(flushPending, 0);
  }
}

// ── Status bar updates ────────────────────────────────
function updateStatusBar(model?: string, sessionTitle?: string, contextUsed?: number, contextSize?: number, version?: string): void {
  if (version !== undefined) statusVersionEl.textContent = version ? ` ${version}` : '';
  if (model) {
    currentModel = model;
    // Find the display label from the menu (match by command or model ID suffix)
    let displayLabel = model;
    modelMenu.querySelectorAll<HTMLElement>('.model-option').forEach(el => {
      const cmd = el.dataset.command ?? '';
      const isMatch = cmd === model || cmd.endsWith(':' + model);
      el.classList.toggle('active', isMatch);
      if (isMatch) {
        // Extract just the label text (before any suffix spans)
        const clone = el.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('span').forEach(s => s.remove());
        displayLabel = clone.textContent?.trim() || model;
      }
    });
    modelBtn.textContent = `${displayLabel} ▾`;
    modelBtnHeader.textContent = `${displayLabel} ▾`;
  }
  if (sessionTitle) statusSessionEl.textContent = sessionTitle;
  if (contextSize && contextSize > 0) knownContextSize = contextSize;
  if (contextUsed !== undefined) {
    const size = knownContextSize;
    if (size > 0) {
      const pct = Math.min(1, contextUsed / size);
      const cls = pct > 0.9 ? 'crit' : pct > 0.7 ? 'warn' : '';
      statusContextEl.innerHTML = `<span style="color:var(--gold);font-weight:600">${fmtTok(contextUsed)}</span> / ${fmtTok(size)}`;
      statusContextEl.className = cls;
      ctxBar.style.width = `${(pct * 100).toFixed(1)}%`;
      ctxBar.className = cls;
      ctxBarWrap.style.display = 'block';
    } else {
      statusContextEl.textContent = `${fmtTok(contextUsed)} tok`;
      statusContextEl.className = '';
      ctxBarWrap.style.display = 'none';
    }
  }
}

// ── Session picker ────────────────────────────────────
function buildSessionPicker(sessions: { id: string; title: string; createdAt: number }[], activeId: string): void {
  currentActiveSessionId = activeId;
  const active = sessions.find(s => s.id === activeId);
  if (active) statusSessionEl.textContent = active.title;

  sessionPicker.replaceChildren();

  for (const s of sessions) {
    const isActive = s.id === activeId;
    const item = document.createElement('div');
    item.className = `menu-item${isActive ? ' active' : ''}`;
    item.dataset.sessionId = s.id;

    if (isActive) {
      item.append('✓ ');
    }

    const title = document.createElement('span');
    title.style.overflow = 'hidden';
    title.style.textOverflow = 'ellipsis';
    title.style.flex = '1';
    title.textContent = s.title;
    item.appendChild(title);

    const meta = document.createElement('span');
    meta.className = 'item-meta';
    meta.textContent = fmtAge(s.createdAt);
    item.appendChild(meta);

    const rename = document.createElement('span');
    rename.className = 'session-action rename-session';
    rename.dataset.sessionId = s.id;
    rename.title = 'Rename';
    rename.textContent = '✎';
    item.appendChild(rename);

    const del = document.createElement('span');
    del.className = 'session-action delete-session';
    del.dataset.sessionId = s.id;
    del.title = 'Delete';
    del.textContent = '✕';
    item.appendChild(del);

    sessionPicker.appendChild(item);
  }

  const footer = document.createElement('div');
  footer.className = 'menu-footer';
  footer.textContent = '＋ New session';
  sessionPicker.appendChild(footer);
}

statusSessionEl.addEventListener('click', (e: MouseEvent) => {
  e.stopPropagation();
  const open = sessionPicker.style.display !== 'none';
  closeAllDropdowns();
  if (!open) sessionPicker.style.display = 'block';
});

sessionPicker.addEventListener('click', (e: MouseEvent) => {
  const target = e.target as HTMLElement;

  // Rename button — delegates to extension host's showInputBox
  const renameBtn = target.closest<HTMLElement>('.rename-session');
  if (renameBtn?.dataset.sessionId) {
    e.stopPropagation();
    closeAllDropdowns();
    vscode.postMessage({ type: 'renameSession', sessionId: renameBtn.dataset.sessionId } as any);
    return;
  }

  // Delete button
  const deleteBtn = target.closest<HTMLElement>('.delete-session');
  if (deleteBtn?.dataset.sessionId) {
    e.stopPropagation();
    vscode.postMessage({ type: 'deleteSession', sessionId: deleteBtn.dataset.sessionId } as any);
    return;
  }

  // Switch session or new session
  const opt = target.closest<HTMLElement>('.menu-item[data-session-id]');
  const newBtn = target.closest<HTMLElement>('.menu-footer');
  closeAllDropdowns();
  if (opt?.dataset.sessionId && opt.dataset.sessionId !== currentActiveSessionId) {
    vscode.postMessage({ type: 'switchSession', sessionId: opt.dataset.sessionId });
  } else if (newBtn) {
    vscode.postMessage({ type: 'newSession' });
  }
});

// ── Model switcher (header button opens the hidden bottom bar menu) ──
modelBtnHeader.addEventListener('click', (e: MouseEvent) => {
  e.stopPropagation();
  const open = modelMenu.style.display !== 'none';
  closeAllDropdowns();
  if (!open) modelMenu.style.display = 'block';
});
modelBtn.addEventListener('click', (e: MouseEvent) => {
  e.stopPropagation();
  const open = modelMenu.style.display !== 'none';
  closeAllDropdowns();
  if (!open) modelMenu.style.display = 'block';
});

// ── Overflow menu ────────────────────────────────────
overflowBtn.addEventListener('click', (e: MouseEvent) => {
  e.stopPropagation();
  const open = overflowMenu.style.display !== 'none';
  closeAllDropdowns();
  if (!open) overflowMenu.style.display = 'block';
});
overflowMenu.addEventListener('click', (e: MouseEvent) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>('.menu-item[data-cmd]');
  if (!item?.dataset.cmd) return;
  closeAllDropdowns();
  vscode.postMessage({ type: 'send', text: item.dataset.cmd });
});

// ── Empty state prompt chips ─────────────────────────
emptyState?.addEventListener('click', (e: MouseEvent) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.prompt-chip');
  if (!chip?.dataset.prompt) return;
  inputEl.value = chip.dataset.prompt;
  inputEl.focus();
});

modelMenu.addEventListener('click', (e: MouseEvent) => {
  const opt = (e.target as HTMLElement).closest<HTMLElement>('.model-option');
  if (!opt?.dataset.command) return;
  closeAllDropdowns();
  vscode.postMessage({ type: 'switchModel', model: opt.dataset.command });
});

document.addEventListener('click', closeAllDropdowns);

// ── File attachment ───────────────────────────────
attachBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'attachFile' });
});

attachChip.addEventListener('click', (e: MouseEvent) => {
  if ((e.target as HTMLElement).classList.contains('chip-x')) {
    attachChip.style.display = 'none';
    attachChip.innerHTML = '';
    // Tell extension to clear attachments
    vscode.postMessage({ type: 'clearAttachments' } as any);
  }
});

// ── Clipboard paste (images) ──────────────────────────
// Listen on document — textarea won't fire paste for image data
document.addEventListener('paste', (e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) return;
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        const ext = item.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
        vscode.postMessage({ type: 'pasteImage', data: base64, ext } as any);
      };
      reader.readAsDataURL(blob);
      return;
    }
  }
  // Fallback: check files array (some browsers put images there instead)
  const files = e.clipboardData?.files;
  if (files) {
    for (let i = 0; i < files.length; i++) {
      if (files[i].type.startsWith('image/')) {
        e.preventDefault();
        const reader = new FileReader();
        const ext = files[i].type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1];
          vscode.postMessage({ type: 'pasteImage', data: base64, ext } as any);
        };
        reader.readAsDataURL(files[i]);
        return;
      }
    }
  }
});

// ── Drag & drop from VS Code explorer ─────────────────
document.body.addEventListener('dragover', (e: DragEvent) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  messagesEl.style.outline = '2px dashed rgba(245,197,66,0.5)';
  messagesEl.style.outlineOffset = '-4px';
});

document.body.addEventListener('dragleave', () => {
  messagesEl.style.outline = '';
  messagesEl.style.outlineOffset = '';
});

document.body.addEventListener('drop', (e: DragEvent) => {
  e.preventDefault();
  messagesEl.style.outline = '';
  messagesEl.style.outlineOffset = '';
  // VS Code explorer drops provide text/uri-list
  const uriList = e.dataTransfer?.getData('text/uri-list');
  if (uriList) {
    const paths = uriList.split('\n').map(u => u.trim()).filter(Boolean);
    if (paths.length > 0) {
      vscode.postMessage({ type: 'dropFiles', uris: paths } as any);
    }
  }
});

// ── Skills picker ─────────────────────────────────────
const skillsBtn = document.getElementById('skills-btn') as HTMLButtonElement;
const skillsMenu = document.getElementById('skills-menu') as HTMLDivElement;
let skillGroupsData: { category: string; skills: { name: string; description: string }[] }[] = [];
let selectedSkillNames = new Set<string>();

function buildSkillsMenu(): void {
  skillsMenu.replaceChildren();

  for (const group of skillGroupsData) {
    const label = document.createElement('div');
    label.className = 'skill-group-label';
    label.textContent = group.category;
    skillsMenu.appendChild(label);

    for (const skill of group.skills) {
      const option = document.createElement('div');
      option.className = `skill-option${selectedSkillNames.has(skill.name) ? ' selected' : ''}`;
      option.dataset.skill = skill.name;
      option.append(document.createTextNode(skill.name));

      if (skill.description) {
        option.append(document.createTextNode(' '));
        const desc = document.createElement('span');
        desc.className = 'skill-desc';
        desc.textContent = skill.description;
        option.appendChild(desc);
      }

      skillsMenu.appendChild(option);
    }
  }
}

skillsBtn.addEventListener('click', (e: MouseEvent) => {
  e.stopPropagation();
  const open = skillsMenu.style.display !== 'none';
  closeAllDropdowns();
  if (!open) {
    buildSkillsMenu();
    skillsMenu.style.display = 'block';
  }
});

skillsMenu.addEventListener('click', (e: MouseEvent) => {
  const opt = (e.target as HTMLElement).closest<HTMLElement>('.skill-option');
  if (!opt?.dataset.skill) return;
  e.stopPropagation();
  const name = opt.dataset.skill;
  if (selectedSkillNames.has(name)) {
    selectedSkillNames.delete(name);
  } else {
    selectedSkillNames.add(name);
  }
  // Update button state
  skillsBtn.classList.toggle('has-skills', selectedSkillNames.size > 0);
  skillsBtn.textContent = selectedSkillNames.size > 0 ? `✦${selectedSkillNames.size}` : '✦';
  // Toggle visual in menu
  opt.classList.toggle('selected');
  // Notify extension
  vscode.postMessage({ type: 'toggleSkill', text: name } as any);
});

// ── Slash command buttons ─────────────────────────────
document.querySelectorAll<HTMLButtonElement>('.cmd-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const cmd = btn.dataset.cmd;
    if (!cmd) return;
    if (!isBusy) {
      currentAgentEl = null; currentAgentText = ''; thinkingStatusEl = null; pendingText = '';
      showWaiting();
    }
    vscode.postMessage({ type: 'send', text: cmd });
  });
});

// ── Send ──────────────────────────────────────────────
stopBtn.addEventListener('click', () => { vscode.postMessage({ type: 'cancel' }); });

function send(): void {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  // Hide empty state on first message
  if (emptyState) emptyState.style.display = 'none';
  inputEl.style.height = '';
  // Clear attachment chip + skills after send
  attachChip.style.display = 'none';
  attachChip.innerHTML = '';
  selectedSkillNames.clear();
  skillsBtn.classList.remove('has-skills');
  skillsBtn.textContent = '✦';
  if (!isBusy) {
    appendMessage('user', text);
    currentAgentEl = null; currentAgentText = ''; thinkingStatusEl = null; pendingText = '';
    showWaiting();
  } else {
    pendingQueuedTexts.push(text);
  }
  vscode.postMessage({ type: 'send', text });
  requestAnimationFrame(syncComposerHeight);
}

queueBtn.addEventListener('click', send);
sendBtn.addEventListener('click', send);
inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

window.addEventListener('resize', () => {
  requestAnimationFrame(syncComposerHeight);
});

requestAnimationFrame(syncComposerHeight);

// ── Load stored history ───────────────────────────────
function loadHistory(history: StoredMessage[], isSwitched = false): void {
  if (emptyState && history.length > 0) emptyState.style.display = 'none';
  for (const m of history) {
    if (m.role === 'user') {
      appendMessage('user', m.text);
    } else if (m.role === 'agent') {
      const el = appendDiv('msg agent');
      renderMarkdown(el, m.text);
      el.scrollIntoView({ block: 'end' });
    } else if (m.role === 'tool') {
      const toolEl = appendDiv('msg tool');
      const isError = m.text.startsWith('✗');
      const isPending = m.text.startsWith('⋯');
      const icon = isError ? '✗' : isPending ? '⋯' : '✓';
      const cls = isError ? ' error' : isPending ? '' : ' done';
      const cleaned = DOMPurify.sanitize(m.text.replace(/^[✓✗⋯]\s*/, ''));
      // Split "toolName: detail" format
      const colonIdx = cleaned.indexOf(':');
      const name = colonIdx > 0 ? cleaned.slice(0, colonIdx).trim() : cleaned;
      const detail = colonIdx > 0 ? `<span class="tool-detail">${cleaned.slice(colonIdx + 1).trim()}</span>` : '';
      toolEl.innerHTML = `<span class="tool-status${cls}">${icon}</span><span class="tool-name">${name}</span>${detail}`;
    } else if (m.role === 'error') {
      appendMessage('error', m.text);
    }
  }
  if (isSwitched && history.length > 0) {
    const divider = appendDiv('history-divider');
    divider.textContent = '— Hermes context reset — new messages start fresh —';
    divider.scrollIntoView({ block: 'end' });
  }
}

// ── Message handler ───────────────────────────────────
window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as ToWebview;

  switch (msg.type) {
    case 'append': {
      pendingText += msg.text ?? '';
      scheduleFlush();
      break;
    }

    case 'thinking': {
      if (!thinkingStatusEl) {
        document.getElementById('waiting')?.remove();
        thinkingStatusEl = appendDiv('status-line thinking-status');
        thinkingStatusEl.id = 'turn-thinking';
      }
      thinkingStatusEl.textContent = msg.text ?? '';
      break;
    }

    case 'toolCall': {
      // Status update for an existing tool call element
      if (!msg.toolName && msg.toolCallId) {
        const existing = document.querySelector(`[data-tool-id="${msg.toolCallId}"]`);
        if (existing) {
          const isDone = msg.toolStatus === 'done' || msg.toolStatus === 'completed';
          const isError = msg.toolStatus === 'error';
          const statusEl = existing.querySelector('.tool-status');
          if (statusEl) {
            statusEl.textContent = isDone ? '✓' : isError ? '✗' : '⋯';
            statusEl.className = `tool-status${isDone ? ' done' : isError ? ' error' : ''}`;
          }
          // Update circle color class
          existing.classList.toggle('tool-done', isDone);
          existing.classList.toggle('tool-error', isError);
        }
        break;
      }
      // New tool call
      if (pendingText) flushPending();
      if (currentAgentEl && currentAgentText) renderMarkdown(currentAgentEl, currentAgentText);
      currentAgentEl = null; currentAgentText = '';
      document.getElementById('waiting')?.remove();
      const isDone = msg.toolStatus === 'done' || msg.toolStatus === 'completed';
      const isError = msg.toolStatus === 'error';
      const statusIcon = isDone ? '✓' : isError ? '✗' : '⋯';
      const statusClass = isDone ? ' done' : isError ? ' error' : '';
      const toolEl = appendDiv('msg tool');
      if (msg.toolCallId) toolEl.dataset.toolId = msg.toolCallId;
      const { label, info } = formatToolDisplay(
        msg.toolName ?? '', msg.toolKind, msg.toolLocations, msg.toolDetail
      );
      const infoHtml = info ? `<span class="tool-detail">${DOMPurify.sanitize(info)}</span>` : '';
      toolEl.innerHTML = `<span class="tool-status${statusClass}">${statusIcon}</span><span class="tool-name">${label}</span>${infoHtml}`;
      toolEl.scrollIntoView({ block: 'end' });
      break;
    }

    case 'busy': {
      const newQueued = msg.queued ?? 0;
      if (msg.active && newQueued < prevQueueCount) {
        if (pendingQueuedTexts.length > 0) appendMessage('user', pendingQueuedTexts.shift()!);
        currentAgentEl = null; currentAgentText = ''; thinkingStatusEl = null; pendingText = '';
        showWaiting();
      }
      prevQueueCount = newQueued;
      setBusy(msg.active ?? false, newQueued);
      break;
    }

    case 'done': {
      if (pendingText) flushPending();
      if (markdownDebounceTimer) { clearTimeout(markdownDebounceTimer); markdownDebounceTimer = null; }
      document.getElementById('waiting')?.remove();
      document.getElementById('turn-thinking')?.remove();
      if (currentAgentEl && currentAgentText) {
        // Check for todo updates in agent text before markdown render
        detectTodoUpdate(currentAgentText);
        renderMarkdown(currentAgentEl, currentAgentText);
        currentAgentEl.scrollIntoView({ block: 'end' });
      }
      currentAgentEl = null; currentAgentText = ''; thinkingStatusEl = null;
      inputEl.focus();
      break;
    }

    case 'error': {
      if (pendingText) flushPending();
      if (markdownDebounceTimer) { clearTimeout(markdownDebounceTimer); markdownDebounceTimer = null; }
      document.getElementById('waiting')?.remove();
      document.getElementById('turn-thinking')?.remove();
      appendMessage('error', `Error: ${msg.text}`);
      currentAgentEl = null; currentAgentText = ''; thinkingStatusEl = null;
      break;
    }

    case 'status': {
      if (msg.status === 'connecting')       appendMessage('tool', 'Connecting to Hermes…');
      else if (msg.status === 'connected')   appendMessage('tool', 'Connected');
      else if (msg.status === 'disconnected') {
        appendMessage('error', 'Hermes disconnected');
        setBusy(false);
      }
      break;
    }

    case 'clear': {
      messagesEl.innerHTML = '';
      pendingQueuedTexts = []; prevQueueCount = 0; knownContextSize = 0; flushScheduled = false;
      ctxBarWrap.style.display = 'none';
      currentAgentEl = null; currentAgentText = ''; thinkingStatusEl = null; pendingText = '';
      setBusy(false);
      statusContextEl.textContent = ''; statusContextEl.className = '';
      break;
    }

    case 'statusBar': {
      updateStatusBar(msg.model, msg.sessionTitle, msg.contextUsed, msg.contextSize, msg.version);
      // Load skill groups on init
      if (msg.skillGroups && msg.skillGroups.length > 0) {
        skillGroupsData = msg.skillGroups;
      }
      // Reset selected skills display
      if (msg.selectedSkills !== undefined) {
        selectedSkillNames = new Set(msg.selectedSkills);
        skillsBtn.classList.toggle('has-skills', selectedSkillNames.size > 0);
        skillsBtn.textContent = selectedSkillNames.size > 0 ? `✦${selectedSkillNames.size}` : '✦';
      }
      // Todo state from Hermes todo tool
      if (msg.todoState && typeof msg.todoState === 'object') {
        const state = msg.todoState as { todos?: TodoItem[] };
        if (state.todos) renderTodoOverlay(state.todos);
      }
      // Context annotation — append structured items to last user bubble
      if (msg.contextAnnotation) {
        const userMsgs = messagesEl.querySelectorAll('.msg.user');
        const lastUser = userMsgs[userMsgs.length - 1];
        if (lastUser) {
          const anno = document.createElement('div');
          anno.className = 'context-annotation';
          anno.innerHTML = DOMPurify.sanitize(msg.contextAnnotation, {
            ALLOWED_TAGS: ['span'],
            ALLOWED_ATTR: ['class'],
          });
          lastUser.appendChild(anno);
        }
      }
      // Handle attached file chips (multiple)
      if (msg.attachedFiles !== undefined) {
        if (msg.attachedFiles && msg.attachedFiles.length > 0) {
          attachChip.replaceChildren();
          msg.attachedFiles.forEach((f: {name: string}) => {
            attachChip.append(document.createTextNode('⊕ '));
            const chip = document.createElement('span');
            chip.className = 'chip-name';
            chip.textContent = f.name;
            attachChip.appendChild(chip);
            attachChip.append(document.createTextNode(' '));
          });
          const clear = document.createElement('span');
          clear.className = 'chip-x';
          clear.textContent = '✕';
          attachChip.appendChild(clear);
          attachChip.style.display = 'flex';
        } else {
          attachChip.style.display = 'none';
          attachChip.innerHTML = '';
        }
      }
      break;
    }

    case 'sessionList': {
      if (msg.sessions && msg.activeSessionId !== undefined) {
        buildSessionPicker(msg.sessions, msg.activeSessionId);
      }
      break;
    }

    case 'loadHistory': {
      const isSwitched = msg.switched ?? false;
      loadHistory(msg.history ?? [], isSwitched);
      break;
    }
  }
});
