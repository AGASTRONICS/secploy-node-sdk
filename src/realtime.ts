/**
 * Push delivery for SDK-side caches.
 *
 * The server sends an invalidation, not a payload, so `onUpdate` refetches. That
 * keeps delivery idempotent: a duplicated or out-of-order notification costs one
 * extra fetch and can never corrupt state.
 *
 * `ws` is an optional peer dependency. Without it the channel degrades to
 * polling rather than failing, so the SDK works out of the box and gets faster
 * when `ws` is installed.
 */

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
const POLL_FALLBACK_INTERVAL_MS = 15_000;

export interface RealtimeChannelOptions {
  wsUrl: string;
  headersCallback: () => Record<string, string>;
  onUpdate: () => void | Promise<void>;
  channelName?: string;
  updateMessageTypes?: string[];
}

export class RealtimeChannel {
  private wsUrl: string;
  private getHeaders: () => Record<string, string>;
  private onUpdate: () => void | Promise<void>;
  private channelName: string;
  private updateMessageTypes: string[];

  private ws: any = null;
  private stopped = true;
  private connected = false;
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(options: RealtimeChannelOptions) {
    this.wsUrl = options.wsUrl;
    this.getHeaders = options.headersCallback;
    this.onUpdate = options.onUpdate;
    this.channelName = options.channelName ?? "config";
    this.updateMessageTypes = options.updateMessageTypes ?? [
      "config.update",
      "config.subscribed",
    ];
  }

  get isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;

    const WebSocketImpl = this.loadWebSocket();
    if (!WebSocketImpl) {
      console.warn(
        `[secploy] "ws" is not installed; ${this.channelName} real-time push is ` +
          `unavailable. Falling back to ${POLL_FALLBACK_INTERVAL_MS / 1000}s polling. ` +
          `Install it with: npm install ws`,
      );
      this.startPolling();
      return;
    }

    this.connect(WebSocketImpl);
  }

  stop(): void {
    this.stopped = true;
    this.connected = false;
    this.stopPolling();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Already closing or closed; nothing to do.
      }
      this.ws = null;
    }
  }

  private loadWebSocket(): any {
    try {
      // Resolved at call time so the dependency stays genuinely optional.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require("ws");
    } catch {
      return null;
    }
  }

  private connect(WebSocketImpl: any): void {
    if (this.stopped) return;

    try {
      this.ws = new WebSocketImpl(this.wsUrl, { headers: this.getHeaders() });
    } catch (error) {
      console.warn(`[secploy] ${this.channelName} WebSocket failed to open:`, error);
      this.scheduleReconnect(WebSocketImpl);
      return;
    }

    this.ws.on("open", () => {
      this.connected = true;
      this.backoff = INITIAL_BACKOFF_MS;
      this.stopPolling();
      console.info(`[secploy] ${this.channelName} WebSocket connected.`);
    });

    this.ws.on("message", (raw: any) => {
      let data: any;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!this.updateMessageTypes.includes(data?.type)) return;

      try {
        const result = this.onUpdate();
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((error) =>
            console.warn(`[secploy] ${this.channelName} update handler failed:`, error),
          );
        }
      } catch (error) {
        console.warn(`[secploy] ${this.channelName} update handler failed:`, error);
      }
    });

    this.ws.on("error", (error: any) => {
      console.warn(`[secploy] ${this.channelName} WebSocket error:`, error?.message ?? error);
    });

    this.ws.on("close", () => {
      this.connected = false;
      if (this.stopped) return;
      this.scheduleReconnect(WebSocketImpl);
    });
  }

  private scheduleReconnect(WebSocketImpl: any): void {
    if (this.stopped) return;

    // Poll while the socket is down so an update is never missed outright.
    this.startPolling();

    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    console.warn(
      `[secploy] ${this.channelName} WebSocket disconnected. Reconnecting in ${delay / 1000}s…`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(WebSocketImpl);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private startPolling(): void {
    if (this.pollTimer || this.stopped) return;

    this.pollTimer = setInterval(() => {
      if (this.connected) {
        this.stopPolling();
        return;
      }
      try {
        const result = this.onUpdate();
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((error) =>
            console.warn(`[secploy] ${this.channelName} poll failed:`, error),
          );
        }
      } catch (error) {
        console.warn(`[secploy] ${this.channelName} poll failed:`, error);
      }
    }, POLL_FALLBACK_INTERVAL_MS);
    // Never hold the process open on the SDK's account.
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
