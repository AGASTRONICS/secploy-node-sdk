import { EventData, SecployConfig, SecployOptions } from "./types";
import axios, { AxiosInstance } from "axios";

export class Secploy {
  private client: AxiosInstance;
  private readonly config: SecployConfig;

  constructor(config: SecployConfig, options?: SecployOptions) {
    this.config = config;

    this.client = axios.create({
      baseURL: config.ingestUrl || "https://ingest.secploy.com",
      headers: {
        "X-API-Key": config.apiKey,
        "X-Environment-Key": config.environmentKey,
        "X-Organization-ID": config.organizationId,
        "Content-Type": "application/json",
        ...options?.headers,
      },
      timeout: options?.timeout || 5000,
    });

    // Add request interceptor for environment info
    this.client.interceptors.request.use((config) => {
      config.headers = config.headers || {};
      config.headers["X-SDK-Version"] = "0.1.0";
      config.headers["X-SDK-Language"] = "nodejs";
      return config;
    });
  }

  /**
   * Track a security or observability event
   */
  async trackEvent(eventData: EventData): Promise<void> {
    try {
      await this.client.post("/v1/events", eventData);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Failed to track event: ${error.response?.data?.message || error.message}`
        );
      }
      throw error;
    }
  }

  /**
   * Get project configuration
   */
  async getConfig(): Promise<Record<string, any>> {
    try {
      const response = await this.client.get("/v1/config");
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Failed to get config: ${error.response?.data?.message || error.message}`
        );
      }
      throw error;
    }
  }

  /**
   * Initialize SDK with dynamic configuration
   */
  async initialize(): Promise<void> {
    try {
      const config = await this.getConfig();
      // Apply any dynamic configuration from the server
      if (config.timeout) {
        this.client.defaults.timeout = config.timeout;
      }
      if (config.baseUrl) {
        this.client.defaults.baseURL = config.baseUrl;
      }
    } catch (error) {
      console.error("Failed to initialize Secploy SDK:", error);
      // Continue with default configuration
    }
  }

  /**
   * Record a security event
   */
  async recordSecurityEvent(
    eventType: string,
    data: Record<string, any>
  ): Promise<void> {
    await this.trackEvent({
      type: eventType,
      payload: data,
      timestamp: Date.now(),
    });
  }

  /**
   * Record an observability metric
   */
  async recordMetric(
    metricName: string,
    value: number,
    tags?: Record<string, string>
  ): Promise<void> {
    await this.trackEvent({
      type: "metric",
      payload: {
        name: metricName,
        value,
        tags,
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Record an audit log entry
   */
  async recordAuditLog(
    action: string,
    resourceType: string,
    resourceId: string,
    details?: Record<string, any>
  ): Promise<void> {
    await this.trackEvent({
      type: "audit",
      payload: {
        action,
        resourceType,
        resourceId,
        details,
      },
      timestamp: Date.now(),
    });
  }
}
