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

// ---- LLM Tracing Types ----

export type SpanType = "generation" | "tool" | "retrieval" | "custom";
export type SpanStatus = "ok" | "error";
export type TraceStatus = "running" | "completed" | "error";

export interface TraceOptions {
  name: string;
  sessionId?: string;
  userId?: string;
  input?: string;
  metadata?: Record<string, unknown>;
  promptName?: string;
  promptVersion?: string;
}

export interface SpanOptions {
  spanType: SpanType;
  name?: string;
  model?: string;
  provider?: string;
  input?: string;
  metadata?: Record<string, unknown>;
}

export interface SpanEndOptions {
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  status: SpanStatus;
  errorMessage?: string;
  output?: string;
  timeToFirstTokenMs?: number;
}

export interface TraceEndOptions {
  status: TraceStatus;
  output?: string;
}

/** Options for the traceGeneration convenience method. */
export interface TraceGenerationOptions {
  name: string;
  model?: string;
  provider?: string;
  input?: string;
  sessionId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

// ---- Span Class ----

export class Span {
  id: string;
  parentSpanId: string | null;
  spanType: SpanType;
  name: string;
  model?: string;
  provider?: string;
  startedAt: number;
  input?: string;
  metadata?: Record<string, unknown>;

  // Set on end()
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  latencyMs?: number;
  timeToFirstTokenMs?: number;
  status?: SpanStatus;
  errorMessage?: string;
  output?: string;

  constructor(opts: SpanOptions & { parentSpanId?: string | null }) {
    this.id = crypto.randomUUID();
    this.parentSpanId = opts.parentSpanId ?? null;
    this.spanType = opts.spanType;
    this.name = opts.name ?? opts.spanType;
    this.model = opts.model;
    this.provider = opts.provider;
    this.startedAt = Date.now();
    this.input = opts.input;
    this.metadata = opts.metadata;
  }

  /** End this span and record metrics. */
  end(opts: SpanEndOptions): void {
    this.latencyMs = Date.now() - this.startedAt;
    this.status = opts.status;
    this.inputTokens = opts.inputTokens;
    this.outputTokens = opts.outputTokens;
    this.cost = opts.cost;
    this.errorMessage = opts.errorMessage;
    this.output = opts.output;
    this.timeToFirstTokenMs = opts.timeToFirstTokenMs;
  }

  /** Serialize to server-expected format with snake_case keys. */
  toJSON(): object {
    return {
      id: this.id,
      parent_span_id: this.parentSpanId,
      span_type: this.spanType,
      name: this.name,
      model: this.model ?? null,
      provider: this.provider ?? null,
      input: this.input ?? null,
      output: this.output ?? null,
      metadata: this.metadata ?? null,
      started_at: this.startedAt,
      input_tokens: this.inputTokens ?? null,
      output_tokens: this.outputTokens ?? null,
      cost: this.cost ?? null,
      latency_ms: this.latencyMs ?? null,
      time_to_first_token_ms: this.timeToFirstTokenMs ?? null,
      status: this.status ?? null,
      error_message: this.errorMessage ?? null,
    };
  }
}

// ---- Trace Class ----

/** Internal payload shape for serialized traces. */
interface TracePayload {
  id: string;
  session_id: string | null;
  user_id: string | null;
  name: string;
  status: TraceStatus;
  input: string | null;
  output: string | null;
  metadata: Record<string, unknown> | null;
  prompt_name: string | null;
  prompt_version: string | null;
  started_at: number;
  ended_at: number | null;
  spans: object[];
}

export class Trace {
  id: string;
  name: string;
  sessionId?: string;
  userId?: string;
  status: TraceStatus = "running";
  input?: string;
  output?: string;
  metadata?: Record<string, unknown>;
  promptName?: string;
  promptVersion?: string;
  startedAt: number;
  endedAt?: number;
  spans: Span[] = [];
  private _client: BloopClient;

  constructor(opts: TraceOptions, client: BloopClient) {
    this.id = crypto.randomUUID();
    this.name = opts.name;
    this.sessionId = opts.sessionId;
    this.userId = opts.userId;
    this.input = opts.input;
    this.metadata = opts.metadata;
    this.promptName = opts.promptName;
    this.promptVersion = opts.promptVersion;
    this.startedAt = Date.now();
    this._client = client;
  }

  /** Create a new span within this trace. */
  startSpan(opts: SpanOptions): Span {
    const span = new Span({
      ...opts,
      parentSpanId: null,
    });
    this.spans.push(span);
    return span;
  }

  /** End this trace and push it to the client's trace buffer. */
  end(opts: TraceEndOptions): void {
    this.endedAt = Date.now();
    this.status = opts.status;
    if (opts.output !== undefined) {
      this.output = opts.output;
    }
    this._client["_pushTrace"](this._toPayload());
  }

  /** Serialize to server-expected format. */
  private _toPayload(): TracePayload {
    return {
      id: this.id,
      session_id: this.sessionId ?? null,
      user_id: this.userId ?? null,
      name: this.name,
      status: this.status,
      input: this.input ?? null,
      output: this.output ?? null,
      metadata: this.metadata ?? null,
      prompt_name: this.promptName ?? null,
      prompt_version: this.promptVersion ?? null,
      started_at: this.startedAt,
      ended_at: this.endedAt ?? null,
      spans: this.spans.map((s) => s.toJSON()),
    };
  }
}

// ---- Auto-Instrumentation: Provider Detection ----

const PROVIDER_MAP: Record<string, string> = {
  "api.openai.com": "openai",
  "api.anthropic.com": "anthropic",
  "api.minimax.io": "minimax",
  "api.minimaxi.com": "minimax",
  "api.moonshot.ai": "kimi",
  "generativelanguage.googleapis.com": "google",
};

function detectProvider(client: any): string {
  try {
    const baseURL = client?.baseURL || client?._options?.baseURL || "";
    const hostname = new URL(baseURL).hostname;
    return PROVIDER_MAP[hostname] || hostname;
  } catch {
    return "unknown";
  }
}

// ---- Auto-Instrumentation: Model Pricing ----

export const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  // OpenAI (per token in dollars)
  "gpt-4o": { input: 2.50 / 1_000_000, output: 10.00 / 1_000_000 },
  "gpt-4o-mini": { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
  "gpt-4-turbo": { input: 10.00 / 1_000_000, output: 30.00 / 1_000_000 },
  // Anthropic
  "claude-sonnet-4-5-20250929": { input: 3.00 / 1_000_000, output: 15.00 / 1_000_000 },
  "claude-haiku-4-5-20251001": { input: 0.80 / 1_000_000, output: 4.00 / 1_000_000 },
  // Minimax
  "MiniMax-M1": { input: 0.40 / 1_000_000, output: 2.20 / 1_000_000 },
  "MiniMax-Text-01": { input: 0.20 / 1_000_000, output: 1.10 / 1_000_000 },
  // Kimi
  "kimi-k2": { input: 0.60 / 1_000_000, output: 2.50 / 1_000_000 },
  "moonshot-v1-8k": { input: 0.20 / 1_000_000, output: 2.00 / 1_000_000 },
};

// ---- BloopClient ----

export class BloopClient {
  private config: Required<
    Pick<BloopConfig, "endpoint" | "source" | "environment" | "release">
  > &
    BloopConfig;
  private buffer: IngestEvent[] = [];
  private traceBuffer: TracePayload[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private signingKey: CryptoKey | null = null;
  private keyReady: Promise<void>;
  private globalHandlersInstalled = false;
  private _modelCosts: Record<string, { input: number; output: number }> = {};

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

  // ---- LLM Tracing ----

  /** Start a new trace. Returns a Trace object for adding spans. */
  startTrace(opts: TraceOptions): Trace {
    return new Trace(opts, this);
  }

  /**
   * Convenience method: creates a trace with a single generation span,
   * calls the provided function, and ends both span and trace.
   * Returns the value returned by the callback.
   */
  async traceGeneration<T>(
    opts: TraceGenerationOptions,
    fn: (span: Span) => Promise<T>
  ): Promise<T> {
    const trace = this.startTrace({
      name: opts.name,
      sessionId: opts.sessionId,
      userId: opts.userId,
      input: opts.input,
      metadata: opts.metadata,
    });

    const span = trace.startSpan({
      spanType: "generation",
      name: opts.name,
      model: opts.model,
      provider: opts.provider,
      input: opts.input,
    });

    try {
      const result = await fn(span);
      trace.end({ status: "completed", output: span.output });
      return result;
    } catch (err) {
      if (!span.status) {
        span.end({
          status: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
      trace.end({ status: "error" });
      throw err;
    }
  }

  // ---- Auto-Instrumentation ----

  /** Set custom cost rates for a model (per-token in dollars). */
  setModelCosts(model: string, costs: { input: number; output: number }): void {
    this._modelCosts[model] = costs;
  }

  /** Wrap an OpenAI-compatible client instance to automatically trace all LLM calls. */
  wrapOpenAI<T extends object>(client: T): T {
    const bloop = this;
    const provider = detectProvider(client);

    return new Proxy(client, {
      get(target, prop, receiver) {
        const val = Reflect.get(target, prop, receiver);
        if (prop === "chat") {
          return new Proxy(val as object, {
            get(chatTarget: any, chatProp: string | symbol, chatReceiver: any) {
              const chatVal = Reflect.get(chatTarget, chatProp, chatReceiver);
              if (chatProp === "completions") {
                return new Proxy(chatVal as object, {
                  get(compTarget: any, compProp: string | symbol, compReceiver: any) {
                    const compVal = Reflect.get(compTarget, compProp, compReceiver);
                    if (compProp === "create" && typeof compVal === "function") {
                      return async function (...args: any[]) {
                        return bloop._traceOpenAICall(
                          provider,
                          "chat.completions.create",
                          compVal.bind(compTarget),
                          args,
                        );
                      };
                    }
                    return compVal;
                  },
                });
              }
              return chatVal;
            },
          });
        }
        if (prop === "embeddings") {
          return new Proxy(val as object, {
            get(embTarget: any, embProp: string | symbol, embReceiver: any) {
              const embVal = Reflect.get(embTarget, embProp, embReceiver);
              if (embProp === "create" && typeof embVal === "function") {
                return async function (...args: any[]) {
                  return bloop._traceOpenAICall(
                    provider,
                    "embeddings.create",
                    embVal.bind(embTarget),
                    args,
                  );
                };
              }
              return embVal;
            },
          });
        }
        return val;
      },
    }) as T;
  }

  /** Wrap an Anthropic client instance to automatically trace all messages.create calls. */
  wrapAnthropic<T extends object>(client: T): T {
    const bloop = this;

    return new Proxy(client, {
      get(target, prop, receiver) {
        const val = Reflect.get(target, prop, receiver);
        if (prop === "messages") {
          return new Proxy(val as object, {
            get(msgTarget: any, msgProp: string | symbol, msgReceiver: any) {
              const msgVal = Reflect.get(msgTarget, msgProp, msgReceiver);
              if (msgProp === "create" && typeof msgVal === "function") {
                return async function (...args: any[]) {
                  return bloop._traceAnthropicCall(msgVal.bind(msgTarget), args);
                };
              }
              return msgVal;
            },
          });
        }
        return val;
      },
    }) as T;
  }

  /** Internal: trace an OpenAI-style API call. */
  private async _traceOpenAICall(
    provider: string,
    method: string,
    fn: Function,
    args: any[],
  ): Promise<any> {
    const params = args[0] || {};
    const model = params.model || "unknown";
    const traceName = `${provider}.${method}`;

    const trace = this.startTrace({ name: traceName });
    const span = trace.startSpan({
      spanType: "generation",
      name: traceName,
      model,
      provider,
      input: params.messages
        ? JSON.stringify(params.messages.slice(-1))
        : undefined,
    });

    try {
      const response = await fn(...args);

      // Extract usage from response
      const usage = response?.usage;
      const inputTokens = usage?.prompt_tokens || 0;
      const outputTokens = usage?.completion_tokens || 0;

      // Compute cost
      const rates = this._modelCosts[model] || MODEL_COSTS[model];
      let cost = 0;
      if (rates) {
        cost = inputTokens * rates.input + outputTokens * rates.output;
      }

      // Extract output
      const output = response?.choices?.[0]?.message?.content;

      span.end({ inputTokens, outputTokens, cost, status: "ok", output });
      trace.end({ status: "completed", output });

      return response;
    } catch (err: any) {
      span.end({
        status: "error",
        errorMessage: err?.message || String(err),
      });
      trace.end({ status: "error" });
      throw err;
    }
  }

  /** Internal: trace an Anthropic messages.create call. */
  private async _traceAnthropicCall(fn: Function, args: any[]): Promise<any> {
    const params = args[0] || {};
    const model = params.model || "unknown";

    const trace = this.startTrace({ name: "anthropic.messages.create" });
    const span = trace.startSpan({
      spanType: "generation",
      name: "anthropic.messages.create",
      model,
      provider: "anthropic",
    });

    try {
      const response = await fn(...args);

      const inputTokens = response?.usage?.input_tokens || 0;
      const outputTokens = response?.usage?.output_tokens || 0;

      const rates = this._modelCosts[model] || MODEL_COSTS[model];
      let cost = 0;
      if (rates) {
        cost = inputTokens * rates.input + outputTokens * rates.output;
      }

      const output = response?.content?.[0]?.text;

      span.end({ inputTokens, outputTokens, cost, status: "ok", output });
      trace.end({ status: "completed", output });

      return response;
    } catch (err: any) {
      span.end({
        status: "error",
        errorMessage: err?.message || String(err),
      });
      trace.end({ status: "error" });
      throw err;
    }
  }

  /** Push a completed trace payload to the buffer. Called by Trace.end(). */
  private _pushTrace(payload: TracePayload): void {
    this.traceBuffer.push(payload);
  }

  /** Flush buffered events to the server. */
  async flush(): Promise<void> {
    const flushErrors = this._flushErrors();
    const flushTraces = this._flushTraces();
    await Promise.all([flushErrors, flushTraces]);
  }

  /** Flush error events to the ingest endpoint. */
  private async _flushErrors(): Promise<void> {
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

  /** Flush trace payloads to the traces endpoint. */
  private async _flushTraces(): Promise<void> {
    if (this.traceBuffer.length === 0) return;

    // Ensure key is ready
    await this.keyReady;

    const traces = this.traceBuffer.splice(0);
    const body = JSON.stringify({ traces });
    const signature = await this.sign(body);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Signature": signature,
    };

    if (this.config.projectKey) {
      headers["X-Project-Key"] = this.config.projectKey;
    }

    try {
      const resp = await fetch(`${this.config.endpoint}/v1/traces/batch`, {
        method: "POST",
        headers,
        body,
      });

      if (!resp.ok) {
        console.warn(`[bloop] trace flush failed: ${resp.status}`);
      }
    } catch (err) {
      if (
        typeof globalThis !== "undefined" &&
        (globalThis as any).process?.env?.NODE_ENV !== "production"
      ) {
        console.warn("[bloop] trace flush error:", err);
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
// // LLM Tracing
// const trace = client.startTrace({ name: "chat-completion", input: "Hello" });
// const span = trace.startSpan({ spanType: "generation", model: "gpt-4o", provider: "openai" });
// // ... call LLM ...
// span.end({ inputTokens: 100, outputTokens: 50, cost: 0.0025, status: "ok", output: "Hi!" });
// trace.end({ status: "completed", output: "Hi!" });
//
// // Convenience: traceGeneration
// const result = await client.traceGeneration(
//   { name: "quick-gen", model: "gpt-4o", provider: "openai", input: "Hello" },
//   async (span) => {
//     const response = "Hi!"; // call LLM here
//     span.end({ inputTokens: 10, outputTokens: 5, cost: 0.001, status: "ok", output: response });
//     return response;
//   }
// );
//
// // Express middleware
// app.use(client.errorMiddleware());
//
// // Graceful shutdown
// process.on("SIGTERM", () => client.close());
