/**
 * Bloop error reporting and LLM tracing client for TypeScript/Node.js.
 * Zero external dependencies.
 */

import { createHmac, randomUUID } from "node:crypto";

export interface BloopClientOptions {
  endpoint: string;
  projectKey: string;
  flushInterval?: number; // ms, default 5000
  maxBufferSize?: number; // default 100
  environment?: string;
  release?: string;
}

export interface SpanData {
  id: string;
  span_type: string;
  name: string;
  model?: string;
  provider?: string;
  parent_span_id?: string;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  latency_ms: number;
  time_to_first_token_ms?: number;
  status: string;
  error_message?: string;
  input?: string;
  output?: string;
  metadata?: Record<string, unknown>;
  started_at: number;
  ended_at?: number;
}

export interface TraceData {
  id: string;
  name: string;
  status: string;
  session_id?: string;
  user_id?: string;
  input?: string;
  output?: string;
  metadata?: Record<string, unknown>;
  prompt_name?: string;
  prompt_version?: string;
  started_at: number;
  ended_at?: number;
  spans: SpanData[];
}

export class BloopClient {
  private endpoint: string;
  private projectKey: string;
  private flushInterval: number;
  private maxBufferSize: number;
  private environment: string;
  private release: string;

  private errorBuffer: Record<string, unknown>[] = [];
  private traceBuffer: TraceData[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(options: BloopClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.projectKey = options.projectKey;
    this.flushInterval = options.flushInterval ?? 5000;
    this.maxBufferSize = options.maxBufferSize ?? 100;
    this.environment = options.environment ?? "production";
    this.release = options.release ?? "";

    this.timer = setInterval(() => this.flush(), this.flushInterval);
    if (this.timer.unref) this.timer.unref();
  }

  // ── Error Tracking ──

  capture(params: {
    errorType: string;
    message: string;
    source?: string;
    stack?: string;
    routeOrProcedure?: string;
    screen?: string;
    metadata?: Record<string, unknown>;
  }): void {
    this.errorBuffer.push({
      timestamp: Math.floor(Date.now() / 1000),
      source: params.source ?? "javascript",
      environment: this.environment,
      release: this.release,
      error_type: params.errorType,
      message: params.message,
      stack: params.stack ?? "",
      route_or_procedure: params.routeOrProcedure ?? "",
      screen: params.screen ?? "",
      metadata: params.metadata ?? {},
    });
    if (this.errorBuffer.length >= this.maxBufferSize) {
      this.flush();
    }
  }

  // ── LLM Tracing ──

  trace(options: {
    name?: string;
    traceId?: string;
    sessionId?: string;
    userId?: string;
    promptName?: string;
    promptVersion?: string;
  } = {}): Trace {
    return new Trace(this, {
      name: options.name ?? "",
      traceId: options.traceId ?? randomUUID().replace(/-/g, ""),
      sessionId: options.sessionId,
      userId: options.userId,
      promptName: options.promptName,
      promptVersion: options.promptVersion,
    });
  }

  /** @internal */
  _sendTrace(data: TraceData): void {
    this.traceBuffer.push(data);
    if (this.traceBuffer.length >= 10) {
      this._flushTraces();
    }
  }

  // ── Auto-Instrumentation ──

  wrapOpenAI<T>(openaiClient: T): T {
    const { wrapOpenAI } = require("./integrations/openai");
    return wrapOpenAI(openaiClient, this);
  }

  wrapAnthropic<T>(anthropicClient: T): T {
    const { wrapAnthropic } = require("./integrations/anthropic");
    return wrapAnthropic(anthropicClient, this);
  }

  wrapPiAiComplete(completeFn: Function): Function {
    const { wrapPiAiComplete } = require("./integrations/pi-ai");
    return wrapPiAiComplete(completeFn, this);
  }

  wrapPiAiStream(streamFn: Function): Function {
    const { wrapPiAiStream } = require("./integrations/pi-ai");
    return wrapPiAiStream(streamFn, this);
  }

  // ── Flush & Transport ──

  flush(): void {
    this._flushErrors();
    this._flushTraces();
  }

  close(): void {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  private _flushErrors(): void {
    if (this.errorBuffer.length === 0) return;
    const events = [...this.errorBuffer];
    this.errorBuffer = [];
    if (events.length === 1) {
      this._post("/v1/ingest", events[0]);
    } else {
      this._post("/v1/ingest/batch", { events });
    }
  }

  private _flushTraces(): void {
    if (this.traceBuffer.length === 0) return;
    const traces = [...this.traceBuffer];
    this.traceBuffer = [];
    this._post("/v1/traces/batch", { traces }).catch(() => {});
  }

  private async _post(path: string, payload: unknown): Promise<void> {
    const body = JSON.stringify(payload);
    const sig = createHmac("sha256", this.projectKey)
      .update(body)
      .digest("hex");
    try {
      const resp = await fetch(`${this.endpoint}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature": sig,
          "X-Project-Key": this.projectKey,
        },
        body,
      });
      if (!resp.ok) {
        console.warn(`[bloop] ${path} failed: ${resp.status}`);
      }
    } catch {
      // Silently drop on failure (never crash the app)
    }
  }
}

export class Trace {
  readonly id: string;
  name: string;
  status: string = "completed";
  sessionId?: string;
  userId?: string;
  input?: string;
  output?: string;
  metadata?: Record<string, unknown>;
  promptName?: string;
  promptVersion?: string;

  private client: BloopClient;
  private spans: SpanData[] = [];
  private startedAt: number;
  private endedAt?: number;

  constructor(
    client: BloopClient,
    options: {
      name: string;
      traceId: string;
      sessionId?: string;
      userId?: string;
      promptName?: string;
      promptVersion?: string;
    },
  ) {
    this.client = client;
    this.id = options.traceId;
    this.name = options.name;
    this.sessionId = options.sessionId;
    this.userId = options.userId;
    this.promptName = options.promptName;
    this.promptVersion = options.promptVersion;
    this.startedAt = Date.now();
  }

  span(options: {
    spanType?: string;
    name?: string;
    model?: string;
    provider?: string;
    parentSpanId?: string;
  } = {}): Span {
    return new Span(this, {
      spanType: options.spanType ?? "generation",
      name: options.name ?? "",
      model: options.model,
      provider: options.provider,
      parentSpanId: options.parentSpanId,
    });
  }

  /** @internal */
  _addSpan(data: SpanData): void {
    this.spans.push(data);
  }

  end(): void {
    this.endedAt = Date.now();
    const data: TraceData = {
      id: this.id,
      name: this.name,
      status: this.status,
      started_at: this.startedAt,
      ended_at: this.endedAt,
      spans: this.spans,
    };
    if (this.sessionId) data.session_id = this.sessionId;
    if (this.userId) data.user_id = this.userId;
    if (this.input !== undefined) data.input = this.input;
    if (this.output !== undefined) data.output = this.output;
    if (this.metadata) data.metadata = this.metadata;
    if (this.promptName) data.prompt_name = this.promptName;
    if (this.promptVersion) data.prompt_version = this.promptVersion;

    this.client._sendTrace(data);
  }
}

export class Span {
  readonly id: string;
  spanType: string;
  name: string;
  model?: string;
  provider?: string;
  parentSpanId?: string;
  inputTokens: number = 0;
  outputTokens: number = 0;
  cost: number = 0;
  latencyMs: number = 0;
  timeToFirstTokenMs?: number;
  status: string = "ok";
  errorMessage?: string;
  input?: string;
  output?: string;
  metadata?: Record<string, unknown>;

  private trace: Trace;
  private startedAt: number;

  constructor(
    trace: Trace,
    options: {
      spanType: string;
      name: string;
      model?: string;
      provider?: string;
      parentSpanId?: string;
    },
  ) {
    this.trace = trace;
    this.id = randomUUID().replace(/-/g, "");
    this.spanType = options.spanType;
    this.name = options.name;
    this.model = options.model;
    this.provider = options.provider;
    this.parentSpanId = options.parentSpanId;
    this.startedAt = Date.now();
  }

  setTokens(inputTokens: number, outputTokens: number): void {
    this.inputTokens = inputTokens;
    this.outputTokens = outputTokens;
  }

  setCost(cost: number): void {
    this.cost = cost;
  }

  setLatency(latencyMs: number, timeToFirstTokenMs?: number): void {
    this.latencyMs = latencyMs;
    this.timeToFirstTokenMs = timeToFirstTokenMs;
  }

  setError(message: string): void {
    this.status = "error";
    this.errorMessage = message;
  }

  end(): void {
    const endedAt = Date.now();
    if (this.latencyMs === 0) {
      this.latencyMs = endedAt - this.startedAt;
    }

    const data: SpanData = {
      id: this.id,
      span_type: this.spanType,
      name: this.name,
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      cost: this.cost,
      latency_ms: this.latencyMs,
      status: this.status,
      started_at: this.startedAt,
      ended_at: endedAt,
    };
    if (this.model) data.model = this.model;
    if (this.provider) data.provider = this.provider;
    if (this.parentSpanId) data.parent_span_id = this.parentSpanId;
    if (this.timeToFirstTokenMs !== undefined) data.time_to_first_token_ms = this.timeToFirstTokenMs;
    if (this.errorMessage) data.error_message = this.errorMessage;
    if (this.input !== undefined) data.input = this.input;
    if (this.output !== undefined) data.output = this.output;
    if (this.metadata) data.metadata = this.metadata;

    this.trace._addSpan(data);
  }
}
