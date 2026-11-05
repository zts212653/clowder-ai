import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ClaudeSdkQueryFn } from '../src/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';
import { loadClaudeSdkQuery } from '../src/domains/cats/services/agents/providers/claude-sdk-query.js';

test('importing and constructing the SDK carrier does not load the unused SDK runtime', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-lazy-import-'));
  const entry = new URL('../src/domains/cats/services/agents/providers/ClaudeSdkAgentService.ts', import.meta.url).href;
  const catalog = new URL('../src/routes/runtime-catalog-probe.ts', import.meta.url).href;
  const history = new URL('../src/domains/cats/services/session/import/LocalSessionInspection.ts', import.meta.url)
    .href;
  const script = `
    import { registerHooks } from 'node:module';
    const hooks = registerHooks({load(url, context, next) {
      if (url.includes('/@anthropic-ai/claude-agent-sdk/')) throw new Error('SDK eagerly loaded before an SDK invocation');
      return next(url, context);
    }});
    try {
      const {claudeSdkRuntimeFixture} = await import(${JSON.stringify(new URL('./helpers/claude-sdk-runtime-fixture.js', import.meta.url).href)});
      const {ClaudeSdkAgentService} = await import(${JSON.stringify(entry)});
      await import(${JSON.stringify(catalog)});
      await import(${JSON.stringify(history)});
      const service = new ClaudeSdkAgentService({ runtimeResolver: claudeSdkRuntimeFixture,model:'fixture',mcpServerPath:''});
      if (service.contextCapability().carrier !== 'agent_sdk') throw new Error('Carrier identity changed');
      let closed = 0;
      const injected = new ClaudeSdkAgentService({ runtimeResolver: claudeSdkRuntimeFixture,model:'fixture',mcpServerPath:'',l0CompilerFn:async ()=>'fixture identity',queryFn:({prompt})=>({
        async *[Symbol.asyncIterator]() {
          const first = await prompt[Symbol.asyncIterator]().next();
          yield {type:'system',subtype:'init',session_id:'fixture'};
          yield {type:'system',subtype:'session_state_changed',state:'running',session_id:'fixture'};
          yield {type:'assistant',message:{id:'fixture',role:'assistant',content:[{type:'text',text:'injected-query-used'}]}};
          yield {type:'result',subtype:'success',session_id:'fixture',is_error:false,user_message_uuids:[first.value.uuid],queued_turn_count:0};
          yield {type:'system',subtype:'session_state_changed',state:'idle',session_id:'fixture'};
        },close(){closed++;}
      })});
      const events=[];
      for await(const event of injected.invoke('fixture',{toolExecutionPolicy:{mode:'read_only'}})) events.push(event);
      if(events.some(event=>event.type==='error') || !events.some(event=>event.content==='injected-query-used') || closed!==1) throw new Error('Injected query/cleanup contract changed: '+JSON.stringify({events,closed}));
      console.log('unused-sdk-not-loaded');
    } finally { hooks.deregister(); }
  `;
  try {
    const runner = join(root, 'probe.mjs');
    writeFileSync(runner, script);
    const child = spawnSync(process.execPath, ['--import', 'tsx', runner], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        APPDATA: root,
        LOCALAPPDATA: root,
        CAT_CAFE_DATA_DIR: root,
        CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT: '1',
      },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /unused-sdk-not-loaded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('abort before SDK load never imports it', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await loadClaudeSdkQuery(controller.signal, async () => {
    assert.fail('SDK must not load for an already cancelled invocation');
  });
  assert.equal(result, undefined);
});

test('abort while SDK loads prevents query admission after import resolves', async () => {
  const controller = new AbortController();
  let finish!: (value: { query: ClaudeSdkQueryFn }) => void;
  const promise = loadClaudeSdkQuery(
    controller.signal,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  controller.abort();
  finish({ query: () => assert.fail('Cancelled invocation must not start a query') });
  assert.equal(await promise, undefined);
});

test('SDK loader returns the selected implementation and preserves import failures', async () => {
  const controller = new AbortController();
  const query: ClaudeSdkQueryFn = () => assert.fail('Resolving an SDK implementation must not invoke it');
  assert.equal(await loadClaudeSdkQuery(controller.signal, async () => ({ query })), query);
  const error = new Error('fixture SDK missing');
  await assert.rejects(
    loadClaudeSdkQuery(controller.signal, async () => {
      throw error;
    }),
    (actual) => actual === error,
  );
});
