/**
 * WebSocket client for real-time chat communication.
 * Replaces POST-based SSE with a single persistent connection per conversation.
 */

export type WSEventHandler = (event: unknown) => void;
export type WSCloseHandler = (code: number, reason: string) => void;
export type WSErrorHandler = (error: Event) => void;

interface WSClientOptions {
  onMessage: WSEventHandler;
  onClose?: WSCloseHandler;
  onError?: WSErrorHandler;
  onOpen?: () => void;
  maxReconnectDelay?: number;
}

export class WSClient {
  private ws: WebSocket | null = null;
  private convId: string;
  private options: WSClientOptions;
  private reconnectDelay = 1000;
  private maxReconnectDelay: number;
  private shouldReconnect = true;
  private _isConnected = false;

  constructor(convId: string, options: WSClientOptions) {
    this.convId = convId;
    this.options = options;
    this.maxReconnectDelay = options.maxReconnectDelay ?? 30000;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const url = `${protocol}//${host}/ws/chat/${this.convId}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this._isConnected = true;
      this.reconnectDelay = 1000; // Reset backoff on successful connect
      this.options.onOpen?.();
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('[WS raw]', data.type, data);
        if (isValidWSEvent(data)) {
          this.options.onMessage(data);
        }
      } catch {
        // Skip malformed messages
      }
    };

    this.ws.onclose = (event) => {
      this._isConnected = false;
      this.options.onClose?.(event.code, event.reason);

      if (this.shouldReconnect && event.code !== 1000) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (event) => {
      this.options.onError?.(event);
    };
  }

  send(action: string, payload?: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket not connected, cannot send:', action);
      return;
    }
    this.ws.send(JSON.stringify({ action, ...(payload ?? {}) }));
  }

  close(): void {
    this.shouldReconnect = false;
    this._isConnected = false;
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
  }

  /** Switch to a different conversation */
  switchConversation(newConvId: string): void {
    this.convId = newConvId;
    this.shouldReconnect = true;
    if (this.ws) {
      this.ws.close(1000, 'Switching conversation');
      this.ws = null;
    }
    this.connect();
  }

  private scheduleReconnect(): void {
    setTimeout(() => {
      if (this.shouldReconnect) {
        this.connect();
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      }
    }, this.reconnectDelay);
  }
}

/**
 * Lightweight type guard for WebSocket events.
 * Validates the event structure without external dependencies.
 */
function isValidWSEvent(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  const t = d.type;
  if (typeof t !== 'string') return false;
  switch (t) {
    case 'token':
      return typeof d.token === 'string' || (d.data != null && typeof d.data === 'object');
    case 'tool_call':
      return d.tool_call != null || d.data != null;
    case 'tool_result':
      return d.tool_result != null || d.data != null;
    case 'step_start':
      return d.step_start != null || d.data != null;
    case 'done':
      return true;
    case 'error':
      return typeof d.error === 'string' || (d.data != null && typeof d.data === 'object');
    case 'plan_complete':
      return true;
    case 'refusal_event':
    case 'tool_retrieval_start':
    case 'tool_retrieval_done':
    case 'step_execute':
    case 'plan_retry':
      return true;
    default:
      return false;
  }
}
