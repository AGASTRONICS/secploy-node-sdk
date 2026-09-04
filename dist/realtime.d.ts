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
export interface RealtimeChannelOptions {
    wsUrl: string;
    headersCallback: () => Record<string, string>;
    onUpdate: () => void | Promise<void>;
    channelName?: string;
    updateMessageTypes?: string[];
}
export declare class RealtimeChannel {
    private wsUrl;
    private getHeaders;
    private onUpdate;
    private channelName;
    private updateMessageTypes;
    private ws;
    private stopped;
    private connected;
    private backoff;
    private reconnectTimer;
    private pollTimer;
    constructor(options: RealtimeChannelOptions);
    get isConnected(): boolean;
    start(): void;
    stop(): void;
    private loadWebSocket;
    private connect;
    private scheduleReconnect;
    private startPolling;
    private stopPolling;
}
