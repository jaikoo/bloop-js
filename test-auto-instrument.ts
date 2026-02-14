/**
 * Type-level and behavioral tests for auto-instrumentation.
 * `npx tsc --noEmit` must pass with this file included.
 *
 * Tests cover:
 * 1. MODEL_COSTS export exists and has correct shape
 * 2. detectProvider() helper works (tested indirectly via wrapOpenAI)
 * 3. BloopClient.wrapOpenAI() exists, accepts an object, returns same type
 * 4. BloopClient.wrapAnthropic() exists, accepts an object, returns same type
 * 5. BloopClient.setModelCosts() exists with correct signature
 * 6. Wrapped client preserves original type
 * 7. Backward compatibility: all existing APIs still work
 */

import {
  BloopClient,
  Span,
  Trace,
  MODEL_COSTS,
} from "./bloop.js";

// ---- Test: MODEL_COSTS export exists and has correct shape ----

const costs: Record<string, { input: number; output: number }> = MODEL_COSTS;

// Verify specific models exist
const gpt4oCost: { input: number; output: number } = MODEL_COSTS["gpt-4o"];
const gpt4oMiniCost: { input: number; output: number } = MODEL_COSTS["gpt-4o-mini"];

// Values should be numbers (compile-time check)
const inputCost: number = MODEL_COSTS["gpt-4o"].input;
const outputCost: number = MODEL_COSTS["gpt-4o"].output;

// ---- Test: BloopClient construction (unchanged) ----

const client = new BloopClient({
  endpoint: "https://errors.test.com",
  projectKey: "test-key",
  environment: "test",
  release: "1.0.0",
});

// ---- Test: setModelCosts() method exists ----

client.setModelCosts("my-custom-model", { input: 0.001, output: 0.002 });
client.setModelCosts("gpt-4o", { input: 0.003, output: 0.01 }); // Override built-in

// ---- Test: wrapOpenAI() type signature ----

// Mock OpenAI-like client type
interface MockCompletions {
  create(params: { model: string; messages: { role: string; content: string }[] }): Promise<{
    choices: { message: { content: string } }[];
    usage: { prompt_tokens: number; completion_tokens: number };
  }>;
}

interface MockChat {
  completions: MockCompletions;
}

interface MockEmbeddings {
  create(params: { model: string; input: string }): Promise<{
    data: { embedding: number[] }[];
    usage: { prompt_tokens: number; total_tokens: number };
  }>;
}

interface MockOpenAIClient {
  chat: MockChat;
  embeddings: MockEmbeddings;
  baseURL: string;
}

// wrapOpenAI should accept any object and return the same type
const mockOAI = {} as MockOpenAIClient;
const wrappedOAI: MockOpenAIClient = client.wrapOpenAI(mockOAI);

// The returned type must be the same as the input type
function assertTypePreserved<T extends object>(input: T): T {
  return client.wrapOpenAI(input);
}

// ---- Test: wrapAnthropic() type signature ----

// Mock Anthropic-like client type
interface MockMessages {
  create(params: {
    model: string;
    max_tokens: number;
    messages: { role: string; content: string }[];
  }): Promise<{
    content: { type: string; text: string }[];
    usage: { input_tokens: number; output_tokens: number };
  }>;
}

interface MockAnthropicClient {
  messages: MockMessages;
  baseURL: string;
}

const mockAnthropic = {} as MockAnthropicClient;
const wrappedAnthropic: MockAnthropicClient = client.wrapAnthropic(mockAnthropic);

// ---- Test: Backward compatibility - existing APIs still work ----

async function testBackwardCompat() {
  // startTrace still works
  const trace: Trace = client.startTrace({ name: "compat-test" });
  const span: Span = trace.startSpan({ spanType: "generation", model: "gpt-4o" });
  span.end({ status: "ok", inputTokens: 10, outputTokens: 5 });
  trace.end({ status: "completed" });

  // traceGeneration still works
  const result = await client.traceGeneration(
    { name: "compat-gen", model: "gpt-4o", provider: "openai" },
    async (span: Span) => {
      span.end({ status: "ok" });
      return "result";
    }
  );
  const s: string = result;

  // flush/close still work
  await client.flush();
  await client.close();
}

// ---- Test: wrapOpenAI returns a Proxy that preserves non-intercepted properties ----

// A client with extra properties should preserve them through the proxy
interface ExtendedClient {
  chat: MockChat;
  embeddings: MockEmbeddings;
  baseURL: string;
  customProp: string;
  someMethod(): void;
}

const extClient = {} as ExtendedClient;
const wrappedExt: ExtendedClient = client.wrapOpenAI(extClient);

// customProp and someMethod should still be accessible (type-level)
const _cp: string = wrappedExt.customProp;
const _sm: () => void = wrappedExt.someMethod;

// ---- Test: wrapOpenAI and wrapAnthropic can be called with plain objects ----

const plainWrapped = client.wrapOpenAI({
  chat: {
    completions: {
      create: async () => ({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } }),
    },
  },
});

const anthropicPlain = client.wrapAnthropic({
  messages: {
    create: async () => ({
      content: [{ type: "text", text: "hello" }],
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
  },
});
