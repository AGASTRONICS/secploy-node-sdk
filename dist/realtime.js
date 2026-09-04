"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.RealtimeChannel = void 0;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;
const POLL_FALLBACK_INTERVAL_MS = 15000;
class RealtimeChannel {
    constructor(options) {
        this.ws = null;
        this.stopped = true;
        this.connected = false;
        this.backoff = INITIAL_BACKOFF_MS;
        this.reconnectTimer = null;
        this.pollTimer = null;
        this.wsUrl = options.wsUrl;
        this.getHeaders = options.headersCallback;
        this.onUpdate = options.onUpdate;
        this.channelName = options.channelName ?? "config";
        this.updateMessageTypes = options.updateMessageTypes ?? [
            "config.update",
            "config.subscribed",
        ];
    }
    get isConnected() {
        return this.connected;
    }
    start() {
        if (!this.stopped)
            return;
        this.stopped = false;
        const WebSocketImpl = this.loadWebSocket();
        if (!WebSocketImpl) {
            console.warn(`[secploy] "ws" is not installed; ${this.channelName} real-time push is ` +
                `unavailable. Falling back to ${POLL_FALLBACK_INTERVAL_MS / 1000}s polling. ` +
                `Install it with: npm install ws`);
            this.startPolling();
            return;
        }
        this.connect(WebSocketImpl);
    }
    stop() {
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
            }
            catch {
                // Already closing or closed; nothing to do.
            }
            this.ws = null;
        }
    }
    loadWebSocket() {
        try {
            // Resolved at call time so the dependency stays genuinely optional.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            return require("ws");
        }
        catch {
            return null;
        }
    }
    connect(WebSocketImpl) {
        if (this.stopped)
            return;
        try {
            this.ws = new WebSocketImpl(this.wsUrl, { headers: this.getHeaders() });
        }
        catch (error) {
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
        this.ws.on("message", (raw) => {
            let data;
            try {
                data = JSON.parse(raw.toString());
            }
            catch {
                return;
            }
            if (!this.updateMessageTypes.includes(data?.type))
                return;
            try {
                const result = this.onUpdate();
                if (result && typeof result.catch === "function") {
                    result.catch((error) => console.warn(`[secploy] ${this.channelName} update handler failed:`, error));
                }
            }
            catch (error) {
                console.warn(`[secploy] ${this.channelName} update handler failed:`, error);
            }
        });
        this.ws.on("error", (error) => {
            console.warn(`[secploy] ${this.channelName} WebSocket error:`, error?.message ?? error);
        });
        this.ws.on("close", () => {
            this.connected = false;
            if (this.stopped)
                return;
            this.scheduleReconnect(WebSocketImpl);
        });
    }
    scheduleReconnect(WebSocketImpl) {
        if (this.stopped)
            return;
        // Poll while the socket is down so an update is never missed outright.
        this.startPolling();
        const delay = this.backoff;
        this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
        console.warn(`[secploy] ${this.channelName} WebSocket disconnected. Reconnecting in ${delay / 1000}s…`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect(WebSocketImpl);
        }, delay);
        this.reconnectTimer.unref?.();
    }
    startPolling() {
        if (this.pollTimer || this.stopped)
            return;
        this.pollTimer = setInterval(() => {
            if (this.connected) {
                this.stopPolling();
                return;
            }
            try {
                const result = this.onUpdate();
                if (result && typeof result.catch === "function") {
                    result.catch((error) => console.warn(`[secploy] ${this.channelName} poll failed:`, error));
                }
            }
            catch (error) {
                console.warn(`[secploy] ${this.channelName} poll failed:`, error);
            }
        }, POLL_FALLBACK_INTERVAL_MS);
        // Never hold the process open on the SDK's account.
        this.pollTimer.unref?.();
    }
    stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }
}
exports.RealtimeChannel = RealtimeChannel;
