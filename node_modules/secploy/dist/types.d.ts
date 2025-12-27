export declare enum LogLevel {
    DEBUG = "DEBUG",
    INFO = "INFO",
    WARNING = "WARNING",
    ERROR = "ERROR",
    CRITICAL = "CRITICAL"
}
export interface SecployConfig {
    apiKey: string;
    environmentKey: string;
    organizationId: string;
    environment?: string;
    samplingRate?: number;
    ingestUrl: string;
    heartbeatInterval?: number;
    maxRetry?: number;
    debug?: boolean;
    logLevel?: LogLevel;
    batchSize?: number;
    flushInterval?: number;
}
export interface SecployOptions {
    headers?: Record<string, string>;
    timeout?: number;
}
export interface EventData {
    type: string;
    payload: Record<string, any>;
    timestamp: number;
}
export interface EventBatch {
    events: EventData[];
    size: number;
    lastFlush: number;
}
export interface LoggerOptions {
    name?: string;
    levels?: LogLevel[];
}
export interface LogHandler {
    handleLog(level: LogLevel, message: string, meta?: Record<string, any>): void;
}
