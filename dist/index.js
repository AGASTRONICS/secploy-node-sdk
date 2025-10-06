"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Secploy = void 0;
const axios_1 = __importDefault(require("axios"));
class Secploy {
    constructor(config, options) {
        this.config = config;
        this.client = axios_1.default.create({
            baseURL: config.baseUrl || 'https://api.secploy.com',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
                'X-Project-ID': config.projectId,
                'X-Environment': config.environment || 'production',
                ...options?.headers,
            },
            timeout: options?.timeout || 5000,
        });
        // Add request interceptor for environment info
        this.client.interceptors.request.use((config) => {
            config.headers = config.headers || {};
            config.headers['X-SDK-Version'] = '0.1.0';
            config.headers['X-SDK-Language'] = 'nodejs';
            return config;
        });
    }
    /**
     * Track a security or observability event
     */
    async trackEvent(eventData) {
        try {
            await this.client.post('/v1/events', eventData);
        }
        catch (error) {
            if (axios_1.default.isAxiosError(error)) {
                throw new Error(`Failed to track event: ${error.response?.data?.message || error.message}`);
            }
            throw error;
        }
    }
    /**
     * Get project configuration
     */
    async getConfig() {
        try {
            const response = await this.client.get('/v1/config');
            return response.data;
        }
        catch (error) {
            if (axios_1.default.isAxiosError(error)) {
                throw new Error(`Failed to get config: ${error.response?.data?.message || error.message}`);
            }
            throw error;
        }
    }
    /**
     * Initialize SDK with dynamic configuration
     */
    async initialize() {
        try {
            const config = await this.getConfig();
            // Apply any dynamic configuration from the server
            if (config.timeout) {
                this.client.defaults.timeout = config.timeout;
            }
            if (config.baseUrl) {
                this.client.defaults.baseURL = config.baseUrl;
            }
        }
        catch (error) {
            console.error('Failed to initialize Secploy SDK:', error);
            // Continue with default configuration
        }
    }
    /**
     * Record a security event
     */
    async recordSecurityEvent(eventType, data) {
        await this.trackEvent({
            type: eventType,
            category: 'security',
            data,
            timestamp: new Date().toISOString(),
        });
    }
    /**
     * Record an observability metric
     */
    async recordMetric(metricName, value, tags) {
        await this.trackEvent({
            type: 'metric',
            category: 'observability',
            data: {
                name: metricName,
                value,
                tags,
            },
            timestamp: new Date().toISOString(),
        });
    }
    /**
     * Record an audit log entry
     */
    async recordAuditLog(action, resourceType, resourceId, details) {
        await this.trackEvent({
            type: 'audit',
            category: 'security',
            data: {
                action,
                resourceType,
                resourceId,
                details,
            },
            timestamp: new Date().toISOString(),
        });
    }
}
exports.Secploy = Secploy;
