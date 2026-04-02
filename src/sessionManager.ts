/**
 * Manages a single active ACP session.
 *
 * ACP method names (v1 protocol):
 *   session/new     — create session, returns { sessionId, models?, ... }
 *   session/prompt  — send message, blocks until done, params { sessionId, prompt: [...] }
 *   session/cancel  — abort (notification, no response), params { sessionId }
 *
 * Incoming notifications from agent:
 *   session/update  — { sessionId, update: { sessionUpdate, ... } }
 *     update kinds handled:
 *       agent_message_chunk  — streaming text delta
 *       agent_thought_chunk  — thinking text
 *       tool_call            — tool progress
 *       usage_update         — context used/size tokens
 *       session_info_update  — session title
 *
 * Incoming requests from agent:
 *   session/request_permission — auto-approved with allow_once
 *
 * Deduplication:
 *   Hermes ACP sends text as streaming deltas AND then resends the full
 *   accumulated text at the end as a reliability fallback. We track the
 *   accumulated text and drop the final repeated message.
 */

import { AcpClient } from './acpClient';

export interface SessionUpdateEvent {
  session_id: string;
  text?: string;
  thinkingText?: string;
  toolTitle?: string;
  toolStatus?: string;
  toolCallId?: string;
  toolDetail?: string;   // key argument summary (e.g., file path, command)
  toolKind?: string;     // read, edit, execute, search, fetch, think, other
  toolLocations?: string[]; // affected file paths
  todoState?: unknown;   // parsed todo JSON from todo tool output
  done?: boolean;
  error?: string;
  // Status bar live data
  model?: string;
  sessionTitle?: string;
  contextUsed?: number;
  contextSize?: number;
}

export type SessionUpdateHandler = (event: SessionUpdateEvent) => void;

export class SessionManager {
  private sessionId: string | null = null;
  private updateHandler: SessionUpdateHandler | null = null;

  /** Accumulated streaming text for the current turn (used for dedup). */
  private accumulated = '';

  /**
   * Reject handle for the in-flight session/prompt call.
   * Set while sendPrompt is awaiting; cleared on resolve/cancel.
   * Calling it immediately unblocks runPrompt without waiting for Hermes to ack.
   */
  private promptReject: ((err: Error) => void) | null = null;

  /** Set by cancel() to gate out stale session/update notifications from Hermes. */
  private cancelled = false;

  constructor(
    private readonly client: AcpClient,
    private readonly log: (line: string) => void = () => {},
  ) {
    client.onNotification((method, params) => {
      if (method === 'session/update') {
        this.handleUpdate(params as Record<string, unknown>);
      }
    });

    client.onIncomingRequest(async (method, _params) => {
      if (method === 'session/request_permission') {
        return { outcome: 'selected', optionId: 'allow_once' };
      }
      throw new Error(`Unhandled client method: ${method}`);
    });
  }

  onUpdate(handler: SessionUpdateHandler): void {
    this.updateHandler = handler;
  }

  /** Set a stored ACP session ID for resume attempts. */
  setStoredSessionId(id: string | undefined): void {
    this.storedSessionId = id ?? null;
  }
  private storedSessionId: string | null = null;

  /** Returns the current ACP session ID (for persistence by the caller). */
  getSessionId(): string | null {
    return this.sessionId;
  }

  async ensureSession(cwd: string): Promise<string> {
    if (this.sessionId) {
      this.log(`[session] reusing ${this.sessionId}`);
      return this.sessionId;
    }

    // Try to resume a stored session first (Hermes persists sessions in SQLite)
    if (this.storedSessionId) {
      this.log(`[session] attempting resume of ${this.storedSessionId}`);
      this.sessionId = this.storedSessionId;
      this.storedSessionId = null;
      return this.sessionId;
    }

    this.log(`[session] creating new session for cwd=${cwd}`);

    const result = (await this.client.call('session/new', {
      cwd,
      mcpServers: [],
    })) as { sessionId: string; models?: { currentModelId?: string } };

    this.sessionId = result.sessionId;
    this.log(`[session] created ${this.sessionId}`);

    // Emit initial model from session/new response
    const model = result.models?.currentModelId;
    if (model && this.updateHandler) {
      this.updateHandler({ session_id: this.sessionId, model });
    }

    return this.sessionId;
  }

  async sendPrompt(text: string, cwd: string): Promise<void> {
    const sessionId = await this.ensureSession(cwd);
    this.log(`[session] prompt ${sessionId}: ${text.slice(0, 120)}`);
    this.accumulated = '';
    this.cancelled = false;

    // Wrap the call in a cancellable promise so cancel() can unblock us immediately
    // without having to wait for Hermes to finish processing session/cancel.
    let promptResponse: Record<string, unknown> = {};
    await new Promise<void>((resolve, reject) => {
      this.promptReject = reject;

      this.client
        .call('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text }],
        })
        .then((result) => {
          promptResponse = (result as Record<string, unknown>) ?? {};
          resolve();
        })
        .catch(reject)
        .finally(() => {
          this.promptReject = null;
        });
    });

    // Extract current context usage from PromptResponse.
    // usage.inputTokens = last_prompt_tokens (current window usage, not cumulative).
    // _meta.contextLength = model context window size (for progress bar).
    const usage = promptResponse.usage as Record<string, unknown> | undefined;
    const meta = promptResponse['_meta'] as Record<string, unknown> | undefined;
    const contextUsed: number | undefined = (
      typeof usage?.inputTokens === 'number' && usage.inputTokens > 0 ? usage.inputTokens as number :
      undefined
    );
    const contextSize: number | undefined = (
      typeof meta?.contextLength === 'number' && meta.contextLength > 0 ? meta.contextLength as number :
      undefined
    );
    this.log(`[session] prompt done ${sessionId}${contextUsed ? ` used=${contextUsed}` : ''}${contextSize ? ` size=${contextSize}` : ''}`);
    this.updateHandler?.({ session_id: sessionId, done: true, contextUsed, contextSize });
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.log('[session] cancel requested');
    // Unblock sendPrompt immediately — don't wait for Hermes to ack
    if (this.promptReject) {
      this.promptReject(new Error('Cancelled'));
      this.promptReject = null;
    }

    if (!this.sessionId) return;
    // session/cancel is a notification in ACP — no id, no response expected
    this.client.notify('session/cancel', { sessionId: this.sessionId });
  }

  reset(): void {
    this.log('[session] reset');
    this.sessionId = null;
    this.accumulated = '';
  }

  private handleUpdate(params: Record<string, unknown>): void {
    if (!this.updateHandler) return;

    const session_id = params.sessionId as string;
    const update = params.update as Record<string, unknown> | undefined;
    if (!update) return;

    const kind = update.sessionUpdate as string;
    const event: SessionUpdateEvent = { session_id };

    switch (kind) {
      case 'agent_message_chunk': {
        if (this.cancelled) return;
        const content = update.content as Record<string, unknown> | undefined;
        if (content?.type !== 'text' || typeof content.text !== 'string') return;

        const text = content.text as string;

        // Deduplication: Hermes resends text as a reliability fallback.
        // Three patterns:
        //   1. Exact full resend: text === accumulated
        //   2. Superset resend: text starts with accumulated (new tail only)
        //   3. Partial resend: accumulated ends with text (last paragraph repeated)
        if (text === this.accumulated) return;

        if (text.length > 10 && text.startsWith(this.accumulated)) {
          const newPart = text.slice(this.accumulated.length);
          if (!newPart) return;
          this.accumulated = text;
          event.text = newPart;
          break;
        }

        if (text.length > 10 && this.accumulated.endsWith(text)) {
          this.log(`[session] dedup: dropped partial resend (${text.length} chars)`);
          return;
        }

        this.accumulated += text;
        event.text = text;
        break;
      }

      case 'agent_thought_chunk': {
        if (this.cancelled) return;
        const content = update.content as Record<string, unknown> | undefined;
        if (content?.type !== 'text' || typeof content.text !== 'string') return;
        const t = content.text as string;
        if (t.trim()) event.thinkingText = t;
        break;
      }

      case 'tool_call': {
        if (this.cancelled) return;
        event.toolTitle = (update.title as string) ?? 'tool';
        event.toolStatus = (update.status as string) ?? 'running';
        event.toolCallId = update.toolCallId as string | undefined;
        event.toolKind = (update.kind as string) ?? 'other';

        // Extract file paths from locations
        const locations = update.locations as { path?: string }[] | undefined;
        if (locations?.length) {
          event.toolLocations = locations.map(l => l.path).filter((p): p is string => !!p);
        }

        // Extract a short detail from rawInput (first string value)
        const rawInput = update.rawInput as Record<string, unknown> | undefined;
        if (rawInput) {
          // Todo tool: rawInput IS the todo state ({todos: [...]})
          if (event.toolTitle === 'todo' && Array.isArray(rawInput.todos)) {
            event.todoState = rawInput;
            this.log(`[session] todo tool_call: ${(rawInput.todos as unknown[]).length} items`);
          } else {
            const firstVal = Object.values(rawInput).find(v => typeof v === 'string') as string | undefined;
            if (firstVal) event.toolDetail = firstVal.length > 80 ? firstVal.slice(0, 77) + '…' : firstVal;
          }
        }
        break;
      }

      case 'tool_call_update': {
        if (this.cancelled) return;
        event.toolCallId = update.toolCallId as string | undefined;
        event.toolStatus = (update.status as string) ?? 'completed';
        event.toolTitle = ''; // signal that this is an update, not a new call

        // Detect todo tool output in raw_output or content
        const rawOutput = update.rawOutput ?? (update as Record<string, unknown>).raw_output;
        if (typeof rawOutput === 'string' && rawOutput.includes('"todos"')) {
          try {
            const parsed = JSON.parse(rawOutput);
            if (Array.isArray(parsed?.todos)) {
              event.todoState = parsed;
              this.log(`[session] todo update: ${parsed.todos.length} items`);
            }
          } catch { /* not todo JSON */ }
        }
        // Also check content blocks for todo JSON
        const contentBlocks = update.content as { content?: { text?: string } }[] | undefined;
        if (!event.todoState && Array.isArray(contentBlocks)) {
          for (const block of contentBlocks) {
            const text = block?.content?.text;
            if (typeof text === 'string' && text.includes('"todos"')) {
              try {
                const parsed = JSON.parse(text);
                if (Array.isArray(parsed?.todos)) {
                  event.todoState = parsed;
                  this.log(`[session] todo update from content: ${parsed.todos.length} items`);
                  break;
                }
              } catch { /* not todo JSON */ }
            }
          }
        }
        break;
      }

      case 'usage_update': {
        // Context window usage — size and used are in tokens
        const size = update.size as number | undefined;
        const used = update.used as number | undefined;
        if (typeof size === 'number' && typeof used === 'number') {
          event.contextUsed = used;
          event.contextSize = size;
        } else {
          return;
        }
        break;
      }

      case 'session_info_update': {
        const title = update.title as string | undefined;
        if (title) {
          event.sessionTitle = title;
        } else {
          return;
        }
        break;
      }

      default:
        return;
    }

    this.updateHandler(event);
  }
}
