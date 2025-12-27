import { SecployConfig, LogHandler } from "./types";
export declare class Secploy {
    private readonly config;
    private eventQueue;
    private eventHandler;
    private eventProcessor;
    private logHandlers;
    constructor(config: Partial<SecployConfig>);
    private getHeaders;
    private setupLogging;
    registerLogHandler(handler: LogHandler): void;
    unregisterLogHandler(handler: LogHandler): void;
    sendEvent(eventType: string, payload: Record<string, any>): boolean;
    start(): void;
    stop(): Promise<void>;
}
