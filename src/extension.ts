import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { AcpClient } from './acpClient';
import { SessionManager } from './sessionManager';
import { ChatPanelProvider } from './chatPanel';

const DEFAULT_SONNET_MODEL = 'claude-sonnet-4-6';

function extractModelFromHermesConfig(content: string): string | null {
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const modelMatch = /^(\s*)model:\s*(.*)$/.exec(line);
    if (!modelMatch) continue;

    const modelIndent = modelMatch[1].length;
    const inlineValue = modelMatch[2].trim();
    if (inlineValue) {
      return inlineValue;
    }

    for (let j = i + 1; j < lines.length; j += 1) {
      const childLine = lines[j];
      if (!childLine.trim() || childLine.trimStart().startsWith('#')) continue;

      const childIndent = childLine.match(/^\s*/)?.[0].length ?? 0;
      if (childIndent <= modelIndent) break;

      const defaultMatch = /^\s*default:\s*(\S+)/.exec(childLine);
      if (defaultMatch) {
        return defaultMatch[1];
      }
    }
  }

  return null;
}

function readHermesModel(): { model: string; source: 'env' | 'config' | 'fallback' } {
  try {
    const configPath = path.join(os.homedir(), '.hermes', 'config.yaml');
    const content = fs.readFileSync(configPath, 'utf8');
    const model = extractModelFromHermesConfig(content);
    if (model) {
      return { model, source: 'config' };
    }
  } catch {
    // Fall through to the built-in Sonnet default.
  }

  return { model: DEFAULT_SONNET_MODEL, source: 'fallback' };
}

function readHermesVersion(hermesPath: string): string {
  try {
    const output = execFileSync(hermesPath, ['--version'], {
      timeout: 5000,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.dirname(hermesPath)}:${process.env.PATH ?? ''}` },
    });
    const match = output.match(/v(\d+\.\d+\.\d+)/);
    return match?.[1] ? `v${match[1]}` : '';
  } catch {
    return '';
  }
}

let client: AcpClient | null = null;
let outputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('Hermes');
  context.subscriptions.push(outputChannel);

  // Locate the hermes binary — resolve full path if 'hermes' isn't in PATH
  const hermesConfig = vscode.workspace.getConfiguration('hermes');
  let hermesPath = hermesConfig.get<string>('path', 'hermes')!;

  outputChannel.appendLine(`[hermes] homedir: ${os.homedir()}`);
  outputChannel.appendLine(`[hermes] platform: ${process.platform}`);

  if (hermesPath === 'hermes') {
    // Try `which` first (respects full shell PATH)
    try {
      const resolved = execFileSync('which', ['hermes'], { timeout: 3000, encoding: 'utf8' }).trim();
      if (resolved) hermesPath = resolved;
    } catch { /* not in PATH */ }

    // Fallback: try common install locations
    if (hermesPath === 'hermes') {
      const tryPaths = [
        path.join(os.homedir(), '.local', 'bin', 'hermes'),
        '/usr/local/bin/hermes',
        '/usr/bin/hermes',
      ];
      for (const p of tryPaths) {
        try {
          if (fs.existsSync(p)) { hermesPath = p; break; }
        } catch { /* skip */ }
      }
    }
  }
  outputChannel.appendLine(`[hermes] binary: ${hermesPath}`);
  const debugLogs = hermesConfig.get<boolean>('debugLogs', false);

  client = new AcpClient(
    hermesPath,
    debugLogs ? { HERMES_LOG_LEVEL: 'DEBUG' } : {},
  );

  if (debugLogs) {
    outputChannel.show(true);
    outputChannel.appendLine('[hermes] ACP debug logging enabled');
  }

  client.on('log', (line: string) => outputChannel.appendLine(line));
  client.on('exit', (code: number) => {
    outputChannel.appendLine(`[hermes acp exited: code ${code}]`);
    setStatus('disconnected');
  });

  const session = new SessionManager(client, line => outputChannel.appendLine(line));
  const { model: hermesModel } = readHermesModel();
  const hermesVersion = readHermesVersion(hermesPath);
  const panel = new ChatPanelProvider(
    context.extensionUri,
    session,
    hermesModel,
    hermesVersion,
    context,
    line => outputChannel.appendLine(line),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanelProvider.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('hermes.openChat', async () => {
      outputChannel.appendLine('[ui] open chat');
      await vscode.commands.executeCommand('hermes.chatView.focus');
      await ensureConnected();
    }),

    vscode.commands.registerCommand('hermes.newSession', () => {
      outputChannel.appendLine('[ui] new session');
      session.reset();
      panel.post({ type: 'clear' });
    }),
  );

  // Status bar
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusItem.text = '$(circle-outline) Hermes';
  statusItem.command = 'hermes.openChat';
  statusItem.show();
  context.subscriptions.push(statusItem);

  function setStatus(state: 'connected' | 'disconnected' | 'connecting'): void {
    const icons: Record<string, string> = {
      connected: '$(circle-filled)',
      disconnected: '$(circle-outline)',
      connecting: '$(loading~spin)',
    };
    statusItem.text = `${icons[state]} Hermes`;
    panel.post({ type: 'status', status: state });
  }

  async function ensureConnected(): Promise<void> {
    if (!client) return;
    outputChannel.appendLine('[acp] connecting');
    setStatus('connecting');
    try {
      await client.start();
      outputChannel.appendLine('[acp] connected');
      setStatus('connected');
    } catch (err) {
      outputChannel.appendLine(`[acp] connect failed: ${err}`);
      setStatus('disconnected');
      vscode.window.showErrorMessage(`Hermes: failed to start — ${err}`);
    }
  }

  // Auto-connect
  ensureConnected();
}

export function deactivate(): void {
  client?.stop();
}
