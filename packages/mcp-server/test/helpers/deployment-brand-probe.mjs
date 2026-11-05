import { register } from 'node:module';

register(new URL('./deployment-brand-loader.mjs', import.meta.url));

const { deploymentDefaults, DOT_TOOLS, DOT_EVENT_DEFINITION } = await import('@cat-cafe/shared');
const { getConnectorDefinition } = await import('@cat-cafe/shared/types');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createServer } = await import('../../dist/index.js');
const { handleSetReadMode } = await import('../../dist/tools/callback-tools.js');
const { handleAudioListSources } = await import('../../dist/tools/audio-tools.js');
const { handleRealtimeCompanionStatus } = await import('../../dist/tools/realtime-companion-tools.js');
const { handleGraphResolve } = await import('../../dist/tools/graph-tools.js');
const { handleListRecent } = await import('../../dist/tools/recent-tools.js');

// Clear inherited authentication, then prohibit actual network access. All
// failure paths below are read-only; no callback or audio session is created.
for (const key of Object.keys(process.env)) {
  if (/^CAT_CAFE_(INVOCATION|CALLBACK|CREDENTIAL|NATIVE_|AGENT_KEY|API_URL|DESKTOP_MODE)/.test(key))
    delete process.env[key];
}
process.env.CAT_CAFE_READONLY = 'false';
process.env.CAT_CAFE_CAT_ID = 'fixture-cat';
globalThis.fetch = async (url) => {
  if (String(url).includes('/api/library/graph/resolve'))
    return new Response(JSON.stringify({ status: 'no_match', query: 'fixture', message: 'none', examples: [] }));
  if (String(url).includes('/api/library/recent')) return new Response(JSON.stringify({ items: [] }));
  throw new Error('fixture offline');
};

const server = createServer();
const client = new Client({ name: 'brand-contract', version: '1' });
const [ct, st] = InMemoryTransport.createLinkedPair();
try {
  await Promise.all([server.connect(st), client.connect(ct)]);
  const outputs = {
    callback: await client.callTool({ name: 'cat_cafe_list_threads', arguments: {} }),
    readMode: await handleSetReadMode({ mode: 'full' }),
    audio: await handleAudioListSources(),
    companion: await handleRealtimeCompanionStatus({ thread_id: 'fixture-thread' }),
    graph: await handleGraphResolve({ query: 'fixture' }),
    recent: await handleListRecent({}),
  };
  const tools = (await client.listTools()).tools;
  console.log(
    JSON.stringify({
      brand: deploymentDefaults.brand,
      tools,
      dotTools: DOT_TOOLS,
      dotEvent: DOT_EVENT_DEFINITION,
      commandConnector: getConnectorDefinition('system-command'),
      outputs,
    }),
  );
} finally {
  await client.close();
  await server.close();
}
