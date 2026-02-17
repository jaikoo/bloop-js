/**
 * Anthropic auto-instrumentation for bloop LLM tracing.
 *
 * Wraps `messages.create()` to automatically capture:
 * - Model, tokens, latency, TTFT (streaming), errors
 * - Cost is always 0 -- calculated server-side from pricing table
 */

import type { BloopClient } from "../client";

function detectProvider(client: any): string {
  try {
    const baseUrl = String(client.baseURL || client._baseURL || "");
    if (baseUrl.includes("anthropic.com")) return "anthropic";
    const url = new URL(baseUrl);
    return url.hostname.split(".")[0] || "anthropic";
  } catch {
    return "anthropic";
  }
}

export function wrapAnthropic<T>(
  anthropicClient: T,
  bloopClient: BloopClient,
): T {
  const client = anthropicClient as any;
  const provider = detectProvider(client);
  const originalCreate = client.messages.create.bind(client.messages);

  client.messages.create = function tracedCreate(...args: any[]): any {
    const params = args[0] || {};
    const model: string = params.model || "unknown";
    const stream: boolean = params.stream || false;
    const startMs = Date.now();

    const trace = bloopClient.trace({ name: `${provider}/${model}` });
    const span = trace.span({
      spanType: "generation",
      name: "messages.create",
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
            usage.input_tokens || 0,
            usage.output_tokens || 0,
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

  return anthropicClient;
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

    for await (const event of stream) {
      const eventType = event?.type || "";

      if (!firstTokenSeen && eventType === "content_block_delta") {
        firstTokenSeen = true;
        span.timeToFirstTokenMs = Date.now() - startMs;
      }

      // Track usage from message_start event
      if (eventType === "message_start" && event.message) {
        resolvedModel = event.message.model || resolvedModel;
        if (event.message.usage) {
          inputTokens = event.message.usage.input_tokens || 0;
        }
      }

      // Track output tokens from message_delta event
      if (eventType === "message_delta" && event.usage) {
        outputTokens = event.usage.output_tokens || 0;
      }

      yield event;
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
