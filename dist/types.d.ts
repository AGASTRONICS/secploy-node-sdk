export interface SecployConfig {
    apiKey: string;
    projectId: string;
    environment?: string;
    baseUrl?: string;
}
export interface SecployOptions {
    headers?: Record<string, string>;
    timeout?: number;
}
export interface EventData {
    type: string;
    category: 'security' | 'observability' | 'audit';
    data: Record<string, any>;
    timestamp: string;
}
export interface MetricData {
    name: string;
    value: number;
    tags?: Record<string, string>;
}
