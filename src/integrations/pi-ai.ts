/**
 * pi-ai (@mariozechner/pi-ai) auto-instrumentation for bloop LLM tracing.
 *
 * Wraps `complete()` and `stream()` to automatically capture:
 * - Model, provider, tokens, latency, TTFT (streaming), errors
 * - Cost is always 0 -- calculated server-side from pricing table
 *
 * Works with all pi-ai providers: OpenAI, Anthropic, Google, Mistral,
 * OpenRouter, Groq, xAI, Cerebras, Azure, Bedrock, and any
 * OpenAI-compatible endpoint.
 */

import type { BloopClient } from "../client";

/**
 * Wrap pi-ai's `complete()` function for automatic tracing.
 *
 * Usage:
 *   import { complete, getModel } from "@mariozechner/pi-ai";
 *   const tracedComplete = bloop.wrapPiAiComplete(complete);
 *   const model = getModel("openai", "gpt-4o");
 *   const response = await tracedComplete(model, context);
 */
export function wrapPiAiComplete(
  completeFn: Function,
  bloopClient: BloopClient,
): Function {
  return async function tracedComplete(model: any, context: any, options?: any) {
    const modelName: string = model?.name || model?.id || "unknown";
    const provider: string = model?.provider || "unknown";
    const startMs = Date.now();

    const trace = bloopClient.trace({ name: `${provider}/${modelName}` });
    const span = trace.span({
      spanType: "generation",
      name: "complete",
      model: modelName,
      provider,
    });

    try {
      const response = await completeFn(model, context, options);
      const endMs = Date.now();

      // pi-ai AssistantMessage has usage.input, usage.output, usage.totalTokens
      const usage = response?.usage;
      if (usage) {
        span.setTokens(
          usage.input || 0,
          usage.output || 0,
        );
      }

      span.setLatency(endMs - startMs);
      span.cost = 0; // Server-side pricing
      span.end();
      trace.end();
      return response;
    } catch (err: any) {
      const endMs = Date.now();
      span.setLatency(endMs - startMs);
      span.setError(err.message);
      span.end();
      trace.status = "error";
      trace.end();
      throw err;
    }
  };
}

/**
 * Wrap pi-ai's `stream()` function for automatic tracing.
 *
 * Usage:
 *   import { stream, getModel } from "@mariozechner/pi-ai";
 *   const tracedStream = bloop.wrapPiAiStream(stream);
 *   const model = getModel("openai", "gpt-4o");
 *   const eventStream = tracedStream(model, context);
 *   for await (const event of eventStream) { ... }
 *   const result = await eventStream.result();
 */
export function wrapPiAiStream(
  streamFn: Function,
  bloopClient: BloopClient,
): Function {
  return function tracedStream(model: any, context: any, options?: any) {
    const modelName: string = model?.name || model?.id || "unknown";
    const provider: string = model?.provider || "unknown";
    const startMs = Date.now();

    const trace = bloopClient.trace({ name: `${provider}/${modelName}` });
    const span = trace.span({
      spanType: "generation",
      name: "stream",
      model: modelName,
      provider,
    });

    const originalStream = streamFn(model, context, options);
    let firstTokenSeen = false;

    // Wrap the async iterable to intercept events
    const wrappedStream = {
      [Symbol.asyncIterator]: async function* () {
        try {
          for await (const event of originalStream) {
            if (!firstTokenSeen && (event?.type === "text" || event?.type === "thinking")) {
              firstTokenSeen = true;
              span.timeToFirstTokenMs = Date.now() - startMs;
            }
            yield event;
          }
        } catch (err: any) {
          const endMs = Date.now();
          span.setLatency(endMs - startMs);
          span.setError(err.message);
          span.end();
          trace.status = "error";
          trace.end();
          throw err;
        }
      },

      // Preserve the result() method that returns the final AssistantMessage
      result: async () => {
        const message = await originalStream.result();
        const endMs = Date.now();

        const usage = message?.usage;
        if (usage) {
          span.setTokens(usage.input || 0, usage.output || 0);
        }

        // Set latency directly to avoid overwriting TTFT set during iteration
        span.latencyMs = endMs - startMs;
        span.cost = 0;
        span.end();
        trace.end();
        return message;
      },
    };

    return wrappedStream;
  };
}
