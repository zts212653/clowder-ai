import { once } from 'node:events';
import { createServer } from 'node:http';

export async function startLayoutModel(options = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method !== 'POST') {
      res.writeHead(200);
      res.end('{"data":[]}');
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({
      authorization: Boolean(req.headers.authorization),
      model: body.model,
      nativeMemory: JSON.stringify(body).includes('F320_NATIVE_MEMORY'),
    });
    const id = `fixture-${requests.length}`;
    const item = {
      type: 'message',
      id: `msg-${id}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: options.replyText ?? `LOCAL_LAYOUT_REPLY_${requests.length}` }],
    };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [type, payload] of [
      ['response.created', { response: { id, status: 'in_progress', output: [] } }],
      ['response.output_item.added', { output_index: 0, item }],
      ['response.output_item.done', { output_index: 0, item }],
      [
        'response.completed',
        {
          response: {
            id,
            status: 'completed',
            model: body.model,
            output: [item],
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          },
        },
      ],
    ])
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
