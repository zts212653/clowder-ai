import { Agent, createServer, request as forwardRequest } from 'node:http';

export async function startWorkspaceNetworkProxy(webUrl, ownerUrl) {
  const web = new URL(webUrl);
  const owner = new URL(ownerUrl);
  for (const upstream of [web, owner]) {
    if (upstream.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(upstream.hostname)) {
      throw new Error('Workspace browser fixtures require local HTTP upstreams');
    }
  }
  const agent = new Agent({ keepAlive: true });
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url, web.origin);
    const upstream = url.pathname.startsWith('/api/workspace/') ? owner : web;
    const request = forwardRequest(new URL(`${url.pathname}${url.search}`, upstream.origin), {
      method: incoming.method,
      headers: { ...incoming.headers, host: upstream.host },
      agent,
    });
    request.on('response', (response) => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.on('error', (error) => outgoing.destroy(error));
      response.pipe(outgoing);
    });
    request.on('error', (error) => {
      if (outgoing.headersSent) outgoing.destroy(error);
      else outgoing.writeHead(502).end('Workspace fixture upstream failed');
    });
    incoming.on('aborted', () => request.destroy());
    outgoing.on('close', () => {
      if (!outgoing.writableEnded) request.destroy();
    });
    incoming.pipe(request);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  return {
    baseUrl: `${origin}${web.pathname}${web.search}`,
    async close() {
      if (closed) return;
      closed = true;
      const closing = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      agent.destroy();
      await closing;
    },
  };
}
