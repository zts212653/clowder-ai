import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { currentPluginCallContext, withPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import { executionFixture } from './helpers/module-execution-fixture.js';

function nativeCall(f, method) {
  return withPluginCallContext(
    'instance',
    {
      catId: 'review-caller',
      userId: 'owner',
      threadId: 'thread-response-fixture',
      invocationId: 'response-invocation',
      assertCurrent: async () => {},
    },
    () => f.runtime.invoke('instance', method, {}),
  );
}

test('a custom async iterator factory executes once inside the current native caller context', async (t) => {
  const f = await executionFixture(
    t,
    `export default {create(){let factories=0;return {start(host){return {actions:{
      open(){return {[Symbol.asyncIterator](){
        factories++;
        const caller=host.config.get('CALLER');
        let done=false;
        return {async next(){if(done)return {done:true};done=true;return {done:false,value:await caller};},
          async return(){return {done:true};}};
      }};},
      factories(){return factories;}
    },stop(){}};}};}};`,
    {
      configuration: [{ key: 'CALLER', label: 'Caller', kind: 'string', required: false }],
      readConfig: async () => currentPluginCallContext('instance')?.catId ?? 'background',
    },
  );
  await f.runtime.start('instance', f.record);
  const stream = await nativeCall(f, 'open');
  try {
    assert.deepEqual(await stream.next(), { done: false, value: 'review-caller' });
    assert.equal(await f.runtime.invoke('instance', 'factories', {}), 1);
  } finally {
    await stream.return();
  }
});

test('a response getter is evaluated once and its transmitted Readable owns the caller lifetime', async (t) => {
  const gate = Promise.withResolvers();
  let active = false;
  const f = await executionFixture(
    t,
    `import {Readable} from 'node:stream';
    export default {create(){let reads=0,finish;const late=new Promise(resolve=>{finish=resolve;});
      const bodies=[];return {start(host){return {actions:{
        open(){return {get body(){
          const current=++reads;
          const caller=host.config.get('CALLER');
          setTimeout(async()=>{try{
            await host.config.get('BARRIER');finish(await host.config.get('CALLER'));
          }catch(error){finish(error.message);}},0);
          const body=Readable.from((async function*(){yield Buffer.from(current+':'+await caller);})());
          bodies.push(body);return body;
        }};},
        reads(){return reads;},late(){return late;}
      },stop(){for(const body of bodies)body.destroy();}};}};}};`,
    {
      configuration: [
        { key: 'CALLER', label: 'Caller', kind: 'string', required: false },
        { key: 'BARRIER', label: 'Barrier', kind: 'string', required: false },
      ],
      readConfig: async (_instanceId, key) => {
        if (key === 'BARRIER' && active) return gate.promise;
        return currentPluginCallContext('instance')?.catId ?? 'background';
      },
    },
  );
  t.after(() => gate.resolve('released'));
  await f.runtime.start('instance', f.record);
  active = true;
  const { body } = await nativeCall(f, 'open');
  const closed = body.closed ? Promise.resolve() : once(body, 'close');
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  await closed;
  gate.resolve('released');
  assert.equal(Buffer.concat(chunks).toString(), '1:review-caller');
  assert.equal(await f.runtime.invoke('instance', 'reads', {}), 1);
  assert.equal(await f.runtime.invoke('instance', 'late', {}), 'background');
});

test('a nested iterator retains its caller until return, then detaches late work to the activation', async (t) => {
  const before = Promise.withResolvers();
  const after = Promise.withResolvers();
  let active = false;
  const f = await executionFixture(
    t,
    `export default {create(){let first,second;
      const during=new Promise(resolve=>{first=resolve;});
      const ended=new Promise(resolve=>{second=resolve;});
      return {start(host){return {actions:{
        open(){
          setTimeout(async()=>{try{
            await host.config.get('BARRIER');first(await host.config.get('CALLER'));
            await host.config.get('AFTER');second(await host.config.get('CALLER'));
          }catch(error){first(error.message);second(error.message);}},0);
          return {events:(async function*(){yield 'event';})()};
        },during(){return during;},ended(){return ended;}
      },stop(){}};}};}};`,
    {
      configuration: ['CALLER', 'BARRIER', 'AFTER'].map((key) => ({
        key,
        label: key,
        kind: 'string',
        required: false,
      })),
      readConfig: async (_instanceId, key) => {
        if (active && key === 'BARRIER') return before.promise;
        if (active && key === 'AFTER') return after.promise;
        return currentPluginCallContext('instance')?.catId ?? 'background';
      },
    },
  );
  t.after(() => {
    before.resolve('released');
    after.resolve('released');
  });
  await f.runtime.start('instance', f.record);
  active = true;
  const { events } = await nativeCall(f, 'open');
  try {
    before.resolve('released');
    assert.equal(await f.runtime.invoke('instance', 'during', {}), 'review-caller');
  } finally {
    await events.return();
    after.resolve('released');
  }
  assert.equal(await f.runtime.invoke('instance', 'ended', {}), 'background');
});
