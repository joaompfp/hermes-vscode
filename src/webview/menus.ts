/**
 * Menu builders and dropdown handlers for the webview.
 */

import DOMPurify from 'dompurify';
import type { FromWebview } from '../types';
import type { WebviewState } from './state';
import { fmtAge, fmtTok } from './renderers';

type Vscode = { postMessage(msg: FromWebview): void };

// ── Dropdown management ──────────────────────────────

export function closeAllDropdowns(els: {
  modelMenu: HTMLElement; sessionPicker: HTMLElement;
  skillsMenu: HTMLElement; overflowMenu: HTMLElement;
}): void {
  els.modelMenu.style.display = 'none';
  els.sessionPicker.style.display = 'none';
  els.skillsMenu.style.display = 'none';
  els.overflowMenu.style.display = 'none';
}

// ── Session picker ───────────────────────────────────

export function buildSessionPicker(
  container: HTMLElement,
  sessions: { id: string; title: string; createdAt: number }[],
  activeId: string,
  statusSessionEl: HTMLElement,
  state: WebviewState,
): void {
  state.currentActiveSessionId = activeId;
  const active = sessions.find(s => s.id === activeId);
  if (active) statusSessionEl.textContent = active.title;

  container.innerHTML = sessions.map(s => {
    const isActive = s.id === activeId;
    return `<div class="menu-item${isActive ? ' active' : ''}" data-session-id="${s.id}">
      ${isActive ? '✓ ' : ''}<span style="overflow:hidden;text-overflow:ellipsis;flex:1">${DOMPurify.sanitize(s.title)}</span>
      <span class="item-meta">${fmtAge(s.createdAt)}</span>
      <span class="session-action rename-session" data-session-id="${s.id}" title="Rename">✎</span>
      <span class="session-action delete-session" data-session-id="${s.id}" title="Delete">✕</span>
    </div>`;
  }).join('') + `<div class="menu-footer">＋ New session</div>`;
}

export function setupSessionPickerHandlers(
  sessionPicker: HTMLElement,
  vscode: Vscode,
  state: WebviewState,
  closeFn: () => void,
): void {
  sessionPicker.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;

    const renameBtn = target.closest<HTMLElement>('.rename-session');
    if (renameBtn?.dataset.sessionId) {
      e.stopPropagation();
      closeFn();
      vscode.postMessage({ type: 'renameSession', sessionId: renameBtn.dataset.sessionId } as any);
      return;
    }

    const deleteBtn = target.closest<HTMLElement>('.delete-session');
    if (deleteBtn?.dataset.sessionId) {
      e.stopPropagation();
      vscode.postMessage({ type: 'deleteSession', sessionId: deleteBtn.dataset.sessionId } as any);
      return;
    }

    const opt = target.closest<HTMLElement>('.menu-item[data-session-id]');
    const newBtn = target.closest<HTMLElement>('.menu-footer');
    closeFn();
    if (opt?.dataset.sessionId && opt.dataset.sessionId !== state.currentActiveSessionId) {
      vscode.postMessage({ type: 'switchSession', sessionId: opt.dataset.sessionId });
    } else if (newBtn) {
      vscode.postMessage({ type: 'newSession' });
    }
  });
}

// ── Skills picker ────────────────────────────────────

export function buildSkillsMenu(container: HTMLElement, state: WebviewState): void {
  container.innerHTML = state.skillGroupsData.map(g => {
    const items = g.skills.map(s => {
      const sel = state.selectedSkillNames.has(s.name) ? ' selected' : '';
      const desc = s.description ? `<span class="skill-desc">${s.description}</span>` : '';
      return `<div class="skill-option${sel}" data-skill="${s.name}">${s.name} ${desc}</div>`;
    }).join('');
    return `<div class="skill-group-label">${g.category}</div>${items}`;
  }).join('');
}

export function setupSkillsHandlers(
  skillsMenu: HTMLElement,
  skillsBtn: HTMLElement,
  vscode: Vscode,
  state: WebviewState,
): void {
  skillsMenu.addEventListener('click', (e: MouseEvent) => {
    const opt = (e.target as HTMLElement).closest<HTMLElement>('.skill-option');
    if (!opt?.dataset.skill) return;
    e.stopPropagation();
    const name = opt.dataset.skill;
    if (state.selectedSkillNames.has(name)) {
      state.selectedSkillNames.delete(name);
    } else {
      state.selectedSkillNames.add(name);
    }
    skillsBtn.classList.toggle('has-skills', state.selectedSkillNames.size > 0);
    skillsBtn.textContent = state.selectedSkillNames.size > 0 ? `✦${state.selectedSkillNames.size}` : '✦';
    opt.classList.toggle('selected');
    vscode.postMessage({ type: 'toggleSkill', text: name } as any);
  });
}

// ── Status bar updates ───────────────────────────────

export function updateStatusBar(
  state: WebviewState,
  els: {
    statusVersionEl: HTMLElement; modelBtn: HTMLElement; modelBtnHeader: HTMLElement;
    modelMenu: HTMLElement; statusSessionEl: HTMLElement; statusContextEl: HTMLElement;
    ctxBarWrap: HTMLElement; ctxBar: HTMLElement; ctxBarFresh: HTMLElement;
  },
  model?: string, sessionTitle?: string,
  contextUsed?: number, contextSize?: number, version?: string,
  cachedTokens?: number,
): void {
  if (version !== undefined) els.statusVersionEl.textContent = version ? ` ${version}` : '';
  if (model) {
    state.currentModel = model;
    let displayLabel = model;
    els.modelMenu.querySelectorAll<HTMLElement>('.model-option').forEach(el => {
      const cmd = el.dataset.command ?? '';
      const isMatch = cmd === model || cmd.endsWith(':' + model);
      el.classList.toggle('active', isMatch);
      if (isMatch) {
        const clone = el.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('span').forEach(s => s.remove());
        displayLabel = clone.textContent?.trim() || model;
      }
    });
    els.modelBtn.textContent = `${displayLabel} ▾`;
    els.modelBtnHeader.textContent = `${displayLabel} ▾`;
  }
  if (sessionTitle) els.statusSessionEl.textContent = sessionTitle;
  if (contextSize && contextSize > 0) state.knownContextSize = contextSize;
  if (contextUsed !== undefined) {
    const size = state.knownContextSize;
    if (size > 0) {
      const freshTokens = Math.max(0, contextUsed - (cachedTokens ?? 0));
      const totalPct = Math.min(1, contextUsed / size);
      const freshPct = Math.min(1, freshTokens / size);
      const cls = totalPct > 0.9 ? 'crit' : totalPct > 0.7 ? 'warn' : '';

      // Text: prominently show fresh, total in parens when there's cached content
      const cachedLabel = cachedTokens && cachedTokens > 0
        ? ` <span style="opacity:0.5">(+${fmtTok(cachedTokens)})</span>`
        : '';
      els.statusContextEl.innerHTML =
        `<span style="color:var(--gold);font-weight:600">${fmtTok(freshTokens)}</span>${cachedLabel} / ${fmtTok(size)}`;
      els.statusContextEl.className = cls;

      // Dual bar: faded background = total, solid foreground = fresh
      els.ctxBar.style.width = `${(totalPct * 100).toFixed(1)}%`;
      els.ctxBar.className = cls;
      els.ctxBarFresh.style.width = `${(freshPct * 100).toFixed(1)}%`;
      els.ctxBarFresh.className = cls;
      els.ctxBarWrap.style.display = 'block';
    } else {
      els.statusContextEl.textContent = `${fmtTok(contextUsed)} tok`;
      els.statusContextEl.className = '';
      els.ctxBarWrap.style.display = 'none';
    }
  }
}
