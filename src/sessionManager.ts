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
import type { SessionUpdateEvent, SessionUpdateHandler } from './types';
import {
  extractTextContent, deduplicateChunk,
  parseToolCall, parseToolCallUpdate,
  parseUsageUpdate, parseSessionInfoUpdate,
} from './protocol';

export type PermissionRequestHandler = (method: string, params: unknown) => Promise<unknown>;

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
    private readonly permissionRequestHandler?: PermissionRequestHandler,
  ) {
    client.onNotification((method, params) => {
      if (method === 'session/update') {
        this.handleUpdate(params as Record<string, unknown>);
      }
    });

    client.onIncomingRequest(async (method, _params) => {
      if (method === 'session/request_permission') {
        if (!this.permissionRequestHandler) {
          throw new Error('Permission denied: no approval handler registered');
        }
        return this.permissionRequestHandler(method, _params);
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

    // Try to resume a stored session first.
    // Critical: we MUST call session/load so the adapter registers our session ID
    // in its in-memory map. Just assuming the ID is live (previous bug) creates a
    // phantom session that silently fails on subsequent session/prompt calls.
    if (this.storedSessionId) {
      const storedId = this.storedSessionId;
      this.storedSessionId = null;
      try {
        this.log(`[session] attempting session/load ${storedId}`);
        const result = await this.client.call('session/load', {
          sessionId: storedId,
          cwd,
          mcpServers: [],
        });
        // Adapter returns null when session not found — load_session() → None
        if (result !== null && result !== undefined) {
          this.sessionId = storedId;
          this.log(`[session] resumed ${storedId}`);
          return this.sessionId;
        }
        this.log(`[session] stored session ${storedId} not found on adapter, creating new`);
      } catch (err) {
        this.log(`[session] session/load failed (${err}), creating new`);
      }
      // Fall through to session/new
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
    this.log(`[session] prompt ${sessionId} (${text.length} chars)`);
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
    // usage.inputTokens = last_prompt_tokens (total sent to API including cached).
    // usage.cachedReadTokens = portion served from Anthropic prompt cache (90% cheaper).
    // _meta.contextLength = model context window size (for progress bar).
    const usage = promptResponse.usage as Record<string, unknown> | undefined;
    const meta = promptResponse['_meta'] as Record<string, unknown> | undefined;
    const inputTokens = typeof usage?.inputTokens === 'number' ? usage.inputTokens as number : 0;
    const cachedTokens = typeof usage?.cachedReadTokens === 'number' ? usage.cachedReadTokens as number : 0;
    // contextUsed shows total (matches what the model "sees"), but we also emit cached for the UI.
    const contextUsed: number | undefined = inputTokens > 0 ? inputTokens : undefined;
    const contextSize: number | undefined = (
      typeof meta?.contextLength === 'number' && meta.contextLength > 0 ? meta.contextLength as number :
      undefined
    );
    this.log(`[session] prompt done ${sessionId}${contextUsed ? ` used=${contextUsed}` : ''}${cachedTokens ? ` cached=${cachedTokens}` : ''}${contextSize ? ` size=${contextSize}` : ''}`);
    this.updateHandler?.({ session_id: sessionId, done: true, contextUsed, contextSize, cachedTokens });
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
    this.storedSessionId = null;
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
        const text = extractTextContent(update);
        if (text === null) return;
        const result = deduplicateChunk(text, this.accumulated);
        if (result.action === 'drop') {
          if (this.accumulated.endsWith(text)) {
            this.log(`[session] dedup: dropped partial resend (${text.length} chars)`);
          }
          return;
        }
        this.accumulated = result.newAccumulated;
        event.text = result.text;
        break;
      }

      case 'agent_thought_chunk': {
        if (this.cancelled) return;
        const text = extractTextContent(update);
        if (text?.trim()) event.thinkingText = text;
        else return;
        break;
      }

      case 'tool_call': {
        if (this.cancelled) return;
        const parsed = parseToolCall(update);
        event.toolTitle = parsed.title;
        event.toolStatus = parsed.status;
        event.toolCallId = parsed.toolCallId;
        event.toolKind = parsed.kind;
        if (parsed.locations.length) event.toolLocations = parsed.locations;
        if (parsed.detail) event.toolDetail = parsed.detail;
        if (parsed.todoState) {
          event.todoState = parsed.todoState;
          this.log(`[session] todo tool_call: ${parsed.todoState.todos.length} items`);
        }
        break;
      }

      case 'tool_call_update': {
        if (this.cancelled) return;
        const parsed = parseToolCallUpdate(update);
        event.toolCallId = parsed.toolCallId;
        event.toolStatus = parsed.status;
        event.toolTitle = ''; // signal: update, not new call
        if (parsed.todoState) {
          event.todoState = parsed.todoState;
          this.log(`[session] todo update: ${parsed.todoState.todos.length} items`);
        }
        break;
      }

      case 'usage_update': {
        const usage = parseUsageUpdate(update);
        if (!usage) return;
        event.contextUsed = usage.contextUsed;
        event.contextSize = usage.contextSize;
        break;
      }

      case 'session_info_update': {
        const title = parseSessionInfoUpdate(update);
        if (!title) return;
        event.sessionTitle = title;
        break;
      }

      default:
        return;
    }

    this.updateHandler(event);
  }
}
