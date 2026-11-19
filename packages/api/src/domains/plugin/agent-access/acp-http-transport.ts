import { once } from 'node:events';
import { type ClientRequest, type IncomingMessage, request as requestHttp } from 'node:http';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { ACP_METHODS, type AgentAccessAcpOutputFrame } from '@clowder-ai/agent-contract/acp';
import { z } from 'zod';
import type { AcpChildConnection } from '../../cats/services/agents/providers/acp/AcpClient.js';

const startupPort = /(?:port[:\s]+|"port"\s*:\s*)(\d{4,5})/i;
const wireHeader = z.object({
  method: z.string().optional(),
  id: z.union([z.string(), z.number()]).nullable().optional(),
  params: z.object({ sessionId: z.string().optional() }).optional(),
});

/** ACP over the legacy loopback HTTP transport. The plugin sees the same JSON-RPC records. */
export function createAcpHttpTransport(child: AcpChildConnection) {
  if (!child.stdout) throw new Error('ACP HTTP provider stdout unavailable');
  const stdout = new PassThrough({ objectMode: true });
  const lifetime = new AbortController();
  const requests = new Map<string, ClientRequest>();
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
  const readReply = async (response: IncomingMessage, header: z.infer<typeof wireHeader>) => {
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      response.resume();
      throw new Error(`ACP HTTP returned status ${status}`);
    }
    if (!header.method || header.id == null) {
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
          await publish({ kind: 'line', line });
          if (!incoming.data.method && String(incoming.data.id) === String(header.id)) return;
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
      if (String(wireHeader.parse(incoming).id) !== String(header.id))
        throw new Error('ACP HTTP response did not match the request ID');
      await publish({ kind: 'line', line: JSON.stringify(incoming) });
    }
  };

  return {
    stdout,
    ready,
    writeLine(line: string) {
      const url = endpoint;
      if (!url || lifetime.signal.aborted) return Promise.reject(new Error('ACP HTTP provider is closed'));
      const header = wireHeader.parse(JSON.parse(line));
      const session = header.params?.sessionId;
      const isPrompt = header.method === ACP_METHODS.sessionPrompt;
      const isCancel = header.method === ACP_METHODS.sessionCancel;
      return new Promise<void>((resolve, reject) => {
        const fail = (error: unknown) => {
          if (lifetime.signal.aborted) {
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
        const request = requestHttp(
          url,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(line) },
            agent: false,
            signal: lifetime.signal,
          },
          (response) => {
            void readReply(response, header).then(() => {
              if (!header.method) resolve();
            }, fail);
          },
        );
        if (isPrompt && session) requests.set(session, request);
        request.once('close', () => {
          if (session && requests.get(session) === request) requests.delete(session);
        });
        request.once('error', fail);
        request.end(line, () => {
          if (isCancel && session) requests.get(session)?.destroy();
          if (header.method) resolve();
        });
      });
    },
  };
}
