import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { errorResult, successResult, type ToolResult } from './file-tools.js';
import { resolveInvocationRequestSignal } from './invocation-auth.js';

export interface CallbackReadBudget {
  timeoutMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
}

export function boundedCallbackResult(
  response: { status: number; body: string },
  budget: CallbackReadBudget,
  reasonTag: string,
): ToolResult {
  const ok = response.status >= 200 && response.status < 300;
  const text = ok
    ? JSON.stringify(JSON.parse(response.body))
    : `Callback failed (${response.status})${reasonTag}: ${response.body}`;
  // JSON serialization and error prefixes must fit the same output budget.
  if (Buffer.byteLength(text) > budget.maxResponseBytes)
    return errorResult(`Callback result exceeds ${budget.maxResponseBytes} byte limit`);
  return ok ? successResult(text) : errorResult(text);
}

/** Internal tightening-only budget; tool callers cannot select it. */
export function boundedCallbackGet(
  url: string,
  headers: Record<string, string>,
  budget: CallbackReadBudget,
): Promise<{ status: number; body: string }> {
  const signal = resolveInvocationRequestSignal(budget.signal);
  if (
    !Number.isInteger(budget.timeoutMs) ||
    budget.timeoutMs < 1 ||
    budget.timeoutMs > 10_000 ||
    !Number.isInteger(budget.maxResponseBytes) ||
    budget.maxResponseBytes < 1 ||
    budget.maxResponseBytes > 65_536
  ) {
    return Promise.reject(new Error('Invalid bounded callback budget'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => finish(new Error('Callback total transport deadline exceeded')), budget.timeoutMs);
    let request: ReturnType<typeof httpRequest> | undefined;
    let response: import('node:http').IncomingMessage | undefined;
    function finish(error?: Error, result?: { status: number; body: string }) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      response?.destroy();
      request?.destroy();
      if (error) reject(error);
      else if (result) resolve(result);
    }
    function abort() {
      finish(new Error('Callback read cancelled'));
    }
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const target = new URL(url);
      if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('Unsupported callback protocol');
      if (target.username || target.password) throw new Error('Callback URL cannot carry credentials');
      // A direct per-call connection ignores ambient proxy configuration, does not
      // follow redirects, and leaves no pooled socket behind after the deadline.
      request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
        target,
        { method: 'GET', headers, agent: false },
        (incoming) => {
          response = incoming;
          incoming.on('error', (error) => finish(error));
          incoming.on('aborted', () => finish(new Error('Callback response aborted')));
          if (incoming.statusCode && incoming.statusCode >= 300 && incoming.statusCode < 400) {
            finish(new Error('Callback redirect refused'));
            return;
          }
          incoming.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > budget.maxResponseBytes) {
              finish(new Error(`Callback response exceeds ${budget.maxResponseBytes} byte limit`));
            } else chunks.push(chunk);
          });
          incoming.on('end', () =>
            finish(undefined, {
              status: incoming.statusCode ?? 502,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      request.on('error', (error) => finish(error));
      request.end();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
