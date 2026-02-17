/**
 * OpenAI auto-instrumentation for bloop LLM tracing.
 *
 * Wraps `chat.completions.create()` to automatically capture:
 * - Model, tokens, latency, TTFT (streaming), errors
 * - Cost is always 0 -- calculated server-side from pricing table
 */

import type { BloopClient } from "../client";

const PROVIDER_MAP: Record<string, string> = {
  "api.openai.com": "openai",
  "api.minimax.io": "minimax",
  "api.moonshot.ai": "kimi",
  "generativelanguage.googleapis.com": "google",
};

function detectProvider(client: any): string {
  try {
    const baseUrl = String(client.baseURL || "");
    for (const [domain, provider] of Object.entries(PROVIDER_MAP)) {
      if (baseUrl.includes(domain)) return provider;
    }
    const url = new URL(baseUrl);
    return url.hostname.split(".")[0] || "openai";
  } catch {
    return "openai";
  }
}

export function wrapOpenAI<T>(openaiClient: T, bloopClient: BloopClient): T {
  const client = openaiClient as any;
  const provider = detectProvider(client);
  const originalCreate = client.chat.completions.create.bind(
    client.chat.completions,
  );

  client.chat.completions.create = function tracedCreate(
    ...args: any[]
  ): any {
    const params = args[0] || {};
    const model: string = params.model || "unknown";
    const stream: boolean = params.stream || false;
    const startMs = Date.now();

    const trace = bloopClient.trace({ name: `${provider}/${model}` });
    const span = trace.span({
      spanType: "generation",
      name: "chat.completions.create",
      model,
      provider,
    });

    if (stream) {
      return handleStreaming(originalCreate, args, trace, span, startMs, model);
    }

    return originalCreate(...args).then(
      (response: any) => {
        const endMs = Date.now();

        const usage = response?.usage;
        if (usage) {
          span.setTokens(
            usage.prompt_tokens || 0,
            usage.completion_tokens || 0,
          );
        }

        span.setLatency(endMs - startMs);
        span.cost = 0; // Server-side pricing
        span.model = response?.model || model;
        span.end();
        trace.end();
        return response;
      },
      (err: Error) => {
        const endMs = Date.now();
        span.setLatency(endMs - startMs);
        span.setError(err.message);
        span.end();
        trace.status = "error";
        trace.end();
        throw err;
      },
    );
  };

  return openaiClient;
}

async function* handleStreaming(
  originalCreate: Function,
  args: any[],
  trace: ReturnType<BloopClient["trace"]>,
  span: ReturnType<ReturnType<BloopClient["trace"]>["span"]>,
  startMs: number,
  model: string,
): AsyncGenerator<any> {
  let firstTokenSeen = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let resolvedModel = model;

  try {
    const stream = await originalCreate(...args);

    for await (const chunk of stream) {
      if (!firstTokenSeen) {
        firstTokenSeen = true;
        span.timeToFirstTokenMs = Date.now() - startMs;
      }

      if (chunk.model) resolvedModel = chunk.model;

      // Track usage from final chunk (OpenAI includes it with stream_options)
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens || 0;
        outputTokens = chunk.usage.completion_tokens || 0;
      }

      yield chunk;
    }

    const endMs = Date.now();
    span.setTokens(inputTokens, outputTokens);
    span.setLatency(endMs - startMs);
    span.cost = 0;
    span.model = resolvedModel;
    span.end();
    trace.end();
  } catch (err: any) {
    const endMs = Date.now();
    span.setTokens(inputTokens, outputTokens);
    span.setLatency(endMs - startMs);
    span.setError(err.message);
    span.end();
    trace.status = "error";
    trace.end();
    throw err;
  }
}
