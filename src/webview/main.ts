/**
 * Webview entry point — thin wiring layer.
 * Imports modules, grabs DOM refs, connects event handlers.
 */

import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { ToWebview, FromWebview, TodoItem } from '../types';
import { createInitialState } from './state';
import {
  renderMarkdown, appendDiv, appendMessage, showWaiting,
  formatToolDisplay, renderTodoOverlay, detectTodoUpdate,
  loadHistory, fmtTok,
} from './renderers';
import {
  closeAllDropdowns, buildSessionPicker, setupSessionPickerHandlers,
  buildSkillsMenu, setupSkillsHandlers, updateStatusBar,
} from './menus';

declare function acquireVsCodeApi(): { postMessage(msg: FromWebview): void };
const vscode = acquireVsCodeApi();
marked.setOptions({ breaks: true, gfm: true });

// ── State ────────────────────────────────────────────
const S = createInitialState();

// ── DOM refs ─────────────────────────────────────────
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
const composer         = document.getElementById('composer') as HTMLDivElement;
const statusSessionEl  = document.getElementById('status-session') as HTMLButtonElement;
const statusContextEl  = document.getElementById('status-context')!;
const statusVersionEl  = document.getElementById('status-version')!;
const ctxBarWrap       = document.getElementById('ctx-bar-wrap') as HTMLDivElement;
const ctxBar           = document.getElementById('ctx-bar') as HTMLDivElement;
const ctxBarFresh      = document.getElementById('ctx-bar-fresh') as HTMLDivElement;
const modelBtnHeader   = document.getElementById('model-btn-header') as HTMLButtonElement;
const modelMenu        = document.getElementById('model-menu') as HTMLDivElement;
const overflowBtn      = document.getElementById('overflow-btn') as HTMLButtonElement;
const overflowMenu     = document.getElementById('overflow-menu') as HTMLDivElement;
const emptyState       = document.getElementById('empty-state') as HTMLDivElement;
const sessionPicker    = document.getElementById('session-picker') as HTMLDivElement;
const logoMark         = document.getElementById('logo-mark')!;
const todoOverlay      = document.getElementById('todo-overlay')!;
const skillsBtn        = document.getElementById('skills-btn') as HTMLButtonElement;
const skillsMenu       = document.getElementById('skills-menu') as HTMLDivElement;
const cmdArgPopover    = document.getElementById('cmd-arg-popover') as HTMLDivElement;
const cmdArgInput      = document.getElementById('cmd-arg-input') as HTMLInputElement;
const cmdArgLabel      = document.getElementById('cmd-arg-label') as HTMLElement;

const dropdownEls = { modelMenu, sessionPicker, skillsMenu, overflowMenu, cmdArgPopover };
const statusEls = { statusVersionEl, modelBtnHeader, modelMenu, statusSessionEl, statusContextEl, ctxBarWrap, ctxBar, ctxBarFresh };
const closeFn = () => closeAllDropdowns(dropdownEls);

// ── Helpers ──────────────────────────────────────────
function setBusy(active: boolean, queued = 0): void {
  S.isBusy = active;
  logoMark.classList.toggle('busy', active);
  composer.classList.toggle('busy-glow', active);
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

// Smart scroll — only auto-scroll if the user is near the bottom of the
// messages pane. If they've scrolled up to read earlier content, don't
// yank them back down. Threshold: within 80px of the bottom.
function shouldAutoScroll(): boolean {
  const el = messagesEl;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}
function autoScroll(): void {
  if (shouldAutoScroll()) messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
}

// Render markdown on a short interval (200ms). Each flush accumulates text
// and schedules a render — the timer coalesces bursts of chunks so we don't
// call marked.parse() on every single token, but still render frequently
// enough to avoid the "plaintext then jump to formatted" flash.
function scheduleMarkdownRender(): void {
  if (S.markdownDebounceTimer) return; // already scheduled
  S.markdownDebounceTimer = setTimeout(() => {
    S.markdownDebounceTimer = null;
    if (S.currentAgentEl && S.currentAgentText) {
      renderMarkdown(S.currentAgentEl, S.currentAgentText);
      autoScroll();
    }
  }, 200);
}

function flushPending(): void {
  if (!S.pendingText) { S.flushScheduled = false; return; }
  if (!S.currentAgentEl) {
    document.getElementById('turn-thinking')?.remove();
    document.getElementById('waiting')?.remove();
    S.currentAgentEl = appendDiv(messagesEl, 'msg agent');
  }
  S.currentAgentText += S.pendingText;
  S.pendingText = ''; S.flushScheduled = false;
  // Render markdown directly — no intermediate .textContent flash.
  // scheduleMarkdownRender coalesces at 100ms so rapid chunks don't
  // each trigger a full marked.parse() + innerHTML replacement.
  scheduleMarkdownRender();
}

function scheduleFlush(): void {
  if (!S.flushScheduled) { S.flushScheduled = true; setTimeout(flushPending, 0); }
}

// ── Slash command detection ─────────────────────────
// Hardcoded allowlist mirroring the ACP adapter's _SLASH_COMMANDS dict.
// Keep in sync with ~/.hermes/hermes-agent/acp_adapter/server.py. Commands
// not in this set are treated as prose and go to the LLM normally (so the
// user bubble renders). Matched commands hide the user bubble and the
// response renders as a centered system-style bubble instead of an agent bubble.
const KNOWN_SLASH_COMMANDS = new Set([
  'help', 'model', 'tools', 'context', 'reset', 'compact', 'version',
  'title', 'yolo', 'new', 'retry', 'status', 'usage', 'compress',
  'reasoning', 'save',
]);
function isSlashCommand(text: string): boolean {
  if (!text.startsWith('/')) return false;
  const first = text.slice(1).split(/\s/, 1)[0].toLowerCase();
  return KNOWN_SLASH_COMMANDS.has(first);
}

// ── Send ─────────────────────────────────────────────
function send(): void {
  const text = inputEl.value.trim();
  if (!text) return;
  const isSlash = isSlashCommand(text);
  inputEl.value = '';
  inputEl.style.height = '';
  attachChip.style.display = 'none'; attachChip.innerHTML = '';
  S.selectedSkillNames.clear();
  skillsBtn.classList.remove('has-skills'); skillsBtn.textContent = '✦';
  if (emptyState) emptyState.style.display = 'none';
  if (!S.isBusy) {
    // Slash commands don't reach the LLM — don't render a user bubble.
    // The response from the adapter will be styled as a system bubble on 'done'.
    if (!isSlash) appendMessage(messagesEl, 'user', text);
    S.currentAgentEl = null; S.currentAgentText = ''; S.thinkingStatusEl = null; S.pendingText = '';
    S.pendingSlashResponse = isSlash;
    if (!isSlash) showWaiting(messagesEl);
  } else {
    S.pendingQueuedTexts.push(text);
  }
  vscode.postMessage({ type: 'send', text });
  requestAnimationFrame(syncComposerHeight);
}

// ── Event wiring ─────────────────────────────────────

// Drag handle
let dragActive = false, dragStartY = 0, dragStartH = 0;
dragHandle.addEventListener('mousedown', (e) => {
  dragActive = true; dragStartY = e.clientY; dragStartH = inputEl.offsetHeight;
  document.body.style.userSelect = 'none'; e.preventDefault();
});
document.addEventListener('mousemove', (e) => {
  if (!dragActive) return;
  inputEl.style.height = `${Math.max(44, Math.min(400, dragStartH + (dragStartY - e.clientY)))}px`;
});
document.addEventListener('mouseup', () => {
  if (dragActive) { dragActive = false; document.body.style.userSelect = ''; }
});

// Session picker
statusSessionEl.addEventListener('click', (e) => {
  e.stopPropagation(); const open = sessionPicker.style.display !== 'none';
  closeFn(); if (!open) sessionPicker.style.display = 'block';
});
setupSessionPickerHandlers(sessionPicker, vscode, S, closeFn);

// Model switcher
modelBtnHeader.addEventListener('click', (e) => {
  e.stopPropagation(); const open = modelMenu.style.display !== 'none';
  closeFn(); if (!open) modelMenu.style.display = 'block';
});
modelMenu.addEventListener('click', (e) => {
  const opt = (e.target as HTMLElement).closest<HTMLElement>('.model-option');
  if (!opt?.dataset.command) return;
  closeFn(); vscode.postMessage({ type: 'switchModel', model: opt.dataset.command });
});

// Slash-command menu (hybrid dispatch: execute / confirm / prompt-for-arg)
function hideCmdArg(): void {
  cmdArgPopover.style.display = 'none';
  cmdArgInput.value = '';
  cmdArgInput.onkeydown = null;
}

function promptForArg(cmd: string, label: string): void {
  cmdArgLabel.textContent = label;
  cmdArgInput.value = '';
  cmdArgPopover.style.display = 'block';
  setTimeout(() => cmdArgInput.focus(), 0);
  cmdArgInput.onkeydown = (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const arg = cmdArgInput.value.trim();
      hideCmdArg();
      if (arg) vscode.postMessage({ type: 'send', text: `${cmd} ${arg}` });
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      hideCmdArg();
    }
  };
}

overflowBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = overflowMenu.style.display !== 'none';
  closeFn(); hideCmdArg();
  if (!open) overflowMenu.style.display = 'block';
});

overflowMenu.addEventListener('click', (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>('.menu-item[data-cmd]');
  if (!item?.dataset.cmd) return;
  e.stopPropagation();
  const cmd  = item.dataset.cmd;
  const mode = item.dataset.mode ?? 'execute';
  closeFn();

  if (mode === 'execute') {
    vscode.postMessage({ type: 'send', text: cmd });
  } else if (mode === 'confirm') {
    const msg = item.dataset.confirm ?? `Run ${cmd}?`;
    // eslint-disable-next-line no-alert
    if (confirm(msg)) vscode.postMessage({ type: 'send', text: cmd });
  } else if (mode === 'prompt') {
    promptForArg(cmd, item.dataset.argLabel ?? 'Argument');
  }
});

// Empty state prompt chips — send immediately on click
emptyState?.addEventListener('click', (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.prompt-chip');
  if (!chip?.dataset.prompt) return;
  inputEl.value = chip.dataset.prompt;
  send();
});

// File attachment
attachBtn.addEventListener('click', () => vscode.postMessage({ type: 'attachFile' }));
attachChip.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).classList.contains('chip-x')) {
    attachChip.style.display = 'none'; attachChip.innerHTML = '';
    vscode.postMessage({ type: 'clearAttachments' } as any);
  }
});

// Clipboard paste
document.addEventListener('paste', (e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.startsWith('image/')) {
      e.preventDefault();
      const blob = items[i].getAsFile();
      if (!blob) return;
      const reader = new FileReader();
      const ext = items[i].type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        vscode.postMessage({ type: 'pasteImage', data: base64, ext } as any);
      };
      reader.readAsDataURL(blob); return;
    }
  }
  const files = e.clipboardData?.files;
  if (files) {
    for (let i = 0; i < files.length; i++) {
      if (files[i].type.startsWith('image/')) {
        e.preventDefault();
        const ext = files[i].type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1];
          vscode.postMessage({ type: 'pasteImage', data: base64, ext } as any);
        };
        reader.readAsDataURL(files[i]); return;
      }
    }
  }
});

// Drag & drop
document.body.addEventListener('dragover', (e) => {
  e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  messagesEl.style.outline = '2px dashed rgba(245,197,66,0.5)';
  messagesEl.style.outlineOffset = '-4px';
});
document.body.addEventListener('dragleave', () => {
  messagesEl.style.outline = ''; messagesEl.style.outlineOffset = '';
});
document.body.addEventListener('drop', (e) => {
  e.preventDefault();
  messagesEl.style.outline = ''; messagesEl.style.outlineOffset = '';
  const uriList = e.dataTransfer?.getData('text/uri-list');
  if (uriList) {
    const paths = uriList.split('\n').map(u => u.trim()).filter(Boolean);
    if (paths.length > 0) vscode.postMessage({ type: 'dropFiles', uris: paths } as any);
  }
});

// Skills picker
skillsBtn.addEventListener('click', (e) => {
  e.stopPropagation(); const open = skillsMenu.style.display !== 'none';
  closeFn(); if (!open) { buildSkillsMenu(skillsMenu, S); skillsMenu.style.display = 'block'; }
});
setupSkillsHandlers(skillsMenu, skillsBtn, vscode, S);

// Slash commands
document.querySelectorAll<HTMLButtonElement>('.cmd-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const cmd = btn.dataset.cmd; if (!cmd) return;
    if (!S.isBusy) {
      S.currentAgentEl = null; S.currentAgentText = ''; S.thinkingStatusEl = null; S.pendingText = '';
      showWaiting(messagesEl);
    }
    vscode.postMessage({ type: 'send', text: cmd });
  });
});

// Send / stop / queue
stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
queueBtn.addEventListener('click', send);
sendBtn.addEventListener('click', send);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

// Close dropdowns on outside click
document.addEventListener('click', closeFn);

// Resize
window.addEventListener('resize', () => requestAnimationFrame(syncComposerHeight));
requestAnimationFrame(syncComposerHeight);

// ── Message handler ──────────────────────────────────
window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as ToWebview;

  switch (msg.type) {
    case 'append':
      S.pendingText += msg.text ?? '';
      scheduleFlush();
      break;

    case 'thinking':
      if (!S.thinkingStatusEl) {
        document.getElementById('waiting')?.remove();
        S.thinkingStatusEl = appendDiv(messagesEl, 'status-line thinking-status');
        S.thinkingStatusEl.id = 'turn-thinking';
      }
      S.thinkingStatusEl.textContent = msg.text ?? '';
      break;

    case 'toolCall': {
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
        }
        break;
      }
      if (S.pendingText) flushPending();
      if (S.currentAgentEl && S.currentAgentText) renderMarkdown(S.currentAgentEl, S.currentAgentText);
      S.currentAgentEl = null; S.currentAgentText = '';
      document.getElementById('waiting')?.remove();
      const isDone = msg.toolStatus === 'done' || msg.toolStatus === 'completed';
      const isError = msg.toolStatus === 'error';
      const statusIcon = isDone ? '✓' : isError ? '✗' : '⋯';
      const statusClass = isDone ? ' done' : isError ? ' error' : '';
      const toolEl = appendDiv(messagesEl, 'msg tool');
      if (msg.toolCallId) toolEl.dataset.toolId = msg.toolCallId;
      const { label, info } = formatToolDisplay(msg.toolName ?? '', msg.toolKind, msg.toolLocations, msg.toolDetail);
      const infoHtml = info ? `<span class="tool-detail">${DOMPurify.sanitize(info)}</span>` : '';
      toolEl.innerHTML = `<span class="tool-status${statusClass}">${statusIcon}</span><span class="tool-name">${label}</span>${infoHtml}`;
      autoScroll();
      break;
    }

    case 'busy': {
      const newQueued = msg.queued ?? 0;
      if (msg.active && newQueued < S.prevQueueCount) {
        if (S.pendingQueuedTexts.length > 0) appendMessage(messagesEl, 'user', S.pendingQueuedTexts.shift()!);
        S.currentAgentEl = null; S.currentAgentText = ''; S.thinkingStatusEl = null; S.pendingText = '';
        showWaiting(messagesEl);
      }
      S.prevQueueCount = newQueued;
      setBusy(msg.active ?? false, newQueued);
      break;
    }

    case 'done':
      if (S.pendingText) flushPending();
      if (S.markdownDebounceTimer) { clearTimeout(S.markdownDebounceTimer); S.markdownDebounceTimer = null; }
      document.getElementById('waiting')?.remove();
      document.getElementById('turn-thinking')?.remove();
      if (S.currentAgentEl && S.currentAgentText) {
        // If this turn was a slash command, restyle the bubble as a centered
        // "system" message instead of a normal agent reply. The content is
        // canned adapter output, not an LLM response — the visual treatment
        // should reflect that.
        if (S.pendingSlashResponse) {
          S.currentAgentEl.classList.remove('agent');
          S.currentAgentEl.classList.add('system');
        } else {
          detectTodoUpdate(S.currentAgentText, todoOverlay);
        }
        renderMarkdown(S.currentAgentEl, S.currentAgentText);
        autoScroll();
      }
      // YOLO state feedback — parse the adapter's /yolo response ("⚡ YOLO mode: ON — ..."
      // or "⚠ YOLO mode: OFF — ...") and toggle the red composer glow. Ground-truth
      // driven: the glow reflects the real HERMES_YOLO_MODE env var inside the
      // adapter subprocess, not an optimistic client guess.
      {
        const m = /YOLO mode:\s*(ON|OFF)/i.exec(S.currentAgentText);
        if (m) composer.classList.toggle('yolo', m[1].toUpperCase() === 'ON');
      }
      S.currentAgentEl = null; S.currentAgentText = ''; S.thinkingStatusEl = null;
      S.pendingSlashResponse = false;
      inputEl.focus();
      break;

    case 'error':
      if (S.pendingText) flushPending();
      if (S.markdownDebounceTimer) { clearTimeout(S.markdownDebounceTimer); S.markdownDebounceTimer = null; }
      document.getElementById('waiting')?.remove();
      document.getElementById('turn-thinking')?.remove();
      appendMessage(messagesEl, 'error', `Error: ${msg.text}`);
      S.currentAgentEl = null; S.currentAgentText = ''; S.thinkingStatusEl = null;
      break;

    case 'status':
      if (msg.status === 'connecting')       appendMessage(messagesEl, 'tool', 'Connecting to Hermes…');
      else if (msg.status === 'connected')   appendMessage(messagesEl, 'tool', 'Connected');
      else if (msg.status === 'disconnected') {
        appendMessage(messagesEl, 'error', 'Hermes disconnected');
        setBusy(false);
      }
      break;

    case 'clear':
      messagesEl.innerHTML = '';
      S.pendingQueuedTexts = []; S.prevQueueCount = 0; S.knownContextSize = 0; S.flushScheduled = false;
      ctxBarWrap.style.display = 'none';
      S.currentAgentEl = null; S.currentAgentText = ''; S.thinkingStatusEl = null; S.pendingText = '';
      setBusy(false);
      statusContextEl.textContent = ''; statusContextEl.className = '';
      break;

    case 'statusBar': {
      updateStatusBar(S, statusEls, msg.model, msg.sessionTitle, msg.contextUsed, msg.contextSize, msg.version, msg.cachedTokens);
      if (msg.skillGroups && msg.skillGroups.length > 0) S.skillGroupsData = msg.skillGroups;
      if (msg.selectedSkills !== undefined) {
        S.selectedSkillNames = new Set(msg.selectedSkills);
        skillsBtn.classList.toggle('has-skills', S.selectedSkillNames.size > 0);
        skillsBtn.textContent = S.selectedSkillNames.size > 0 ? `✦${S.selectedSkillNames.size}` : '✦';
      }
      if (msg.todoState && typeof msg.todoState === 'object') {
        const state = msg.todoState as { todos?: TodoItem[] };
        if (state.todos) renderTodoOverlay(todoOverlay, state.todos);
      }
      if (msg.contextAnnotation) {
        const userMsgs = messagesEl.querySelectorAll('.msg.user');
        const lastUser = userMsgs[userMsgs.length - 1];
        if (lastUser) {
          const anno = document.createElement('div');
          anno.className = 'context-annotation';
          anno.innerHTML = DOMPurify.sanitize(msg.contextAnnotation, {
            ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'],
          });
          lastUser.appendChild(anno);
        }
      }
      if (msg.attachedFiles !== undefined) {
        if (msg.attachedFiles && msg.attachedFiles.length > 0) {
          attachChip.innerHTML = msg.attachedFiles.map((f: {name: string}) =>
            `⊕ <span class="chip-name">${DOMPurify.sanitize(f.name)}</span>`
          ).join(' ') + ' <span class="chip-x">✕</span>';
          attachChip.style.display = 'flex';
        } else {
          attachChip.style.display = 'none'; attachChip.innerHTML = '';
        }
      }
      break;
    }

    case 'sessionList':
      if (msg.sessions && msg.activeSessionId !== undefined) {
        buildSessionPicker(sessionPicker, msg.sessions, msg.activeSessionId, statusSessionEl, S);
      }
      break;

    case 'loadHistory':
      loadHistory(messagesEl, msg.history ?? [], msg.switched ?? false);
      break;
  }
});
