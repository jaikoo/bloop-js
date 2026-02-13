export interface BloopConfig {
  endpoint: string;
  /** Project API key (used for both auth and project identification). */
  projectKey: string;
  /** @deprecated Use projectKey instead. Legacy HMAC secret for backward compat. */
  secret?: string;
  source?: "ios" | "android" | "api";
  environment: string;
  release: string;
  maxBufferSize?: number;
  flushIntervalMs?: number;
}

export interface ErrorEvent {
  errorType: string;
  message: string;
  route?: string;
  stack?: string;
  httpStatus?: number;
  requestId?: string;
  userIdHash?: string;
  metadata?: Record<string, unknown>;
}

interface IngestEvent {
  timestamp: number;
  source: string;
  environment: string;
  release: string;
  error_type: string;
  message: string;
  route_or_procedure?: string;
  stack?: string;
  http_status?: number;
  request_id?: string;
  user_id_hash?: string;
  metadata?: Record<string, unknown>;
}

export class BloopClient {
  private config: Required<
    Pick<BloopConfig, "endpoint" | "source" | "environment" | "release">
  > &
    BloopConfig;
  private buffer: IngestEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private signingKey: CryptoKey | null = null;
  private keyReady: Promise<void>;
  private globalHandlersInstalled = false;

  constructor(config: BloopConfig) {
    this.config = {
      source: "api",
      maxBufferSize: 20,
      flushIntervalMs: 5000,
      ...config,
    };

    // Pre-import the signing key (async)
    this.keyReady = this.importKey();
    this.timer = setInterval(() => this.flush(), this.config.flushIntervalMs);
  }

  /** Import the HMAC key using Web Crypto API. */
  private async importKey(): Promise<void> {
    const secret = this.config.projectKey || this.config.secret || "";
    const encoder = new TextEncoder();
    this.signingKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
  }

  /**
   * Install global error handlers for uncaught exceptions and unhandled rejections.
   * Detects runtime (Node.js vs browser) and installs appropriate handlers.
   * Uses addEventListener (not assignment) to avoid clobbering existing handlers.
   */
  installGlobalHandlers(): void {
    if (this.globalHandlersInstalled) return;
    this.globalHandlersInstalled = true;

    const isNode =
      typeof globalThis !== "undefined" &&
      typeof (globalThis as any).process?.on === "function";

    if (isNode) {
      const proc = (globalThis as any).process;
      proc.on("uncaughtException", (error: Error) => {
        this.captureError(error, {
          metadata: { unhandled: true, mechanism: "uncaughtException" },
        });
        this.flush();
      });
      proc.on("unhandledRejection", (reason: unknown) => {
        const error =
          reason instanceof Error ? reason : new Error(String(reason));
        this.captureError(error, {
          metadata: { unhandled: true, mechanism: "unhandledRejection" },
        });
      });
    } else if (typeof globalThis !== "undefined" && typeof (globalThis as any).addEventListener === "function") {
      (globalThis as any).addEventListener("error", (event: any) => {
        const error = event.error instanceof Error ? event.error : new Error(event.message || "Unknown error");
        this.captureError(error, {
          metadata: { unhandled: true, mechanism: "onerror" },
        });
      });
      (globalThis as any).addEventListener("unhandledrejection", (event: any) => {
        const error =
          event.reason instanceof Error
            ? event.reason
            : new Error(String(event.reason));
        this.captureError(error, {
          metadata: { unhandled: true, mechanism: "onunhandledrejection" },
        });
      });
    }
  }

  /** Capture an Error object. */
  captureError(error: Error, context?: Partial<ErrorEvent>): void {
    this.capture({
      errorType: error.constructor.name,
      message: error.message,
      stack: error.stack,
      ...context,
    });
  }

  /** Capture a structured error event. */
  capture(event: ErrorEvent): void {
    const ingestEvent: IngestEvent = {
      timestamp: Date.now(),
      source: this.config.source!,
      environment: this.config.environment,
      release: this.config.release,
      error_type: event.errorType,
      message: event.message,
    };

    if (event.route) ingestEvent.route_or_procedure = event.route;
    if (event.stack) ingestEvent.stack = event.stack.slice(0, 8192);
    if (event.httpStatus) ingestEvent.http_status = event.httpStatus;
    if (event.requestId) ingestEvent.request_id = event.requestId;
    if (event.userIdHash) ingestEvent.user_id_hash = event.userIdHash;
    if (event.metadata) ingestEvent.metadata = event.metadata;

    this.buffer.push(ingestEvent);

    if (this.buffer.length >= (this.config.maxBufferSize ?? 20)) {
      this.flush();
    }
  }

  /** Flush buffered events to the server. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    // Ensure key is ready
    await this.keyReady;

    const events = this.buffer.splice(0);
    const body = JSON.stringify({ events });
    const signature = await this.sign(body);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Signature": signature,
    };

    // Send project key header if using new auth
    if (this.config.projectKey) {
      headers["X-Project-Key"] = this.config.projectKey;
    }

    try {
      const resp = await fetch(`${this.config.endpoint}/v1/ingest/batch`, {
        method: "POST",
        headers,
        body,
      });

      if (!resp.ok) {
        console.warn(`[bloop] flush failed: ${resp.status}`);
      }
    } catch (err) {
      // Silently fail - error reporting shouldn't break the app
      if (
        typeof globalThis !== "undefined" &&
        (globalThis as any).process?.env?.NODE_ENV !== "production"
      ) {
        console.warn("[bloop] flush error:", err);
      }
    }
  }

  /** Express/Koa error middleware. */
  errorMiddleware() {
    return (err: Error, req: any, _res: any, next: any) => {
      this.captureError(err, {
        route: req?.path || req?.url,
        httpStatus: err instanceof HttpError ? err.statusCode : 500,
        requestId: req?.headers?.["x-request-id"],
      });
      next(err);
    };
  }

  /** Stop the flush timer. Call on process shutdown. */
  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /** Sign a body string using Web Crypto HMAC-SHA256. */
  private async sign(body: string): Promise<string> {
    if (!this.signingKey) {
      await this.keyReady;
    }
    const encoder = new TextEncoder();
    const signature = await crypto.subtle.sign(
      "HMAC",
      this.signingKey!,
      encoder.encode(body)
    );
    return Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}

class HttpError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

// --- Usage ---
// const client = new BloopClient({
//   endpoint: "https://errors.yoursite.com",
//   projectKey: "bloop_abc123...",
//   environment: "production",
//   release: "1.0.0",
// });
//
// // Install global handlers (Node.js or browser)
// client.installGlobalHandlers();
//
// // Capture errors
// client.captureError(new Error("something broke"), { route: "/api/users" });
//
// // Express middleware
// app.use(client.errorMiddleware());
//
// // Graceful shutdown
// process.on("SIGTERM", () => client.close());
