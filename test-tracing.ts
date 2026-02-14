/**
 * Type-level tests for LLM tracing support.
 * This file exercises all new types and APIs.
 * `npx tsc --noEmit` must pass for these tests to be "green."
 */

import {
  BloopClient,
  BloopConfig,
  // New tracing types
  SpanType,
  SpanStatus,
  TraceStatus,
  TraceOptions,
  SpanOptions,
  SpanEndOptions,
  TraceEndOptions,
  Span,
  Trace,
} from "./bloop.js";

// ---- Test: Types exist and are correct ----

const spanType: SpanType = "generation";
const spanType2: SpanType = "tool";
const spanType3: SpanType = "retrieval";
const spanType4: SpanType = "custom";

const spanStatus: SpanStatus = "ok";
const spanStatus2: SpanStatus = "error";

const traceStatus: TraceStatus = "running";
const traceStatus2: TraceStatus = "completed";
const traceStatus3: TraceStatus = "error";

// ---- Test: TraceOptions interface ----

const traceOpts: TraceOptions = {
  name: "chat-completion",
  sessionId: "sess-123",
  userId: "user-456",
  input: "Hello, world!",
  metadata: { key: "value" },
  promptName: "my-prompt",
  promptVersion: "1.0",
};

// Minimal TraceOptions (only name required)
const traceOptsMinimal: TraceOptions = {
  name: "minimal-trace",
};

// ---- Test: SpanOptions interface ----

const spanOpts: SpanOptions = {
  spanType: "generation",
  name: "gpt-4o call",
  model: "gpt-4o",
  provider: "openai",
  input: "prompt text",
  metadata: { temperature: 0.7 },
};

// Minimal SpanOptions (only spanType required)
const spanOptsMinimal: SpanOptions = {
  spanType: "tool",
};

// ---- Test: SpanEndOptions interface ----

const spanEndOpts: SpanEndOptions = {
  inputTokens: 100,
  outputTokens: 50,
  cost: 0.0025,
  status: "ok",
  errorMessage: undefined,
  output: "Generated text",
  timeToFirstTokenMs: 300,
};

// Minimal SpanEndOptions (only status required)
const spanEndOptsMinimal: SpanEndOptions = {
  status: "error",
  errorMessage: "Something went wrong",
};

// ---- Test: TraceEndOptions interface ----

const traceEndOpts: TraceEndOptions = {
  status: "completed",
  output: "Final response text",
};

const traceEndOptsMinimal: TraceEndOptions = {
  status: "error",
};

// ---- Test: BloopClient.startTrace() returns a Trace ----

const client = new BloopClient({
  endpoint: "https://errors.test.com",
  projectKey: "test-key",
  environment: "test",
  release: "1.0.0",
});

const trace: Trace = client.startTrace({
  name: "chat-completion",
  sessionId: "sess-123",
  userId: "user-456",
  input: "What is the weather?",
  metadata: { source: "api" },
  promptName: "weather-prompt",
  promptVersion: "2.1",
});

// ---- Test: Trace properties ----

const traceId: string = trace.id;
const traceName: string = trace.name;
const traceSessionId: string | undefined = trace.sessionId;
const traceUserId: string | undefined = trace.userId;
const traceStatusProp: TraceStatus = trace.status;
const traceInput: string | undefined = trace.input;
const traceOutput: string | undefined = trace.output;
const traceMetadata: Record<string, unknown> | undefined = trace.metadata;
const tracePromptName: string | undefined = trace.promptName;
const tracePromptVersion: string | undefined = trace.promptVersion;
const traceStartedAt: number = trace.startedAt;
const traceEndedAt: number | undefined = trace.endedAt;
const traceSpans: Span[] = trace.spans;

// ---- Test: Trace.startSpan() returns a Span ----

const span: Span = trace.startSpan({
  spanType: "generation",
  name: "gpt-4o call",
  model: "gpt-4o",
  provider: "openai",
  input: "prompt",
  metadata: { key: "val" },
});

// ---- Test: Span properties ----

const spanId: string = span.id;
const spanParentId: string | null = span.parentSpanId;
const spanSpanType: SpanType = span.spanType;
const spanName: string = span.name;
const spanModel: string | undefined = span.model;
const spanProvider: string | undefined = span.provider;
const spanStartedAt: number = span.startedAt;
const spanInput: string | undefined = span.input;
const spanMetadata: Record<string, unknown> | undefined = span.metadata;

// ---- Test: Span.end() ----

span.end({
  inputTokens: 100,
  outputTokens: 50,
  cost: 0.0025,
  status: "ok",
  output: "generated response",
  timeToFirstTokenMs: 300,
});

// After end(), these should be set
const spanInputTokens: number | undefined = span.inputTokens;
const spanOutputTokens: number | undefined = span.outputTokens;
const spanCost: number | undefined = span.cost;
const spanLatencyMs: number | undefined = span.latencyMs;
const spanTtft: number | undefined = span.timeToFirstTokenMs;
const spanStatusProp: SpanStatus | undefined = span.status;
const spanErrorMessage: string | undefined = span.errorMessage;
const spanOutput: string | undefined = span.output;

// ---- Test: Span.toJSON() returns object ----

const spanJson: object = span.toJSON();

// ---- Test: Trace.end() ----

trace.end({
  status: "completed",
  output: "Final answer about weather",
});

// ---- Test: traceGeneration convenience method ----

async function testTraceGeneration() {
  const result = await client.traceGeneration(
    {
      name: "simple-generation",
      model: "gpt-4o",
      provider: "openai",
      input: "Hello",
    },
    async (span: Span) => {
      // Do LLM call
      span.end({
        inputTokens: 10,
        outputTokens: 5,
        cost: 0.001,
        status: "ok",
        output: "Hi!",
      });
      return "Hi!";
    }
  );

  // result should be the return value of the callback
  const output: string = result;
}

// ---- Test: TraceGenerationOptions has correct shape ----

async function testTraceGenerationMinimal() {
  const result = await client.traceGeneration(
    {
      name: "minimal-gen",
      input: "test",
    },
    async (span: Span) => {
      span.end({ status: "ok" });
      return 42;
    }
  );

  const num: number = result;
}

// ---- Test: flush() still works (backward compat) ----

async function testFlush() {
  await client.flush();
}

// ---- Test: close() still works (backward compat) ----

async function testClose() {
  await client.close();
}

// ---- Test: Error tracking still works (backward compat) ----

function testErrorTracking() {
  client.captureError(new Error("test error"), { route: "/api/test" });
  client.capture({
    errorType: "TestError",
    message: "test message",
  });
}
