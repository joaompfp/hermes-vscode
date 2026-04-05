/**
 * HTML/CSS template builder for the Hermes chat webview.
 *
 * Extracted from chatPanel.ts to isolate the ~600-line template
 * from the controller logic. All user-controlled content is
 * HTML-escaped via escapeHtml() before injection.
 */

import * as vscode from 'vscode';
import type { ModelMenuGroup } from './modelCatalog';

export interface TemplateConfig {
  extensionUri: vscode.Uri;
  webview: vscode.Webview;
  initialModel: string;
  modelGroups: ModelMenuGroup[];
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function initialModelLabel(config: TemplateConfig): string {
  for (const g of config.modelGroups) {
    for (const m of g.items) {
      if (m.id === config.initialModel || m.command === config.initialModel) return m.label;
    }
  }
  return config.initialModel;
}

function buildModelMenuItems(config: TemplateConfig): string {
  const { modelGroups, initialModel } = config;
  const allItems = modelGroups.flatMap(g => g.items);
  const currentInList = allItems.find(m => m.id === initialModel || m.command === initialModel);
  const extra = currentInList ? [] : [{ id: initialModel, label: initialModel, command: initialModel }];

  return modelGroups.map(group => {
    const items = group.items.map(m => {
      const active = (m.id === initialModel || m.command === initialModel) ? ' active' : '';
      const suffix = m.command === m.id
        ? ''
        : `<span style="opacity:0.45;font-size:0.82em"> ${escapeHtml(m.command)}</span>`;
      return `<div class="model-option${active}" data-command="${escapeHtml(m.command)}">${escapeHtml(m.label)}${suffix}</div>`;
    }).join('');
    return `<div class="model-group-label">${escapeHtml(group.group)}</div>${items}`;
  }).join('<div class="model-sep"></div>') +
  extra.map(m => `<div class="model-option active" data-command="${escapeHtml(m.command)}">${escapeHtml(m.label)}</div>`).join('');
}

export function buildChatHtml(config: TemplateConfig): string {
  const { webview, extensionUri } = config;

  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'),
  );
  const logoUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'resources', 'hermes-logo.png'),
  );

  const nonce = Array.from(
    { length: 32 },
    () => Math.random().toString(36)[2],
  ).join('');

  const modelLabel = initialModelLabel(config);
  const modelMenuHtml = buildModelMenuItems(config);

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}';
             style-src 'unsafe-inline';
             img-src ${webview.cspSource} data:;">
  <title>Hermes</title>
  <style>
${CSS_TEMPLATE}
  </style>
</head>
<body>
  <div id="header">
    <div id="header-brand">
      <span class="brand-icon">☤</span>
      <span class="brand-text">Hermes</span>
      <span class="brand-version" id="status-version"></span>
      <span class="brand-sep">·</span>
      <button id="model-btn-header" title="Switch model">${escapeHtml(modelLabel)} ▾</button>
    </div>
    <div id="header-session">
      <button id="status-session" title="Sessions">new session</button>
      <div id="status-right">
        <div id="ctx-bar-wrap" style="display:none"><div id="ctx-bar"></div><div id="ctx-bar-fresh"></div></div>
        <span id="status-context"></span>
      </div>
    </div>
    <div id="session-picker" class="status-dropdown" style="display:none"></div>
    <div id="model-menu" style="display:none">
      ${modelMenuHtml}
    </div>
  </div>
  <div id="todo-overlay"></div>
  <div id="messages">
    <div id="empty-state">
      <div class="empty-logo">☤</div>
      <div class="empty-title">What can I help you with?</div>
      <div class="prompt-chips">
        <div class="prompt-chip" data-prompt="Review this file">Review this file</div>
        <div class="prompt-chip" data-prompt="Explain the selected code">Explain the selected code</div>
        <div class="prompt-chip" data-prompt="Find bugs in this project">Find bugs in this project</div>
        <div class="prompt-chip" data-prompt="Write tests for this module">Write tests for this module</div>
      </div>
    </div>
  </div>
  <div id="input-drag"></div>
  <div id="context-row">
    <div id="attach-chip"></div>
  </div>
  <div id="input-row">
    <textarea id="input" rows="2" placeholder="Message Hermes…"></textarea>
    <div id="input-btns">
      <div id="action-area">
        <button id="send-btn">Send</button>
        <div id="busy-btns">
          <button id="stop-btn">■</button>
          <button id="queue-btn">▶</button>
        </div>
      </div>
      <div id="logo-mark"><img src="${logoUri}" alt="Hermes"/></div>
    </div>
  </div>
  <div id="queue-status"></div>
  <div id="bottom-bar">
    <button class="cmd-btn" id="attach-btn" title="Attach file"><span class="btn-icon">⊕</span></button>
    <button class="cmd-btn" id="skills-btn" title="Skills"><span class="btn-icon">✦</span></button>
    <div style="flex:1"></div>
    <button class="cmd-btn" id="overflow-btn" title="More actions"><span class="btn-icon">···</span></button>
    <div id="overflow-menu" style="display:none">
      <div class="menu-item" data-cmd="/context">≡ Context info</div>
      <div class="menu-item" data-cmd="/compact">⤓ Compress context</div>
      <div class="menu-item" data-cmd="/reset">↺ Reset conversation</div>
      <div class="menu-item" data-cmd="/help">? Help</div>
    </div>
    <div id="model-switcher" style="display:none">
      <button id="model-btn" title="Switch model">${escapeHtml(config.initialModel)} ▾</button>
    </div>
    <div id="skills-menu" style="display:none"></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

// ── CSS ──────────────────────────────────────────────
// Extracted as a template literal constant for readability.
// All colors use --vscode-* variables where possible;
// --gold is the only custom accent.

const CSS_TEMPLATE = /* css */ `
    * { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --ui-font: 'Segoe UI', system-ui, -apple-system, sans-serif;
      --gold: #F5C542;
      --gold-dim: rgba(245, 197, 66, 0.65);
      --gold-subtle: rgba(245, 197, 66, 0.12);
      --gold-border: rgba(245, 197, 66, 0.25);
      --toolbar-height: 28px;
      --space-xs: 2px;
      --space-sm: 4px;
      --space-md: 8px;
      --space-lg: 12px;
      --space-xl: 16px;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* ── Header (two rows) ────────────────────────────── */
    #header {
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
      background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.08));
      font-family: var(--ui-font);
      flex-shrink: 0;
      position: relative;
    }

    /* Row 1: brand + model */
    #header-brand {
      display: flex; align-items: center; gap: 6px;
      padding: 5px 8px 2px;
      font-size: 0.85em;
    }
    #header-brand .brand-icon { font-size: 1.4em; color: var(--gold); }
    #header-brand .brand-text { font-weight: 700; color: var(--gold); letter-spacing: 0.04em; }
    #header-brand .brand-sep { opacity: 0.3; }
    #header-brand .brand-version { opacity: 0.4; font-size: 0.85em; }
    #model-btn-header {
      background: none; border: none; cursor: pointer;
      color: var(--vscode-descriptionForeground);
      font: inherit; font-size: 1em; padding: 0;
    }
    #model-btn-header:hover { color: var(--gold); }

    /* Row 2: session + tokens */
    #header-session {
      display: flex; align-items: center; justify-content: space-between;
      padding: 2px 8px 5px; gap: 8px;
    }
    #status-session {
      flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      cursor: pointer; background: none; border: none;
      color: var(--vscode-foreground); font: inherit;
      font-family: var(--ui-font); font-size: 0.82em;
      padding: 0; text-align: left; min-width: 0;
    }
    #status-session:hover { color: var(--gold); }
    *:focus-visible {
      outline: 1px solid var(--vscode-focusBorder, var(--gold));
      outline-offset: 1px;
    }

    #status-right {
      display: flex; align-items: center; gap: 5px;
      flex-shrink: 0; font-size: 0.82em;
      font-family: var(--ui-font);
      color: var(--vscode-descriptionForeground);
    }
    #status-context {
      white-space: nowrap; font-variant-numeric: tabular-nums;
    }
    #status-context.warn { color: var(--gold); opacity: 1; }
    #status-context.crit { color: #C94040; opacity: 1; }

    /* Token progress bar — dual layer: total (faded) + fresh (solid) */
    #ctx-bar-wrap {
      width: 52px; height: 5px;
      background: rgba(255,255,255,0.1);
      border-radius: 2px; overflow: hidden; flex-shrink: 0;
      position: relative;
    }
    /* Total usage (cached + fresh) — faded background fill */
    #ctx-bar {
      position: absolute; top: 0; left: 0;
      height: 100%; width: 0%;
      border-radius: 2px;
      background: var(--gold);
      opacity: 0.3;
      transition: width 0.4s ease, background 0.3s;
    }
    /* Fresh (non-cached) usage — solid foreground fill */
    #ctx-bar-fresh {
      position: absolute; top: 0; left: 0;
      height: 100%; width: 0%;
      border-radius: 2px;
      background: var(--gold);
      transition: width 0.4s ease, background 0.3s;
    }
    #ctx-bar.warn, #ctx-bar-fresh.warn { background: var(--gold); }
    #ctx-bar.crit, #ctx-bar-fresh.crit { background: #C94040; }

    /* ── Dropdowns ──────────────────────────────────── */
    .status-dropdown {
      position: absolute; top: calc(100% + 1px); left: 0; right: 0;
      background: var(--vscode-dropdown-background, var(--vscode-sideBar-background));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-sideBarSectionHeader-border));
      border-radius: 0 0 4px 4px; z-index: 200; overflow: hidden;
    }
    .status-dropdown .menu-item {
      padding: 5px 10px; font-size: 0.82em; font-family: var(--ui-font);
      color: var(--vscode-foreground); cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      display: flex; align-items: center; gap: 6px;
    }
    .status-dropdown .menu-item:hover { background: var(--gold-subtle); }
    .status-dropdown .menu-item.active { color: var(--gold); font-weight: 600; }
    .status-dropdown .menu-item .item-meta {
      opacity: 0.4; font-size: 0.85em; margin-left: auto; flex-shrink: 0;
    }
    .status-dropdown .menu-footer {
      padding: 5px 10px; font-size: 0.82em; font-family: var(--ui-font);
      color: var(--vscode-descriptionForeground); cursor: pointer;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
    }
    .status-dropdown .menu-footer:hover { background: var(--gold-subtle); color: var(--gold); }
    .session-action {
      opacity: 0; cursor: pointer; font-size: 0.9em; flex-shrink: 0;
      padding: 0 2px; transition: opacity 0.15s;
    }
    .menu-item:hover .session-action { opacity: 0.5; }
    .session-action:hover { opacity: 1 !important; }
    .delete-session:hover { color: var(--vscode-errorForeground, #C94040); }

    /* ── Messages ───────────────────────────────────── */
    #messages {
      flex: 1;
      min-height: 80px;
      overflow-y: auto;
      padding: var(--space-lg) var(--space-md);
      display: flex;
      flex-direction: column;
      gap: var(--space-lg);
    }

    .msg {
      padding: 5px 8px;
      border-radius: 4px;
      line-height: 1.35;
      word-break: break-word;
    }
    .msg.user {
      align-self: flex-end;
      max-width: 88%;
      white-space: pre-wrap;
      background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.15));
      border-left: 3px solid var(--gold);
      color: var(--vscode-foreground);
      border-radius: 4px;
      padding: 6px 10px;
    }
    .msg.user .context-annotation {
      font-family: var(--ui-font);
      font-size: 0.72em;
      opacity: 0.65;
      margin-top: 4px;
      padding-top: 4px;
      border-top: 1px solid rgba(255,255,255,0.15);
    }
    .msg.user .context-annotation .ctx-line {
      display: block;
      padding: 1px 0;
    }
    .msg.user .context-annotation .ctx-icon {
      opacity: 0.7;
      margin-right: 3px;
    }
    .msg.user::before {
      content: 'You';
      display: block;
      font-family: var(--ui-font);
      font-size: 0.7em;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      opacity: 0.65;
      margin-bottom: 3px;
    }
    .msg.agent {
      background: transparent;
      white-space: pre-wrap;
      padding-left: 2px;
    }
    .msg.tool {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.8em;
      color: var(--vscode-foreground);
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
      border-radius: 4px;
      padding: 5px 10px;
      display: flex;
      align-items: baseline;
      gap: 6px;
      min-height: 22px;
      clear: both;
    }
    .msg.tool + .msg.tool { margin-top: calc(-1 * var(--space-md)); }
    .msg.agent + .msg.tool { margin-top: var(--space-xs); }
    .msg.tool + .msg.agent { margin-top: var(--space-md); }
    .thinking-status + .msg.tool { margin-top: var(--space-xs); }

    .msg.tool .tool-status {
      color: var(--gold); flex-shrink: 0; width: 1.2em; text-align: center;
      font-size: 1.1em; font-weight: 700;
    }
    .msg.tool .tool-status.done { color: #4EC9B0; }
    .msg.tool .tool-status.error { color: #C94040; }
    .msg.tool .tool-name {
      font-weight: 700; white-space: nowrap;
    }
    .msg.tool .tool-detail {
      opacity: 0.6; word-break: break-all; overflow-wrap: anywhere;
      min-width: 0;
    }
    /* Prevent horizontal overflow */
    #messages { overflow-x: hidden; }

    /* ── Empty state ──────────────────────────────── */
    #empty-state {
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 12px; padding: 24px 16px;
      flex: 1; text-align: center;
    }
    #empty-state .empty-logo { font-size: 2.5em; color: var(--gold); opacity: 0.5; }
    #empty-state .empty-title {
      font-family: var(--ui-font); font-size: 0.95em;
      color: var(--vscode-descriptionForeground);
    }
    #empty-state .prompt-chips {
      display: flex; flex-direction: column; gap: 6px; width: 100%; max-width: 260px;
    }
    .prompt-chip {
      background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.1));
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.2));
      border-radius: 6px; padding: 8px 12px;
      font-family: var(--ui-font); font-size: 0.85em;
      color: var(--vscode-foreground); cursor: pointer;
      text-align: left; transition: border-color 0.15s;
    }
    .prompt-chip:hover { border-color: var(--gold); color: var(--gold); }
    .msg.agent pre { white-space: pre-wrap; word-break: break-word; overflow-x: auto; }
    .msg.error {
      font-family: var(--ui-font);
      color: var(--vscode-errorForeground);
      font-size: 0.85em;
    }

    /* ── Todo overlay ──────────────────────────────── */
    #todo-overlay {
      font-family: var(--ui-font); font-size: 0.82em;
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
      background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.05));
      flex-shrink: 0; display: none;
    }
    #todo-overlay .todo-header {
      font-weight: 700; font-size: 0.78em;
      text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }
    #todo-overlay .todo-item {
      display: flex; align-items: flex-start; gap: 6px;
      padding: 2px 0;
    }
    #todo-overlay .todo-icon {
      flex-shrink: 0; width: 1.2em; text-align: center;
    }
    #todo-overlay .todo-icon.completed { color: #4EC9B0; }
    #todo-overlay .todo-icon.in_progress { color: var(--gold); }
    #todo-overlay .todo-icon.pending { opacity: 0.4; }
    #todo-overlay .todo-text { flex: 1; }
    #todo-overlay .todo-text.completed {
      text-decoration: line-through; opacity: 0.5;
    }
    #todo-overlay .todo-text.in_progress { color: var(--gold); font-weight: 500; }
    #todo-overlay .todo-summary {
      font-size: 0.8em; opacity: 0.5; margin-top: 3px;
    }

    /* History divider */
    .history-divider {
      text-align: center;
      font-family: var(--ui-font);
      font-size: 0.72em;
      opacity: 0.35;
      padding: 4px 0;
      border-top: 1px solid rgba(128,128,128,0.2);
      margin-top: 4px;
    }

    .status-line {
      font-family: var(--ui-font);
      font-size: 0.78em;
      color: var(--vscode-descriptionForeground);
      padding: 1px 4px;
    }
    .thinking-status { font-style: italic; color: var(--gold); opacity: 0.75; }

    /* ── Markdown typography ────────────────────────── */
    .msg.agent p          { margin: 0.5em 0; white-space: normal; }
    .msg.agent p:first-child { margin-top: 0; }
    .msg.agent p:last-child { margin-bottom: 0; }
    .msg.agent h1, .msg.agent h2, .msg.agent h3,
    .msg.agent h4, .msg.agent h5, .msg.agent h6 {
      margin: 0.6em 0 0.2em; line-height: 1.2; font-weight: 600;
    }
    .msg.agent h1 { font-size: 1.2em; }
    .msg.agent h2 { font-size: 1.1em; }
    .msg.agent h3 { font-size: 1em; }
    .msg.agent ul, .msg.agent ol { padding-left: 1.4em; margin-bottom: 0.4em; }
    .msg.agent li { margin-bottom: 0.1em; white-space: normal; }
    .msg.agent blockquote {
      border-left: 3px solid var(--vscode-textBlockQuote-border, #555);
      padding-left: 0.75em; margin: 0.3em 0; opacity: 0.8; white-space: normal;
    }
    .msg.agent code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.87em;
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
      padding: 0.1em 0.3em; border-radius: 3px;
    }
    .msg.agent pre {
      background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
      border-radius: 4px; padding: 0.6em 0.8em; margin: 0.4em 0;
      overflow-x: auto; white-space: pre;
    }
    .msg.agent pre code { background: none; padding: 0; font-size: 0.85em; border-radius: 0; }
    .msg.agent pre { position: relative; }
    .msg.agent pre .copy-btn {
      position: absolute; top: 4px; right: 4px;
      background: rgba(128,128,128,0.25); border: none; border-radius: 3px;
      color: var(--vscode-foreground); font-family: var(--ui-font);
      font-size: 0.7em; padding: 2px 6px; cursor: pointer;
      opacity: 0; transition: opacity 0.15s;
    }
    .msg.agent pre:hover .copy-btn { opacity: 0.7; }
    .msg.agent pre .copy-btn:hover { opacity: 1; background: rgba(245,197,66,0.3); }
    .msg.agent pre .copy-btn.copied { color: #4EC9B0; }
    .msg.agent img {
      max-width: 100%; border-radius: 6px; margin: 0.4em 0;
      cursor: pointer; transition: opacity 0.2s;
    }
    .msg.agent img:hover { opacity: 0.85; }
    .msg.agent a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .msg.agent a:hover { text-decoration: underline; }
    .msg.agent hr {
      border: none;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
      margin: 0.5em 0;
    }
    .msg.agent table { border-collapse: collapse; margin: 0.4em 0; font-size: 0.9em; white-space: normal; }
    .msg.agent th, .msg.agent td {
      border: 1px solid var(--vscode-sideBarSectionHeader-border);
      padding: 0.2em 0.45em;
    }
    .msg.agent th { font-weight: 600; background: rgba(128,128,128,0.1); }

    /* ── Drag handle ────────────────────────────────── */
    #input-drag {
      height: 5px; cursor: ns-resize;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    #input-drag::after {
      content: ''; width: 28px; height: 2px; border-radius: 2px;
      background: var(--vscode-sideBarSectionHeader-border); opacity: 0.6;
    }
    #input-drag:hover { background: rgba(128,128,128,0.08); }
    #input-drag:hover::after { opacity: 1; }

    /* ── Context row (attach btn + file/skill chips) ── */
    #context-row {
      display: flex; align-items: center; gap: 4px;
      padding: 2px 8px 0; flex-shrink: 0;
      min-height: 0;
    }
    #context-row:empty, #context-row:not(:has(.chip-name)) { }
    #attach-chip {
      font-family: var(--ui-font); font-size: 0.72em;
      color: var(--gold);
      display: flex; align-items: center; gap: 4px;
      flex-wrap: wrap; flex: 1; min-width: 0;
    }
    #attach-chip .chip-name {
      background: rgba(245,197,66,0.12); border-radius: 3px;
      padding: 1px 6px; max-width: 160px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #attach-chip .chip-x {
      cursor: pointer; opacity: 0.6; font-size: 1.1em;
    }
    #attach-chip .chip-x:hover { opacity: 1; }

    /* ── Input area (full width) ───────────────────── */
    #input-row { display: flex; align-items: stretch; gap: 5px; padding: 4px 8px 6px; }
    #input {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
      border-radius: 4px; padding: 6px 8px;
      font-family: inherit; font-size: inherit;
      resize: none; min-height: 0; height: 100%; overflow-y: auto;
    }
    #input:focus { outline: none; border-color: var(--gold); }
    @keyframes input-glow {
      0%, 100% { border-color: rgba(245, 197, 66, 0.35); box-shadow: 0 0 3px rgba(245,197,66,0.1); }
      50%       { border-color: rgba(245, 197, 66, 0.65); box-shadow: 0 0 8px rgba(245,197,66,0.25); }
    }
    #input.busy-glow { animation: input-glow 1.6s ease-in-out infinite; }

    #input-btns {
      display: flex; flex-direction: column; align-items: stretch;
      gap: 5px; flex-shrink: 0; width: 56px; align-self: stretch;
    }
    #action-area { width: 100%; }
    #input-btns button {
      font-family: var(--ui-font); font-size: 0.78em; font-weight: 600;
      letter-spacing: 0.02em; border: none; border-radius: 4px;
      cursor: pointer; padding: 5px 4px; width: 100%;
    }
    #send-btn { background: var(--gold); color: #1e1e1e; }
    #send-btn:hover { background: #E8C940; }
    #busy-btns { display: none; gap: 2px; width: 100%; }
    #stop-btn { flex: 1; background: var(--vscode-errorForeground, #C94040); color: #FFF; font-size: 1em; padding: 4px 2px; }
    #stop-btn:hover { opacity: 0.85; }
    #queue-btn { flex: 1; background: var(--gold); color: #1e1e1e; font-size: 1em; padding: 4px 2px; }
    #queue-btn:hover { opacity: 0.85; }

    /* Logo */
    #logo-mark {
      display: flex; align-items: center; justify-content: center;
      height: 100%; min-height: 44px; opacity: 0.80;
    }
    #logo-mark img { width: 40px; height: 40px; object-fit: contain; transition: filter 0.4s ease; }
    @keyframes hermes-glow {
      0%, 100% { filter: drop-shadow(0 0 3px rgba(245, 197, 66, 0.25)); }
      50%       { filter: drop-shadow(0 0 10px rgba(245, 197, 66, 0.85)); }
    }
    #logo-mark.busy img { animation: hermes-glow 1.6s ease-in-out infinite; }

    #queue-status {
      font-family: var(--ui-font); font-size: 0.72em;
      color: var(--gold); opacity: 0.8; padding: 0 8px 2px; display: none;
    }

    /* ── Bottom toolbar ─────────────────────────────── */
    #bottom-bar {
      display: flex; align-items: center; gap: 4px;
      padding: 4px 8px 5px;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
      flex-shrink: 0; font-family: var(--ui-font); position: relative;
    }
    #model-switcher { position: relative; flex: 1; min-width: 0; }
    #model-btn {
      width: 100%; background: transparent;
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
      border-radius: 4px;
      color: var(--vscode-descriptionForeground);
      font-family: var(--ui-font);
      font-size: 0.85em; font-weight: 500; padding: 0 8px;
      cursor: pointer; text-align: left; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; height: var(--toolbar-height);
    }
    #model-btn:hover { color: var(--gold); border-color: var(--gold-border); }
    #model-menu {
      position: absolute; top: 100%; left: 0; right: 0;
      background: var(--vscode-dropdown-background, var(--vscode-sideBar-background));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-sideBarSectionHeader-border));
      border-top: none; border-radius: 0 0 4px 4px;
      min-width: 180px; z-index: 200; overflow: hidden;
      max-height: 350px; overflow-y: auto;
    }
    .model-option {
      padding: 5px 10px; font-size: 0.85em; font-family: var(--ui-font);
      color: var(--vscode-foreground); cursor: pointer; white-space: nowrap;
    }
    .model-option:hover { background: var(--gold-subtle); color: var(--gold); }
    .model-option.active { color: var(--gold); font-weight: 600; }
    .model-option.active::before { content: '✓ '; }
    .model-group-label {
      padding: 4px 10px 2px; font-size: 0.7em; font-family: var(--ui-font);
      color: var(--vscode-descriptionForeground); opacity: 0.7;
      text-transform: uppercase; letter-spacing: 0.06em;
    }
    .model-sep { border-top: 1px solid var(--vscode-sideBarSectionHeader-border); margin: 2px 0; }

    .cmd-btn {
      background: transparent;
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.3));
      border-radius: 4px;
      color: var(--vscode-descriptionForeground);
      font-family: var(--ui-font); font-size: 0.9em; font-weight: 500; padding: 0;
      cursor: pointer; white-space: nowrap; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center; gap: 3px;
      width: var(--toolbar-height); height: var(--toolbar-height);
    }
    .cmd-btn:hover { color: var(--gold); border-color: var(--gold-border); }
    .cmd-btn:active { background: var(--gold-subtle); }
    .cmd-btn .btn-icon { font-size: 1.3em; }
    #skills-btn.has-skills { color: var(--gold); border-color: var(--gold-border); }

    /* Overflow menu */
    #overflow-menu {
      position: absolute; bottom: calc(100% + 4px); right: 0;
      background: var(--vscode-dropdown-background, var(--vscode-sideBar-background));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-sideBarSectionHeader-border));
      border-radius: 4px; min-width: 180px; z-index: 100; overflow: hidden;
    }
    #overflow-menu .menu-item {
      padding: 6px 10px; font-size: 0.85em; font-family: var(--ui-font);
      color: var(--vscode-foreground); cursor: pointer;
    }
    #overflow-menu .menu-item:hover { background: var(--gold-subtle); }

    /* Skills picker */
    #skills-menu {
      position: absolute; bottom: calc(100% + 4px); right: 0;
      background: var(--vscode-dropdown-background, var(--vscode-sideBar-background));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-sideBarSectionHeader-border));
      border-radius: 4px; min-width: 240px; max-width: 320px;
      max-height: 350px; overflow-y: auto; z-index: 100;
    }
    .skill-group-label {
      padding: 4px 10px 2px; font-size: 0.68em; font-family: var(--ui-font);
      color: var(--vscode-descriptionForeground); opacity: 0.7;
      text-transform: uppercase; letter-spacing: 0.06em;
      position: sticky; top: 0;
      background: var(--vscode-dropdown-background, var(--vscode-sideBar-background));
    }
    .skill-option {
      padding: 3px 10px; font-size: 0.78em; font-family: var(--ui-font);
      color: var(--vscode-foreground); cursor: pointer; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
      display: flex; align-items: center; gap: 6px;
    }
    .skill-option:hover { background: var(--gold-subtle); }
    .skill-option.selected { color: var(--gold); font-weight: 600; }
    .skill-option.selected::before { content: '✓ '; flex-shrink: 0; }
    .skill-option .skill-desc {
      opacity: 0.4; font-size: 0.85em; overflow: hidden; text-overflow: ellipsis;
    }
`;
