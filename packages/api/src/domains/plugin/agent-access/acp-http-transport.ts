import { addAbortListener, once } from 'node:events';
import { type IncomingMessage, request as requestHttp } from 'node:http';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { ACP_METHODS, type AgentAccessAcpOutputFrame } from '@clowder-ai/agent-contract/acp';
import { z } from 'zod';
import type { AcpChildConnection } from '../../cats/services/agents/providers/acp/AcpClient.js';

const startupPort = /(?:port[:\s]+|"port"\s*:\s*)(\d{4,5})/i;
const wireHeader = z.object({
  method: z.string().optional(),
  id: z.union([z.string(), z.number()]).nullable().optional(),
  params: z.object({ sessionId: z.string().optional() }).optional(),
});
interface HttpPrompt {
  lifetime: AbortController;
  fail: (error: unknown) => void;
  resume?: () => void;
}

/** ACP over the legacy loopback HTTP transport. The plugin sees the same JSON-RPC records. */
export function createAcpHttpTransport(child: AcpChildConnection) {
  if (!child.stdout) throw new Error('ACP HTTP provider stdout unavailable');
  const stdout = new PassThrough({ objectMode: true });
  const lifetime = new AbortController();
  const requests = new Map<string, HttpPrompt>();
  const startup = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const end = () => {
    lifetime.abort();
    startup.close();
    stdout.end();
  };
  child.onExit(end);
  child.onError(end);

  let endpoint: string | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      startup.removeListener('line', onLine);
      startup.removeListener('close', onClose);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('ACP HTTP stdout closed before port discovery'));
    };
    const onLine = (line: string) => {
      const port = Number(line.match(startupPort)?.[1]);
      if (!port || port > 65_535) return;
      endpoint = `http://127.0.0.1:${port}/`;
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('ACP HTTP port discovery timed out'));
    }, 30_000);
    startup.on('line', onLine);
    startup.once('close', onClose);
    if (lifetime.signal.aborted) onClose();
  });

  const publish = async (frame: AgentAccessAcpOutputFrame) => {
    if (lifetime.signal.aborted) return;
    if (!stdout.write(frame)) await once(stdout, 'drain', { signal: lifetime.signal });
  };
  const readReply = async (response: IncomingMessage, header: z.infer<typeof wireHeader>, prompt?: HttpPrompt) => {
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      response.resume();
      throw new Error(`ACP HTTP returned status ${status}`);
    }
    if (!header.method) {
      response.resume();
      await finished(response, { cleanup: true });
    } else if (header.id == null) {
      response.resume();
    } else if (header.method === ACP_METHODS.sessionPrompt) {
      const lines = createInterface({ input: response, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          let decoded: unknown;
          try {
            decoded = JSON.parse(line);
          } catch {
            continue;
          }
          const incoming = wireHeader.safeParse(decoded);
          if (!incoming.success) continue;
          if (incoming.data.method) {
            if (incoming.data.params?.sessionId !== header.params?.sessionId) continue;
          } else if (incoming.data.id !== header.id) {
            continue;
          }
          const expectsReply =
            incoming.data.method &&
            (incoming.data.id != null || incoming.data.method === ACP_METHODS.requestPermission);
          if (prompt && expectsReply) {
            const receipt = new Promise<void>((resolve) => {
              prompt.resume = resolve;
            });
            const abort = addAbortListener(prompt.lifetime.signal, () => prompt.resume?.());
            try {
              await publish({ kind: 'line', line });
              await receipt;
              if (prompt.lifetime.signal.aborted) return;
            } finally {
              abort[Symbol.dispose]();
              prompt.resume = undefined;
            }
          } else {
            await publish({ kind: 'line', line });
          }
          if (!incoming.data.method) return;
        }
      } finally {
        lines.close();
        response.destroy();
      }
      throw new Error('ACP HTTP stream closed before the final prompt response');
    } else {
      response.setEncoding('utf8');
      let body = '';
      for await (const chunk of response) body += chunk;
      const incoming = JSON.parse(body);
      const reply = wireHeader.parse(incoming);
      if (reply.method || reply.id !== header.id) throw new Error('ACP HTTP response did not match the request ID');
      await publish({ kind: 'line', line: JSON.stringify(incoming) });
    }
  };

  return {
    stdout,
    ready,
    promptSignal(sessionId: string): AbortSignal | undefined {
      return requests.get(sessionId)?.lifetime.signal;
    },
    failPrompt(sessionId: string, error: unknown) {
      const prompt = requests.get(sessionId);
      prompt?.fail(error);
      prompt?.lifetime.abort();
    },
    writeLine(line: string, replySessionId?: string) {
      const url = endpoint;
      if (!url || lifetime.signal.aborted) return Promise.reject(new Error('ACP HTTP provider is closed'));
      const header = wireHeader.parse(JSON.parse(line));
      const session = header.params?.sessionId;
      const isPrompt = header.method === ACP_METHODS.sessionPrompt;
      const isCancel = header.method === ACP_METHODS.sessionCancel;
      const promptLifetime = isPrompt && session ? new AbortController() : undefined;
      const parentPrompt = replySessionId ? requests.get(replySessionId) : undefined;
      const turnSignal = parentPrompt?.lifetime.signal ?? promptLifetime?.signal;
      if (replySessionId && !turnSignal) return Promise.resolve();
      const signal = turnSignal ? AbortSignal.any([lifetime.signal, turnSignal]) : lifetime.signal;
      return new Promise<void>((resolve, reject) => {
        let failed = false;
        const fail = (error: unknown) => {
          if (failed) return;
          failed = true;
          if (lifetime.signal.aborted || turnSignal?.aborted) {
            resolve();
          } else if (header.method && header.id != null) {
            // Keep the transport failure in order after already observed output.
            stdout.write({
              kind: 'request_error',
              requestId: String(header.id),
              message: error instanceof Error ? error.message : 'ACP HTTP request failed',
            } satisfies AgentAccessAcpOutputFrame);
            resolve();
          } else if (header.method) {
            resolve();
          } else {
            reject(error);
          }
        };
        const prompt = promptLifetime && { lifetime: promptLifetime, fail };
        let responseStarted = false;
        const finishPrompt = () => {
          if (session && prompt && requests.get(session) === prompt) requests.delete(session);
          promptLifetime?.abort();
        };
        const request = requestHttp(
          url,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(line) },
            agent: false,
            signal,
          },
          (response) => {
            responseStarted = true;
            void readReply(response, header, prompt)
              .then(() => {
                if (!header.method) {
                  parentPrompt?.resume?.();
                  resolve();
                }
              }, fail)
              .finally(finishPrompt);
          },
        );
        if (prompt && session) requests.set(session, prompt);
        request.once('close', () => {
          if (!responseStarted) finishPrompt();
        });
        request.once('error', fail);
        request.end(line, () => {
          if (isCancel && session) requests.get(session)?.lifetime.abort();
          if (header.method) resolve();
        });
      });
    },
  };
}
