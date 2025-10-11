import { SecployConfig, LogLevel, LogHandler } from "./types";
import { EventQueue, EventHandler } from "./events";
import { EventProcessor } from "./processor";

const DEFAULT_CONFIG: Partial<SecployConfig> = {
  environment: "development",
  samplingRate: 1.0,
  heartbeatInterval: 60,
  maxRetry: 5,
  debug: false,
  logLevel: LogLevel.INFO,
  batchSize: 100,
  flushInterval: 60,
};

export class Secploy {
  private readonly config: SecployConfig;
  private eventQueue: EventQueue;
  private eventHandler: EventHandler;
  private eventProcessor: EventProcessor;
  private logHandlers: Set<LogHandler> = new Set();

  constructor(config: Partial<SecployConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config } as SecployConfig;

    if (!this.config.apiKey) {
      throw new Error("API key is required");
    }
    if (!this.config.environmentKey) {
      throw new Error("Environment key is required");
    }
    if (!this.config.organizationId) {
      throw new Error("Organization ID is required");
    }
    if (!this.config.ingestUrl) {
      throw new Error("Ingest URL is required");
    }

    this.eventQueue = new EventQueue();
    this.eventHandler = new EventHandler(this.eventQueue);
    this.eventProcessor = new EventProcessor(
      this.eventQueue,
      this.config.ingestUrl,
      () => this.getHeaders(),
      this.config.batchSize,
      this.config.flushInterval,
      this.config.maxRetry,
    );

    this.start();

    if (this.config.debug) {
      this.setupLogging();
    }
  }

  private getHeaders(): Record<string, string> {
    return {
      "X-API-Key": this.config.apiKey,
      "X-Environment-Key": this.config.environmentKey,
      "X-Organization-ID": this.config.organizationId,
      "Content-Type": "application/json",
    };
  }

  private setupLogging(): void {
    const originalConsole = { ...console };
    const logLevels: Record<string, LogLevel> = {
      log: LogLevel.INFO,
      info: LogLevel.INFO,
      warn: LogLevel.WARNING,
      error: LogLevel.ERROR,
      debug: LogLevel.DEBUG,
    };

    Object.entries(logLevels).forEach(([method, level]) => {
      (console as any)[method] = (...args: any[]) => {
        (originalConsole as any)[method](...args);

        const message = args
          .map((arg) =>
            typeof arg === "object" ? JSON.stringify(arg) : String(arg),
          )
          .join(" ");

        this.logHandlers.forEach((handler) => {
          handler.handleLog(level, message);
        });
      };
    });
  }

  registerLogHandler(handler: LogHandler): void {
    this.logHandlers.add(handler);
  }

  unregisterLogHandler(handler: LogHandler): void {
    this.logHandlers.delete(handler);
  }

  sendEvent(eventType: string, payload: Record<string, any>): boolean {
    return this.eventHandler.sendEvent(eventType, payload);
  }

  start(): void {
    this.eventProcessor.start();
  }

  async stop(): Promise<void> {
    await this.eventProcessor.stop();
  }
}
