import { EventData, SecployConfig, SecployOptions } from "./types";
export declare class Secploy {
    private client;
    private readonly config;
    constructor(config: SecployConfig, options?: SecployOptions);
    /**
     * Track a security or observability event
     */
    trackEvent(eventData: EventData): Promise<void>;
    /**
     * Get project configuration
     */
    getConfig(): Promise<Record<string, any>>;
    /**
     * Initialize SDK with dynamic configuration
     */
    initialize(): Promise<void>;
    /**
     * Record a security event
     */
    recordSecurityEvent(eventType: string, data: Record<string, any>): Promise<void>;
    /**
     * Record an observability metric
     */
    recordMetric(metricName: string, value: number, tags?: Record<string, string>): Promise<void>;
    /**
     * Record an audit log entry
     */
    recordAuditLog(action: string, resourceType: string, resourceId: string, details?: Record<string, any>): Promise<void>;
}
