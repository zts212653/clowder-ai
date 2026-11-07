import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { currentPluginOwnerRequestContext } from '../dist/domains/plugin/carrier/plugin-owner-request-context.js';
import { DeclaredRuntimeContributions } from '../dist/domains/plugin/declared/declared-runtime-contributions.js';
import { pluginWebhookForwardingRoutes } from '../dist/routes/plugin/plugin-webhook-forwarding-routes.js';
import { executionFixture } from './helpers/module-execution-fixture.js';

const readHostStream = `import {Readable} from 'node:stream';
export default {create(){return {start(host){return {actions:{async open({kind}){
  const port=kind==='media'?host.collectiveArtifactOwner.media:host.collectiveArtifactOwner.attachments;
  const result=await (kind==='media'?port.read:port.open)({}, {reauthorize:async()=>({authorized:true})}, new AbortController().signal);
  await host.config.get('RELEASE');
  const body=result.body;
  const closed=new Promise(resolve=>body.once('close',resolve));
  const reader=Readable.toWeb(body).getReader();
  const first=await reader.read();
  await reader.cancel();
  await closed;
  return {isReadable:body instanceof Readable,destroy:typeof body.destroy,closed:body.closed,
    text:Buffer.from(first.value).toString()};
}},stop(){}};}};}};`;

for (const kind of ['media', 'attachment']) {
  test(`Host ${kind} Readable retains its Node surface, later reauthorization and cancellation in the worker`, async (t) => {
    let source;
    let authorizations = 0;
    const released = Promise.withResolvers();
    const open = async (_operation, authority) => {
      let sent = false;
      source = new Readable({
        objectMode: false,
        highWaterMark: 1,
        read() {
          if (sent) return;
          sent = true;
          void released.promise
            .then(() => authority.reauthorize())
            .then(
              () => {
                authorizations++;
                this.push(Buffer.from('ok'));
              },
              (error) => this.destroy(error),
            );
        },
      });
      return { status: 'ok', body: source };
    };
    const f = await executionFixture(t, readHostStream, {
      configuration: [{ key: 'RELEASE', label: 'Release media', kind: 'string', required: false }],
      readConfig: async () => {
        if (source) released.resolve();
        return 'ready';
      },
      neutral: async () => ({
        members: { list: async () => [], get: async () => null },
        collectiveArtifactOwner: { media: { read: open }, attachments: { open } },
      }),
    });
    await f.runtime.start('instance', f.record);
    assert.deepEqual(await f.runtime.invoke('instance', 'open', { kind }), {
      isReadable: true,
      destroy: 'function',
      closed: true,
      text: 'ok',
    });
    assert.equal(authorizations, 1);
    assert.equal(source.destroyed, true);
    assert.equal(source.closed, true);
  });
}

const responseSource = `import {PassThrough,Readable} from 'node:stream';
let last;
export default {create(){return {start(host){return {actions:{
  inspect:()=>({destroyed:last?.destroyed,closed:last?.closed}),
  respond(_input,_native,owner){
    if(_input.request.query.idle==='1'){
      last=new PassThrough();last.write(Buffer.from('first'));
      return {status:200,headers:{'content-type':'application/octet-stream'},body:last};
    }
    last=Readable.from((async function*(){
      for(let i=0;i<5;i++){
        await owner.assertCurrent();
        const user=await host.config.get('OWNER');
        if(user!==owner.userId)throw Error('lost owner context');
        yield Buffer.alloc(256*1024,42);
      }
    })(),{objectMode:false,highWaterMark:1});
    return {status:206,headers:{'content-type':'video/mp4','content-length':String(5*256*1024)},body:last};
  }
},stop(){last?.destroy();}};}};}};`;

async function httpFixture(t) {
  let captured;
  let checks = 0;
  const f = await executionFixture(t, responseSource, {
    configuration: [{ key: 'OWNER', label: 'Owner', kind: 'string', required: false }],
    readConfig: async () => {
      const context = currentPluginOwnerRequestContext('instance');
      if (context) {
        captured = context;
        checks++;
        await context.assertCurrent();
      }
      return context?.userId;
    },
    manifest: {
      features: [{ id: 'main', name: 'Main', resources: [], contributions: [{ type: 'webhook', id: 'media' }] }],
      contributions: [{ type: 'webhook', id: 'media', path: 'media', methods: ['GET'], action: { method: 'respond' } }],
    },
  });
  await f.runtime.start('instance', f.record);
  const contributions = new DeclaredRuntimeContributions({
    packages: {
      resolveInstalledPackage: async () => {
        throw Error('unused package lookup');
      },
    },
    configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
  });
  await contributions.activate(
    { instance: (await f.inventory.snapshot()).instances[0], packageRecord: f.record },
    (id, method, params) => f.runtime.invoke(id, method, params),
  );
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-1';
  });
  await app.register(pluginWebhookForwardingRoutes, { webhooks: contributions });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    try {
      await contributions.deactivateAll();
    } finally {
      await app.close();
    }
  });
  return {
    ...f,
    url: `http://127.0.0.1:${app.server.address().port}/api/plugins/${f.manifest.pluginId}/media`,
    captured: () => captured,
    checks: () => checks,
  };
}

test('real module owner HTTP streams beyond the JSON limit with authority retained through the body', async (t) => {
  const f = await httpFixture(t);
  const response = await fetch(f.url);
  assert.equal(response.status, 206, response.status === 206 ? 'streaming' : await response.clone().text());
  assert.equal((await response.arrayBuffer()).byteLength, 5 * 256 * 1024);
  assert.equal(f.checks(), 5);
  if (!f.captured().signal.aborted)
    await new Promise((resolve) => f.captured().signal.addEventListener('abort', resolve, { once: true }));
  await assert.rejects(f.captured().assertCurrent(), /no longer current/);
});

test('client disconnect destroys the idle worker Readable through the real owner HTTP path', async (t) => {
  const f = await httpFixture(t);
  const cancellation = new AbortController();
  const response = await fetch(`${f.url}?idle=1`, { signal: cancellation.signal });
  assert.equal(response.status, 200, response.status === 200 ? 'streaming' : await response.clone().text());
  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), 'first');
  cancellation.abort();
  let state;
  for (let attempt = 0; attempt < 2000; attempt++) {
    state = await f.runtime.invoke('instance', 'inspect', {});
    if (state.closed) break;
    await delay(5);
  }
  assert.deepEqual(state, { closed: true, destroyed: true });
});

const producerSource = `import {Readable} from 'node:stream';
let last,produced=0;
export default {create(){return {start(){return {actions:{
  open({idle}){
    last=new Readable({highWaterMark:1,read(){
      if(idle)return;
      if(produced===64)this.push(null);
      else {produced++;this.push(Buffer.alloc(64*1024,42));}
    }});
    return last;
  },
  fail(){last.destroy(Error('source stream failed'));},
  inspect:()=>({produced,closed:last?.closed})
},stop(){last?.destroy();}};}};}};`;

test('a worker Readable error reaches the consumer and closes the stream without crashing the worker', async (t) => {
  const f = await executionFixture(t, producerSource);
  await f.runtime.start('instance', f.record);
  const body = await f.runtime.invoke('instance', 'open', { idle: true });
  assert.ok(body instanceof Readable);
  const closed = new Promise((resolve) => body.once('close', resolve));
  const consuming = assert.rejects(async () => {
    for await (const _chunk of body) {
    }
  }, /source stream failed/);
  await f.runtime.invoke('instance', 'fail', {});
  await consuming;
  await closed;
  assert.equal(body.destroyed, true);
  assert.equal((await f.runtime.invoke('instance', 'inspect', {})).closed, true);
});

test('a worker Readable remains backpressured until the receiver consumes it', async (t) => {
  const f = await executionFixture(t, producerSource);
  await f.runtime.start('instance', f.record);
  const body = await f.runtime.invoke('instance', 'open', {});
  const waiting = await f.runtime.invoke('instance', 'inspect', {});
  assert.ok(waiting.produced < 64, 'transfer must not drain the entire producer into a message queue');
  let bytes = 0;
  for await (const chunk of body) bytes += chunk.length;
  assert.equal(bytes, 64 * 64 * 1024);
  assert.equal((await f.runtime.invoke('instance', 'inspect', {})).produced, 64);
});

test('stopping the lease destroys an unconsumed nested Readable and its Host source', async (t) => {
  const source = new PassThrough();
  const sourceClosed = new Promise((resolve) => source.once('close', resolve));
  const f = await executionFixture(
    t,
    `export default {create(){return {start(host){return {actions:{
    async open(){return host.collectiveArtifactOwner.media.read({}, {}, new AbortController().signal);}
  },stop(){}};}};}};`,
    {
      neutral: async () => ({
        members: { list: async () => [], get: async () => null },
        collectiveArtifactOwner: { media: { read: async () => ({ body: source }) } },
      }),
    },
  );
  await f.runtime.start('instance', f.record);
  const { body } = await f.runtime.invoke('instance', 'open', {});
  assert.ok(body instanceof Readable);
  const closed = new Promise((resolve) => body.once('close', resolve));
  await f.runtime.stop('instance', 'test-stop');
  await Promise.all([closed, sourceClosed]);
  assert.equal(source.destroyed, true);
  assert.equal(body.destroyed, true);
});
