import { createServer } from 'node:http';

interface NativeTool {
  function?: { name: string };
}
interface ProbeCall {
  name: string;
  args: Record<string, unknown>;
}

/** A loopback model fixture offers one declared tool; no provider account is involved. */
export async function startNativeProbeApi(select: (tools: NativeTool[]) => ProbeCall | undefined) {
  let offered = false;
  const requests: string[] = [];
  const notices: { body: string; invocation: string | string[] | undefined }[] = [];
  const api = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    if (req.url === '/api/callbacks/post-message') {
      notices.push({ body: raw, invocation: req.headers['x-invocation-id'] });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"messageId":"native-notice"}');
      return;
    }
    if (!req.url?.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    const body = JSON.parse(raw) as { model?: string; tools?: NativeTool[]; stream?: boolean };
    requests.push(raw);
    const call = offered ? undefined : select(body.tools ?? []);
    if (call) offered = true;
    const delta = call
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'native_call',
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        }
      : { role: 'assistant', content: 'Probe complete.' };
    const envelope = (value: unknown, finish_reason: string | null) => ({
      id: 'chat-probe',
      object: 'chat.completion.chunk',
      created: 1,
      model: body.model,
      choices: [{ index: 0, delta: value, finish_reason }],
    });
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify(envelope(delta, null))}\n\ndata: ${JSON.stringify(envelope({}, call ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`,
      );
    } else {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'chat-probe',
          object: 'chat.completion',
          created: 1,
          model: body.model,
          choices: [{ index: 0, message: delta, finish_reason: call ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('probe_address_missing');
  return {
    base: `http://127.0.0.1:${address.port}/v1`,
    requests,
    notices,
    get offered() {
      return offered;
    },
    async close() {
      api.closeAllConnections();
      await new Promise<void>((resolve) => api.close(() => resolve()));
    },
  };
}
