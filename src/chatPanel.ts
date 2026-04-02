/**
 * ChatPanel — the VS Code WebviewView provider.
 * Renders the chat UI and bridges messages between the webview and SessionManager.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from './sessionManager';
import { loadHermesModelGroups, ModelMenuGroup } from './modelCatalog';
import { loadHermesSkills, SkillGroup } from './skillCatalog';

export interface StoredMessage {
  role: 'user' | 'agent' | 'tool' | 'error';
  text: string;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  messages: StoredMessage[];
  acpSessionId?: string;  // persisted ACP session ID for Hermes context resume
}

// Message types shared between extension host and webview
export interface ToWebview {
  type: 'append' | 'thinking' | 'toolCall' | 'done' | 'error' | 'status' | 'clear' | 'busy' | 'statusBar' | 'sessionList' | 'loadHistory';
  text?: string;
  toolName?: string;
  toolStatus?: string;
  toolCallId?: string;
  toolDetail?: string;
  toolKind?: string;
  toolLocations?: string[];
  todoState?: unknown;
  status?: string;
  /** busy=true → agent running; false → idle. queued = messages waiting. */
  active?: boolean;
  queued?: number;
  // Status bar fields
  model?: string;
  sessionTitle?: string;
  contextUsed?: number;
  contextSize?: number;
  version?: string;
  // Session management
  sessions?: ChatSession[];
  activeSessionId?: string;
  history?: StoredMessage[];
  switched?: boolean;
  // File attachments (multiple)
  attachedFiles?: { name: string; path: string }[];
  // Skills
  selectedSkills?: string[];
  skillGroups?: SkillGroup[];
  // Context annotation for user message bubble
  contextAnnotation?: string;
}

export interface FromWebview {
  type: 'send' | 'switchModel' | 'cancel' | 'newSession' | 'switchSession' | 'attachFile' | 'pasteImage' | 'dropFiles' | 'clearAttachments' | 'toggleSkill' | 'renameSession' | 'deleteSession';
  text?: string;
  sessionId?: string;
  model?: string;
  data?: string;   // base64 image data for pasteImage
  ext?: string;     // file extension for pasteImage
  uris?: string[];  // file URIs for dropFiles
}

const SESSIONS_KEY = 'hermes.sessions';
const MAX_SESSIONS = 20;
const MAX_MESSAGES_PER_SESSION = 300;

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'hermes.chatView';

  private view?: vscode.WebviewView;
  private busy = false;
  private messageQueue: string[] = [];
  /** Accumulated agent text for current turn — stored on done. */
  private lastTurnText = '';
  /** Tool calls accumulated during current turn (stored on done). */
  private lastTurnTools: StoredMessage[] = [];

  // Session management
  private sessions: ChatSession[] = [];
  private activeSessionId = '';
  private readonly modelGroups: ModelMenuGroup[] = loadHermesModelGroups();
  private readonly skillGroups: SkillGroup[] = loadHermesSkills();

  /** Skills selected for the next prompt (cleared after send). */
  private selectedSkills: string[] = [];

  /** Currently attached files (cleared after sending one message). */
  private attachedFiles: { name: string; path: string }[] = [];

  /** Track tool call locations by ID for file-open on completion. */
  private toolCallLocations = new Map<string, { kind: string; paths: string[] }>();
  private readonly mediaRoot: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly session: SessionManager,
    private readonly initialModel: string = '—',
    private readonly hermesVersion: string = '',
    private readonly context: vscode.ExtensionContext,
    private readonly log: (line: string) => void = () => {},
  ) {
    this.mediaRoot = path.join(this.context.globalStorageUri.fsPath, 'media');
    fs.mkdirSync(this.mediaRoot, { recursive: true });

    // Load persisted sessions
    const saved = context.workspaceState.get<ChatSession[]>(SESSIONS_KEY);
    if (saved && saved.length > 0) {
      this.sessions = saved.map(s => ({ ...s, messages: s.messages ?? [] }));
      this.activeSessionId = this.sessions[this.sessions.length - 1].id;
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'resources'),
        vscode.Uri.file(this.mediaRoot),
      ],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    // Create first session if none exist
    if (this.sessions.length === 0) {
      this.activeSessionId = this.newSessionEntry('new session');
    }

    // Restore ACP session ID from persisted state (enables Hermes context resume)
    const active = this.activeSession();
    if (active?.acpSessionId) {
      this.session.setStoredSessionId(active.acpSessionId);
      this.log(`[session] will attempt resume of ACP session ${active.acpSessionId}`);
    }

    // Emit initial state
    setTimeout(() => {
      this.post({ type: 'statusBar', model: this.initialModel, version: this.hermesVersion, skillGroups: this.skillGroups });
      this.broadcastSessions();
      // Restore last session's history into the view
      if (active && active.messages.length > 0) {
        this.post({ type: 'loadHistory', history: active.messages, activeSessionId: this.activeSessionId });
      }
    }, 150);

    webviewView.webview.onDidReceiveMessage((msg: FromWebview) => {
      void this.handleFromWebview(msg);
    });

    // Route session updates to the webview
    this.session.onUpdate((event) => {
      if (event.text) {
        // Convert MEDIA:/path references to webview-safe img URIs
        const converted = this.convertMediaPaths(event.text, webviewView.webview);
        this.lastTurnText += event.text;
        this.post({ type: 'append', text: converted });
      }
      if (event.thinkingText) {
        this.post({ type: 'thinking', text: event.thinkingText });
      }
      if (event.toolTitle !== undefined) {
        if (event.toolTitle === '' && event.toolCallId) {
          // tool_call_update — status change for existing tool
          this.post({ type: 'toolCall', toolCallId: event.toolCallId, toolStatus: event.toolStatus });

          // Open edited/read files in VS Code editor on completion
          if (event.toolStatus === 'completed' && event.toolCallId) {
            const info = this.toolCallLocations.get(event.toolCallId);
            if (info && info.paths.length > 0 && (info.kind === 'edit' || info.kind === 'read')) {
              for (const filePath of info.paths) {
                this.openFileInEditor(filePath, info.kind === 'edit');
              }
            }
            this.toolCallLocations.delete(event.toolCallId);
          }
        } else if (event.toolTitle) {
          const icon = event.toolStatus === 'done' || event.toolStatus === 'completed' ? '✓' : event.toolStatus === 'error' ? '✗' : '⋯';
          this.lastTurnTools.push({ role: 'tool', text: `${icon} ${event.toolTitle}${event.toolDetail ? ': ' + event.toolDetail : ''}` });
          // Store locations for file-open on completion
          if (event.toolCallId && event.toolLocations?.length && event.toolKind) {
            this.toolCallLocations.set(event.toolCallId, {
              kind: event.toolKind,
              paths: event.toolLocations,
            });
          }
          this.post({
            type: 'toolCall',
            toolName: event.toolTitle,
            toolStatus: event.toolStatus,
            toolCallId: event.toolCallId,
            toolDetail: event.toolDetail,
            toolKind: event.toolKind,
            toolLocations: event.toolLocations,
          });
        }
      }
      // Forward todo state updates to webview
      if (event.todoState) {
        this.post({ type: 'statusBar', todoState: event.todoState });
      }
      if (event.done) {
        // Detect model-switch response and update status bar
        const modelMatch = /model (?:switched|changed) to:\s*([\w\-\.]+)/i.exec(this.lastTurnText);
        if (modelMatch) {
          this.post({ type: 'statusBar', model: modelMatch[1] });
        }
        // Persist ACP session ID so Hermes can resume context
        const acpId = this.session.getSessionId();
        const s = this.activeSession();
        if (s && acpId && s.acpSessionId !== acpId) {
          s.acpSessionId = acpId;
          this.persistSessions();
        }
        // Persist the turn into session history
        this.saveTurnToSession();
        this.post({ type: 'done' });
      }
      if (event.error) {
        this.lastTurnText = '';
        this.lastTurnTools = [];
        this.post({ type: 'error', text: event.error });
      }
      // Status bar live data
      if (event.model || event.sessionTitle || event.contextUsed !== undefined) {
        this.post({
          type: 'statusBar',
          model: event.model,
          sessionTitle: event.sessionTitle,
          contextUsed: event.contextUsed,
          contextSize: event.contextSize,
        });
      }
    });
  }

  post(msg: ToWebview): void {
    this.view?.webview.postMessage(msg);
  }

  private activeSession(): ChatSession | undefined {
    return this.sessions.find(s => s.id === this.activeSessionId);
  }

  private saveTurnToSession(): void {
    const s = this.activeSession();
    if (!s) { this.lastTurnText = ''; this.lastTurnTools = []; return; }

    // Append tool calls first, then agent response
    for (const t of this.lastTurnTools) s.messages.push(t);
    if (this.lastTurnText.trim()) {
      s.messages.push({ role: 'agent', text: this.lastTurnText });
    }
    // Trim to limit
    if (s.messages.length > MAX_MESSAGES_PER_SESSION) {
      s.messages = s.messages.slice(-MAX_MESSAGES_PER_SESSION);
    }
    this.persistSessions();
    this.lastTurnText = '';
    this.lastTurnTools = [];
  }

  private persistSessions(): void {
    void this.context.workspaceState.update(SESSIONS_KEY, this.sessions);
  }

  private resolveWorkingDirectory(): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceFolder) return workspaceFolder;

    const activeEditorPath = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (activeEditorPath) {
      return path.dirname(activeEditorPath);
    }

    return process.cwd();
  }

  private async handleFromWebview(msg: FromWebview): Promise<void> {
    if (msg.type === 'send' && msg.text) {
      this.log(`[ui] send (${msg.text.length} chars)`);
      // Store user message in history (skip slash commands)
      if (!msg.text.startsWith('/')) {
        const s = this.activeSession();
        if (s) {
          // Auto-title from first user message
          if (s.messages.filter(m => m.role === 'user').length === 0) {
            s.title = msg.text.slice(0, 38).replace(/\s+/g, ' ').trim();
            if (msg.text.length > 38) s.title = s.title.slice(0, 35) + '…';
            this.post({ type: 'statusBar', sessionTitle: s.title });
            this.broadcastSessions();
          }
          s.messages.push({ role: 'user', text: msg.text });
          this.persistSessions();
        }
      }

      // Build context annotation — 1 item per line
      const lines: string[] = [];
      for (const f of this.attachedFiles) {
        lines.push(`<span class="ctx-line"><span class="ctx-icon">⊕</span>${f.name}</span>`);
      }
      for (const s of this.selectedSkills) {
        lines.push(`<span class="ctx-line"><span class="ctx-icon">✦</span>${s}</span>`);
      }
      if (lines.length > 0) {
        this.post({ type: 'statusBar', contextAnnotation: lines.join('') });
      }

      if (this.busy) {
        this.log('[ui] queue + interrupt');
        this.messageQueue.push(msg.text);
        this.post({ type: 'busy', active: true, queued: this.messageQueue.length });
        // Interrupt: cancel current prompt so queue drains immediately
        // (matches Hermes TUI busy_input_mode: interrupt)
        await this.session.cancel();
      } else {
        void this.runPrompt(msg.text);
      }

    } else if (msg.type === 'cancel') {
      this.log(`[ui] cancel (${this.messageQueue.length} queued kept)`);
      // Don't clear the queue — queued messages should be sent after cancel
      this.lastTurnText = '';
      this.lastTurnTools = [];
      await this.session.cancel();

    } else if (msg.type === 'switchModel' && msg.model) {
      this.log(`[ui] switch model ${msg.model}`);
      const command = `/model ${msg.model}`;
      this.messageQueue = [];
      this.lastTurnText = '';
      this.lastTurnTools = [];
      if (this.busy) {
        await this.session.cancel();
      }
      void this.runPrompt(command);

    } else if (msg.type === 'newSession') {
      this.log('[ui] new session');
      this.messageQueue = [];
      this.lastTurnText = '';
      this.lastTurnTools = [];
      this.session.reset();
      this.activeSessionId = this.newSessionEntry('new session');
      // Trim old sessions
      if (this.sessions.length > MAX_SESSIONS) {
        this.sessions = this.sessions.slice(-MAX_SESSIONS);
      }
      this.persistSessions();
      this.post({ type: 'clear' });
      this.broadcastSessions();

    } else if (msg.type === 'switchSession' && msg.sessionId) {
      this.log(`[ui] switch session ${msg.sessionId}`);
      const target = this.sessions.find(s => s.id === msg.sessionId);
      if (!target || target.id === this.activeSessionId) return;

      this.messageQueue = [];
      this.lastTurnText = '';
      this.lastTurnTools = [];
      this.session.reset();
      this.activeSessionId = msg.sessionId;
      // Attempt to resume the stored ACP session (Hermes may still have it in memory/SQLite)
      if (target.acpSessionId) {
        this.session.setStoredSessionId(target.acpSessionId);
        this.log(`[session] will attempt resume of ACP session ${target.acpSessionId}`);
      }
      this.persistSessions();

      this.post({ type: 'clear' });
      this.post({ type: 'statusBar', sessionTitle: target.title });
      this.broadcastSessions();

      if (target.messages.length > 0) {
        this.post({ type: 'loadHistory', history: target.messages, activeSessionId: target.id });
      }

    } else if (msg.type === 'attachFile') {
      // Open file picker and send selected file info back to webview
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Attach',
        filters: { 'All Files': ['*'] },
      });
      if (uris) {
        for (const uri of uris) this.setAttachedFile(uri.fsPath);
      }

    } else if (msg.type === 'pasteImage' && msg.data && msg.ext) {
      // Save pasted image to the extension's media cache so the webview never exposes arbitrary local paths.
      const tmpPath = path.join(this.mediaRoot, `hermes-paste-${Date.now()}.${msg.ext}`);
      try {
        fs.writeFileSync(tmpPath, Buffer.from(msg.data, 'base64'));
        this.log('[ui] pasted image cached');
        this.setAttachedFile(tmpPath);
      } catch (err) {
        this.log(`[ui] failed to save pasted image: ${err}`);
      }

    } else if (msg.type === 'dropFiles' && msg.uris?.length) {
      // Handle files dropped from VS Code explorer — attach ALL dropped files
      for (const uri of msg.uris) {
        try {
          const fsPath = vscode.Uri.parse(uri).fsPath;
          this.log(`[ui] dropped file ${path.basename(fsPath)}`);
          this.setAttachedFile(fsPath);
        } catch (err) {
          this.log(`[ui] failed to parse dropped URI: ${err}`);
        }
      }

    } else if (msg.type === 'clearAttachments') {
      this.attachedFiles = [];

    } else if (msg.type === 'renameSession' && msg.sessionId) {
      const s = this.sessions.find(s => s.id === msg.sessionId);
      if (!s) return;
      const newName = await vscode.window.showInputBox({
        prompt: 'Rename session',
        value: s.title,
        placeHolder: 'Session name',
      });
      if (newName !== undefined && newName.trim()) {
        s.title = newName.trim().slice(0, 60);
        this.persistSessions();
        this.broadcastSessions();
        if (s.id === this.activeSessionId) {
          this.post({ type: 'statusBar', sessionTitle: s.title });
          // Sync title to Hermes session DB
          void this.runPrompt(`/title ${s.title}`);
        }
      }

    } else if (msg.type === 'deleteSession' && msg.sessionId) {
      // Can't delete the active session
      if (msg.sessionId === this.activeSessionId) return;
      this.sessions = this.sessions.filter(s => s.id !== msg.sessionId);
      this.persistSessions();
      this.broadcastSessions();

    } else if (msg.type === 'toggleSkill' && msg.text) {
      const idx = this.selectedSkills.indexOf(msg.text);
      if (idx >= 0) {
        this.selectedSkills.splice(idx, 1);
      } else {
        this.selectedSkills.push(msg.text);
      }
      this.log(`[ui] skills: [${this.selectedSkills.join(', ')}]`);
      this.post({ type: 'statusBar', selectedSkills: this.selectedSkills });
    }
  }

  private setAttachedFile(fsPath: string): void {
    const name = path.basename(fsPath);
    // Don't add duplicates
    if (!this.attachedFiles.find(f => f.path === fsPath)) {
      this.attachedFiles.push({ name, path: fsPath });
    }
    this.post({ type: 'statusBar', attachedFiles: this.attachedFiles.map(f => ({ name: f.name, path: f.path })) });
  }

  private async runPrompt(text: string): Promise<void> {
    this.log(`[ui] run prompt (${text.length} chars)`);
    this.busy = true;
    this.post({ type: 'busy', active: true, queued: this.messageQueue.length });
    const cwd = this.resolveWorkingDirectory();

    // Prepend IDE context + attached file for regular messages (not slash commands)
    let prompt = text;
    if (!text.startsWith('/')) {
      const ctx = this.collectIdeContext();
      if (ctx) {
        prompt = ctx + prompt;
        this.log(`[ui] attached IDE context (${ctx.length} chars)`);
      }

      // Inject selected skills as advice
      if (this.selectedSkills.length > 0) {
        prompt = `I advise you to use the following skills: ${this.selectedSkills.join(', ')}\n\n${prompt}`;
        this.log(`[ui] advised skills: ${this.selectedSkills.join(', ')}`);
        this.selectedSkills = [];
        this.post({ type: 'statusBar', selectedSkills: [] });
      }

      // Attach file paths as references (agent reads on demand via file tools)
      if (this.attachedFiles.length > 0) {
        const refs = this.attachedFiles.map(f => `[Referenced file: ${f.path}]`).join('\n');
        prompt = refs + '\n\n' + prompt;
        this.log(`[ui] attached ${this.attachedFiles.length} file ref(s)`);
        this.attachedFiles = [];
        this.post({ type: 'statusBar', attachedFiles: [] });
      }
    }

    try {
      await this.session.sendPrompt(prompt, cwd);
    } catch (err) {
      const msg = String(err);
      if (msg.includes('Cancelled')) {
        this.post({ type: 'done' });
      } else {
        this.log(`[ui] prompt error ${msg}`);
        this.post({ type: 'error', text: msg });
      }
    } finally {
      this.log('[ui] prompt finished');
      this.busy = false;
      if (this.messageQueue.length > 0) {
        const next = this.messageQueue.shift()!;
        this.post({ type: 'busy', active: true, queued: this.messageQueue.length });
        void this.runPrompt(next);
      } else {
        this.post({ type: 'busy', active: false, queued: 0 });
      }
    }
  }

  /** Collect current IDE context to prepend to user prompts. */
  private collectIdeContext(): string {
    const parts: string[] = [];

    // Active editor file + selection
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      parts.push(`[Active file: ${filePath}]`);

      const selection = editor.selection;
      if (!selection.isEmpty) {
        const selectedText = editor.document.getText(selection);
        if (selectedText.length <= 2000) {
          const startLine = selection.start.line + 1;
          const endLine = selection.end.line + 1;
          parts.push(`[Selection lines ${startLine}-${endLine}]\n\`\`\`\n${selectedText}\n\`\`\``);
        } else {
          parts.push(`[Selection: ${selectedText.length} chars, lines ${selection.start.line + 1}-${selection.end.line + 1}]`);
        }
      }
    }

    // Open editor tabs (just filenames, not content)
    const openTabs = vscode.window.tabGroups.all
      .flatMap(g => g.tabs)
      .map(t => {
        if (t.input && typeof t.input === 'object' && 'uri' in (t.input as Record<string, unknown>)) {
          return vscode.workspace.asRelativePath((t.input as { uri: vscode.Uri }).uri);
        }
        return null;
      })
      .filter((p): p is string => p !== null);

    if (openTabs.length > 0) {
      parts.push(`[Open tabs: ${openTabs.join(', ')}]`);
    }

    return parts.length > 0 ? parts.join('\n') + '\n\n' : '';
  }

  /** Open a file in VS Code editor when Hermes edits/reads it. */
  private openFileInEditor(filePath: string, isEdit: boolean): void {
    try {
      const uri = vscode.Uri.file(filePath);
      vscode.workspace.openTextDocument(uri).then(doc => {
        vscode.window.showTextDocument(doc, {
          preserveFocus: true,  // keep focus on the chat panel
          preview: !isEdit,     // edits open as persistent tabs, reads as preview
          viewColumn: vscode.ViewColumn.One,
        });
        this.log(`[ui] opened ${isEdit ? 'edited' : 'read'} file ${path.basename(filePath)}`);
      }, err => {
        this.log(`[ui] failed to open file: ${err}`);
      });
    } catch (err) {
      this.log(`[ui] openFileInEditor error: ${err}`);
    }
  }

  /** Convert MEDIA:/absolute/path references to webview-safe <img> tags. */
  private convertMediaPaths(text: string, webview: vscode.Webview): string {
    return text.replace(/MEDIA:(\/[^\s\n]+)/g, (_match, filePath: string) => {
      if (!this.isAllowedMediaPath(filePath)) {
        return `[blocked image: ${path.basename(filePath)}]`;
      }
      const uri = webview.asWebviewUri(vscode.Uri.file(filePath));
      return `![image](${uri})`;
    });
  }

  private isAllowedMediaPath(filePath: string): boolean {
    const normalizedFile = path.resolve(filePath);
    const normalizedRoot = path.resolve(this.mediaRoot) + path.sep;
    const allowedExt = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
    return normalizedFile.startsWith(normalizedRoot) && allowedExt.has(path.extname(normalizedFile).toLowerCase());
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private newSessionEntry(title: string): string {
    const id = `s${Date.now()}`;
    this.sessions.push({ id, title, createdAt: Date.now(), messages: [] });
    return id;
  }

  private broadcastSessions(): void {
    const active = this.activeSession();
    this.post({
      type: 'sessionList',
      sessions: [...this.sessions].reverse(),  // newest first
      activeSessionId: this.activeSessionId,
      sessionTitle: active?.title,
    });
  }

  /** Get the friendly label for the initial model (e.g., "Claude Sonnet 4.6" not "claude-sonnet-4-6"). */
  private initialModelLabel(): string {
    for (const g of this.modelGroups) {
      for (const m of g.items) {
        if (m.id === this.initialModel || m.command === this.initialModel) return m.label;
      }
    }
    return this.initialModel;
  }

  private buildModelMenuItems(): string {
    const allItems = this.modelGroups.flatMap(g => g.items);
    const currentInList = allItems.find(m => m.id === this.initialModel || m.command === this.initialModel);
    const extra = currentInList ? [] : [{ id: this.initialModel, label: this.initialModel, command: this.initialModel }];

    return this.modelGroups.map(group => {
      const items = group.items.map(m => {
        const active = (m.id === this.initialModel || m.command === this.initialModel) ? ' active' : '';
        const suffix = m.command === m.id
          ? ''
          : `<span style="opacity:0.45;font-size:0.82em"> ${this.escapeHtml(m.command)}</span>`;
        return `<div class="model-option${active}" data-command="${this.escapeHtml(m.command)}">${this.escapeHtml(m.label)}${suffix}</div>`;
      }).join('');
      return `<div class="model-group-label">${this.escapeHtml(group.group)}</div>${items}`;
    }).join('<div class="model-sep"></div>') +
    extra.map(m => `<div class="model-option active" data-command="${this.escapeHtml(m.command)}">${this.escapeHtml(m.label)}</div>`).join('');
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'),
    );
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'hermes-logo.png'),
    );

    const nonce = Array.from(
      { length: 32 },
      () => Math.random().toString(36)[2],
    ).join('');

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
    * { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --ui-font: 'Segoe UI', system-ui, -apple-system, sans-serif;
      --gold: #F5C542;
      --gold-dim: rgba(245, 197, 66, 0.65);
      --gold-subtle: rgba(245, 197, 66, 0.12);
      --gold-border: rgba(245, 197, 66, 0.25);
      --toolbar-height: 28px;
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

    /* Token progress bar */
    #ctx-bar-wrap {
      width: 52px; height: 5px;
      background: rgba(255,255,255,0.1);
      border-radius: 2px; overflow: hidden; flex-shrink: 0;
    }
    #ctx-bar {
      height: 100%; width: 0%;
      border-radius: 2px;
      background: var(--gold);
      transition: width 0.4s ease, background 0.3s;
    }
    #ctx-bar.warn { background: var(--gold); }
    #ctx-bar.crit { background: #C94040; }

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
      padding: 10px 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
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
    .msg.tool + .msg.tool { margin-top: -6px; }
    .msg.agent + .msg.tool { margin-top: -4px; }
    .msg.tool + .msg.agent { margin-top: 0; }
    .thinking-status + .msg.tool { margin-top: -4px; }

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
  </style>
</head>
<body>
  <div id="header">
    <div id="header-brand">
      <span class="brand-icon">☤</span>
      <span class="brand-text">Hermes</span>
      <span class="brand-version" id="status-version"></span>
      <span class="brand-sep">·</span>
      <button id="model-btn-header" title="Switch model">${this.initialModelLabel()} ▾</button>
    </div>
    <div id="header-session">
      <button id="status-session" title="Sessions">new session</button>
      <div id="status-right">
        <div id="ctx-bar-wrap" style="display:none"><div id="ctx-bar"></div></div>
        <span id="status-context"></span>
      </div>
    </div>
    <div id="session-picker" class="status-dropdown" style="display:none"></div>
    <div id="model-menu" style="display:none">
      ${this.buildModelMenuItems()}
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
      <button id="model-btn" title="Switch model">${this.initialModel} ▾</button>
    </div>
    <div id="skills-menu" style="display:none"></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
