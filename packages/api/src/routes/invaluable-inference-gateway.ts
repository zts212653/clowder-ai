/**
 * Invaluable Inference Gateway Route — Bridges Invaluable AgentBrain requests
 * to Clowder's unified model gateway.
 *
 * Topology: transient Fastify route; not a Link-backed identity.
 * Accepts Anthropic-compatible message payloads from local Invaluable peer
 * nodes and proxies them to the configured model adapter (Claude, GPT, etc.)
 * using Clowder's stored API credentials.
 */

import type { FastifyInstance } from 'fastify';
import { createModuleLogger } from '../infrastructure/logger.js';

const log = createModuleLogger('invaluable-inference-gateway');

export interface InvaluableInferenceGatewayOptions {
  /** Resolves the API key for a given model provider (e.g. 'anthropic', 'openai') */
  resolveApiKey: (provider: string) => string | undefined;
  /** Default model to use if none specified in request */
  defaultModel?: string;
  /** Request body size limit in bytes */
  maxBodySize?: number;
  /** Upstream request timeout in milliseconds */
  timeoutMs?: number;
}

interface InferenceRequestBody {
  model?: string;
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
  max_tokens?: number;
  system?: string;
}

export async function invaluableInferenceGateway(
  app: FastifyInstance,
  opts: InvaluableInferenceGatewayOptions,
): Promise<void> {
  const { resolveApiKey, defaultModel = 'claude-3-5-sonnet-20241022', maxBodySize = 1024 * 1024, timeoutMs = 120_000 } = opts;

  // Primary endpoint for Invaluable AgentBrain requests
  app.post<{ Body: InferenceRequestBody }>('/api/invaluable/inference', {
    config: { rawBody: false },
    schema: {
      body: {
        type: 'object',
        required: ['messages'],
        properties: {
          model: { type: 'string' },
          messages: { type: 'array' },
          tools: { type: 'array' },
          max_tokens: { type: 'number' },
          system: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body;
    if (!body || !body.messages || body.messages.length === 0) {
      return reply.status(400).send({ error: 'Request body must contain a non-empty "messages" array.' });
    }

    const bodySize = JSON.stringify(body).length;
    if (bodySize > maxBodySize) {
      return reply.status(413).send({ error: `Payload size ${bodySize} exceeds limit ${maxBodySize}.` });
    }

    const model = body.model || defaultModel;
    const provider = resolveProvider(model);
    const apiKey = resolveApiKey(provider);

    if (!apiKey) {
      return reply.status(401).send({ error: `No API key configured for provider "${provider}".` });
    }

    log.info(`Proxying inference request: model=${model}, provider=${provider}, messages=${body.messages.length}`);

    try {
      const upstream = resolveUpstreamUrl(provider);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(upstream, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(provider === 'anthropic'
            ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
            : { Authorization: `Bearer ${apiKey}` }),
        },
        body: JSON.stringify({
          model,
          messages: body.messages,
          ...(body.tools ? { tools: body.tools } : {}),
          max_tokens: body.max_tokens ?? 4096,
          ...(body.system ? { system: body.system } : {}),
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        return reply
          .status(429)
          .header('Retry-After', retryAfter || '60')
          .send({ error: 'Upstream rate limit exceeded.', retryAfter: retryAfter || '60' });
      }

      if (!response.ok) {
        const errorText = await response.text();
        log.warn(`Upstream error: ${response.status} ${errorText.substring(0, 200)}`);
        return reply.status(response.status).send({ error: `Upstream error: ${response.statusText}`, detail: errorText.substring(0, 500) });
      }

      const result = await response.json();
      return reply.status(200).send(result);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        log.warn(`Inference request timed out after ${timeoutMs}ms`);
        return reply.status(504).send({ error: `Gateway timeout after ${timeoutMs}ms.` });
      }
      log.error(`Inference gateway error: ${err.message}`);
      return reply.status(502).send({ error: `Gateway error: ${err.message}` });
    }
  });

  // Anthropic /v1/messages compatibility endpoint
  app.post<{ Body: InferenceRequestBody }>('/api/invaluable/v1/messages', async (request, reply) => {
    // Rewrite to the primary endpoint internally
    const injectResult = await app.inject({
      method: 'POST',
      url: '/api/invaluable/inference',
      headers: request.headers as Record<string, string>,
      payload: request.body,
    });

    return reply.status(injectResult.statusCode).send(JSON.parse(injectResult.body));
  });
}

function resolveProvider(model: string): string {
  if (model.startsWith('claude') || model.startsWith('anthropic')) return 'anthropic';
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) return 'openai';
  if (model.startsWith('gemini')) return 'google';
  // Default to Anthropic for unknown models
  return 'anthropic';
}

function resolveUpstreamUrl(provider: string): string {
  switch (provider) {
    case 'anthropic': return 'https://api.anthropic.com/v1/messages';
    case 'openai': return 'https://api.openai.com/v1/chat/completions';
    case 'google': return 'https://generativelanguage.googleapis.com/v1beta/models';
    default: return 'https://api.anthropic.com/v1/messages';
  }
}
