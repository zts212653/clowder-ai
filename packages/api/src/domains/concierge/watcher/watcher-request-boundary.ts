import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { WatcherUsage } from '@cat-cafe/shared';
import { estimateTokens } from '../../../utils/token-counter.js';
import { WATCHER_TURN_RESERVE_TOKENS } from './context/watcher-context-budget.js';
import { watcherProviderHttp } from './watcher-provider-http.js';

export interface WatcherRequestObservation {
  request: number;
  inputUpperBound: number;
  maxOutputTokens: number;
  workingContextUpperBound: number;
}

/** Every text Responses continuation crosses this owner, including native retries. Native opaque reasoning is charged separately. */
export async function createWatcherRequestBoundary(
  upstreamBaseUrl: string,
  input: {
    signal: AbortSignal;
    transportEnv?: Readonly<Record<string, string>>;
    observed?(row: WatcherRequestObservation): void | Promise<void>;
    completed?(row: WatcherRequestObservation, usage: WatcherUsage): void | Promise<void>;
  },
) {
  const upstream = new URL(`${upstreamBaseUrl.replace(/\/+$/u, '')}/responses`);
  if (!['https:', 'http:'].includes(upstream.protocol)) throw new Error('watcher_provider_protocol_unsupported');
  const http = watcherProviderHttp(upstream, input.transportEnv ?? {});
  const path = `/watcher-${randomUUID()}`;
  const abort = new AbortController();
  const signal = AbortSignal.any([input.signal, abort.signal]);
  let previousOutputs = 0;
  let requests = 0;
  let maximum = 0;
  let failed: Error | undefined;
  const reject = (message: string): never => {
    failed ??= new Error(message);
    throw failed;
  };
  const server = createServer(async (request, reply) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (
        request.method !== 'POST' ||
        requestUrl.pathname !== `${path}/responses` ||
        request.headers['content-encoding']
      ) {
        reply.writeHead(400).end(JSON.stringify({ error: 'watcher_unbudgeted_provider_request' }));
        return;
      }
      if (failed) throw failed;
      const buffers: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += buffer.length;
        if (length > 400_000) reject('watcher_context_budget_exceeded');
        buffers.push(buffer);
      }
      const body = JSON.parse(Buffer.concat(buffers).toString('utf8')) as Record<string, unknown>;
      if (body.previous_response_id) reject('watcher_hidden_response_chain_not_budgetable');
      // Includes escaped arguments/results, tools, instructions and all native response-chain items.
      // Previous reasoning is charged as well, even when it is represented by an opaque native item.
      const items = Array.isArray(body.input) ? body.input.length : 1;
      const tools = Array.isArray(body.tools) ? body.tools.length : 0;
      const inputUpperBound = estimateTokens(JSON.stringify(body)) + previousOutputs + 1024 + 64 * (items + tools);
      const available = 30000 - inputUpperBound;
      if (available < WATCHER_TURN_RESERVE_TOKENS) reject(`watcher_context_budget_exceeded:${inputUpperBound}`);
      const maxOutputTokens = WATCHER_TURN_RESERVE_TOKENS;
      body.max_output_tokens = maxOutputTokens; // Includes reasoning and final output in the Responses contract.
      const observation = {
        request: ++requests,
        inputUpperBound,
        maxOutputTokens,
        workingContextUpperBound: inputUpperBound + maxOutputTokens,
      };
      maximum = Math.max(maximum, observation.workingContextUpperBound);
      await input.observed?.(observation);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers))
        if (
          typeof value === 'string' &&
          !['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding'].includes(key)
        )
          headers.set(key, value);
      headers.set('content-type', 'application/json');
      const destination = new URL(upstream);
      destination.search = requestUrl.search;
      const response = await http.send(destination, headers, JSON.stringify(body), signal);
      const status = response.statusCode ?? 502;
      if (status < 200 || status >= 300) {
        reply.writeHead(status, { 'content-type': response.headers['content-type'] ?? 'application/json' });
        for await (const chunk of response) reply.write(chunk);
        reply.end();
        return;
      }
      reply.writeHead(status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let pending = '';
      let charged = false;
      const decoder = new TextDecoder();
      for await (const chunk of response) {
        pending += decoder.decode(chunk, { stream: true });
        if (pending.length > 1_000_000) reject('watcher_provider_frame_exceeds_budget');
        let end: number;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            const event = JSON.parse(data) as {
              type?: string;
              response?: {
                incomplete_details?: { reason?: string };
                usage?: {
                  input_tokens?: number;
                  output_tokens?: number;
                  input_tokens_details?: { cached_tokens?: number };
                };
              };
            };
            if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type ?? '')) {
              const output = event.response?.usage?.output_tokens;
              if (typeof output === 'number' && Number.isSafeInteger(output) && output >= 0) {
                if (output > maxOutputTokens) reject('watcher_provider_output_limit_violated');
              }
              previousOutputs +=
                typeof output === 'number' && Number.isSafeInteger(output) && output >= 0 ? output : maxOutputTokens;
              charged = true;
              const reported = event.response?.usage;
              const valid = (value: unknown): value is number =>
                typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
              if (valid(reported?.input_tokens) && reported.input_tokens + maxOutputTokens > 30000)
                reject('watcher_provider_input_limit_violated');
              await input.completed?.(observation, {
                reportedAt: Date.now(),
                workingContextTokens: observation.workingContextUpperBound,
                ...(valid(reported?.input_tokens) ? { inputTokens: reported.input_tokens } : {}),
                ...(valid(reported?.output_tokens) ? { outputTokens: reported.output_tokens } : {}),
                ...(valid(reported?.input_tokens_details?.cached_tokens)
                  ? { cacheReadTokens: reported.input_tokens_details.cached_tokens }
                  : {}),
              });
            }
            // A structured provider output limit is a budget failure, not every incomplete/native error.
            if (
              event.type === 'response.incomplete' &&
              event.response?.incomplete_details?.reason === 'max_output_tokens'
            )
              reject('watcher_context_budget_exceeded:response_max_output_tokens');
          }
          reply.write(`${frame}\n\n`);
        }
      }
      if (!charged) previousOutputs += maxOutputTokens;
      if (pending) reply.write(pending);
      reply.end();
    } catch (error) {
      failed ??= error instanceof Error ? error : new Error(String(error));
      if (!reply.headersSent)
        reply.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: failed.message }));
      else reply.destroy(failed);
    }
  });
  await new Promise<void>((resolve, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('watcher_request_boundary_unavailable');
  return {
    baseUrl: `http://127.0.0.1:${address.port}${path}`,
    maximum: () => maximum,
    assertHealthy() {
      if (failed) throw failed;
    },
    async close() {
      abort.abort(new Error('watcher_request_boundary_closed'));
      http.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
