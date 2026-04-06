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
  cmdArgPopover?: HTMLElement;
}): void {
  els.modelMenu.style.display = 'none';
  els.sessionPicker.style.display = 'none';
  els.skillsMenu.style.display = 'none';
  els.overflowMenu.style.display = 'none';
  if (els.cmdArgPopover) els.cmdArgPopover.style.display = 'none';
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

// ── Token display formatting ─────────────────────────
//
// TODO(joao): choose the display hierarchy. See the block in updateStatusBar()
// for options A/B/C/D and rationale. This function returns the HTML for the
// context counter text (the "X / Y" label next to the progress bar).
//
// Signature constraints:
// - MUST return a string of HTML (it's assigned to .innerHTML)
// - Use `fmtTok(n)` to format numbers (210180 → "210.2k")
// - Use `<span style="color:var(--gold);font-weight:600">...</span>` for the headline number
// - Use `<span style="opacity:0.5">...</span>` for secondary/dimmed text
// - `total`, `cached`, `fresh`, `size` are all plain numbers
function renderTokenDisplay(
  total: number,
  cached: number,
  fresh: number,
  size: number,
): string {
  void fresh; void cached; // unused — we only show total vs window size
  return `<span style="color:var(--gold);font-weight:600">${fmtTok(total)}</span> / ${fmtTok(size)}`;
}

// ── Status bar updates ───────────────────────────────

export function updateStatusBar(
  state: WebviewState,
  els: {
    statusVersionEl: HTMLElement; modelBtnHeader: HTMLElement;
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
    els.modelBtnHeader.textContent = `${displayLabel} ▾`;
    // Model changed — reset cached context size so the old model's window
    // doesn't persist until the first response from the new model arrives.
    state.knownContextSize = 0;
    els.statusContextEl.textContent = '';
    els.ctxBarWrap.style.display = 'none';
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

      // TOKEN DISPLAY — TODO(joao): pick the right hierarchy. See below.
      //
      // Context: Hermes sends inputTokens = TOTAL (fresh + cache_read + cache_write)
      // and cachedReadTokens = cache_read portion. On continuation turns with a hot
      // cache, the ENTIRE prompt can be served from cache, so fresh = 0 legitimately.
      //
      // The current "0 (+210.2k) / 1M" display is technically correct but confusing:
      // users read it as "counter broke". The question is which number deserves the
      // headline slot.
      //
      // Option A — Total headline, cached aside:  "210.2k (cached) / 1M"
      //   Matches context-budget mental model. "How full is my window?" = headline.
      //   Cost signal (cached) moved to secondary position.
      //
      // Option B — Fresh headline, total aside:   "0 · 210.2k total / 1M"
      //   Current approach. Emphasises billable tokens. Breaks when fresh = 0.
      //
      // Option C — Smart switch:  show fresh headline when > threshold (say 1k),
      //   otherwise flip to total headline with "all cached" annotation.
      //   E.g. "✓ 210.2k cached / 1M" when fresh is 0.
      //
      // Option D — Your call: hybrid or something else entirely.
      //
      // Implement below. `contextUsed` is total-including-cache, `cachedTokens` is
      // the cache_read portion (may be 0 or undefined), `freshTokens` is the diff,
      // `size` is the context window, `fmtTok()` formats numbers like "210.2k".
      els.statusContextEl.innerHTML = renderTokenDisplay(
        contextUsed, cachedTokens ?? 0, freshTokens, size,
      );
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
