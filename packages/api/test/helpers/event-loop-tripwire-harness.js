import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// A real, owned JS file beneath dist gives V8 a verifiable API coordinate; no fabricated frame.
const fixture = `
import { createServer } from 'node:http';
import { createEventLoopTripwire } from '../infrastructure/telemetry/cpu/event-loop-tripwire.js';
import { acquireCpuProfiler } from '../infrastructure/telemetry/cpu/cpu-profiler-lease.js';
import { recordProcessCpuProfile } from '../infrastructure/telemetry/cpu/process-cpu-session.js';
import { normalizeJsonUnicode } from '../utils/json-unicode.js';
import { fileURLToPath } from 'node:url';
const keepAlive = setInterval(() => {}, 1000);
const install = createEventLoopTripwire();
const initialLease = process.argv[2] === 'foreground-first' ? await acquireCpuProfiler() : undefined;
const initialCapture = initialLease ? recordProcessCpuProfile(new AbortController().signal, 200) : undefined;
let failedSink = false;
const options = {logger: {info(entry) {if (failedSink) throw Error('broken sink'); process.send({type:'log', entry});}}, bootId:'owned-test-boot', windowMs:process.argv[2] === 'long-window' ? 300000 : process.argv[2] === 'retained-window' ? 3500 : 500, logDir:fileURLToPath(new URL('.',import.meta.url))};
if (process.argv[2] === 'slow-start-budget') options.profileStartBudgetMs = 0;
let handle;
if (process.argv[2]?.startsWith('startup')) {
  const {initializeWithEventLoopTripwire} = await import('../infrastructure/telemetry/cpu/event-loop-tripwire-startup.js');
  const originalError = Error('owned startup failure');
  try {
    await initializeWithEventLoopTripwire(options, async observer => {
      handle = observer;
      if (process.argv[2] === 'startup-fails') throw originalError;
      observer.setBootId('owned-startup-boot');
      process.send({type:'cold-entered'});
      uninterruptibleNativeWait(1600);
    });
  } catch (error) {
    const release = await acquireCpuProfiler();
    process.send({type:'startup-failed',sameError:error === originalError,profilerReleased:Boolean(release)});
    release?.();
  }
} else handle = install(options);
if (process.argv[2] === 'blocked-install') uninterruptibleNativeWait(3600);
if (!process.argv[2]?.startsWith('startup') && handle !== install({logger:{info(){}}})) throw Error('duplicate observer');
const server = createServer((request,response) => setTimeout(() => response.end('ok'), request.url === '/await' ? 600 : 0));
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
function occupyEventLoopSpin(ms) { const end = performance.now()+ms; while(performance.now()<end) {} }
function nativeBlockingWait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms); }
function uninterruptibleNativeWait(ms) {process.getBuiltinModule('node:child_process').execFileSync(process.execPath,['-e','Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,'+ms+')']);}
function unicodeWork(ms) {const until=performance.now()+ms; let length=0; while(performance.now()<until) length+=normalizeJsonUnicode({text:'“payload”'.repeat(64)}).text.length; return length;}
process.on('message', async message => {
  if (message.type === 'pair') {
    const firstStarted=performance.now();
    const first=unicodeWork(450);
    const firstEnded=performance.now();
    await new Promise(resolve=>setTimeout(resolve,message.gap));
    const secondStarted=performance.now();
    const second=unicodeWork(450);
    process.send({type:'pair-done',id:message.id,firstStarted,firstEnded,secondStarted,secondEnded:performance.now(),work:first+second});
  }
  if (message.type === 'sink-failure') {failedSink = true; process.send({type:'sink-failure'});}
  if (message.type === 'close-observer') {await handle.close(); process.send({type:'closed-observer'});}
  if (message.type === 'close-race') {
    const closing = handle.close();
    const early = await acquireCpuProfiler();
    const admittedEarly = Boolean(early);
    early?.();
    await closing;
    process.send({type:'close-race',admittedEarly});
  }
  if (message.type === 'release-initial') {
    try {process.send({type:'initial-foreground',status:(await initialCapture).status,returnedAt:Date.now()});}
    finally {initialLease();}
  }
  if (message.type === 'block') {
    process.send({type:'entered',id:message.id,atMs:performance.now()});
    if (message.native === 'process') uninterruptibleNativeWait(message.ms);
    else if (message.native === 'unicode') unicodeWork(message.ms);
    else if (message.native) nativeBlockingWait(message.ms); else occupyEventLoopSpin(message.ms);
    process.send({type:'done',id:message.id,atMs:performance.now()});
  }
  if (message.type === 'foreground') {
    const release = await acquireCpuProfiler();
    if (!release) throw Error('foreground refused');
    try {const result = await recordProcessCpuProfile(new AbortController().signal, 80); process.send({type:'foreground',status:result.status,returnedAt:Date.now()});}
    finally {release();}
  }
  if (message.type === 'close' || message.type === 'natural-exit') {
    if (message.type === 'close') {await handle.close(); await handle.close();}
    await new Promise(resolve => server.close(resolve));
    clearInterval(keepAlive);
    process.disconnect();
  }
});
process.send({type:'ready',ready:await handle.ready,port:server.address().port});
`;

export async function harness(t, mode, source = false) {
  const folder = await mkdtemp(
    fileURLToPath(new URL(`../../${source ? 'src' : 'dist'}/tripwire-test-`, import.meta.url)),
  );
  const file = `${folder}/fixture.js`;
  await writeFile(file, fixture);
  const child = fork(file, mode ? [mode] : [], {
    execArgv: source ? ['--import', 'tsx'] : [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.on('message', (message) => messages.push(message));
  const exited = once(child, 'exit');
  async function wait(predicate, timeout = 5000) {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      const match = messages.find(predicate);
      if (match) return match;
      if (child.exitCode !== null) assert.fail(`child exited ${child.exitCode}: ${stderr}`);
      await delay(15);
    }
    assert.fail(`missing child event: ${JSON.stringify(messages)}; ${stderr}`);
  }
  t.after(async () => {
    if (child.connected) child.send({ type: 'close' });
    let timeout;
    const result = await Promise.race([
      exited,
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve('timeout'), 1500);
      }),
    ]);
    clearTimeout(timeout);
    if (result === 'timeout') {
      child.kill('SIGKILL');
      await exited;
    }
    await rm(folder, { recursive: true, force: true });
  });
  const ready = await wait((message) => message.type === (mode === 'startup' ? 'cold-entered' : 'ready'));
  if (mode !== 'startup') assert.equal(ready.ready, true, stderr);
  return {
    child,
    messages,
    wait,
    exited,
    port: ready.port,
    folder,
    reports: () => messages.filter((m) => m.type === 'log' && m.entry.kind === 'event_loop_stall').map((m) => m.entry),
  };
}

export async function block(h, id, ms, native = false) {
  const lastComplete =
    h
      .reports()
      .filter((report) => report.phase === 'complete')
      .at(-1)?.observedAt ?? 0;
  await h.wait(
    (message) =>
      message.type === 'log' &&
      message.entry.status === 'sampler_ready' &&
      message.entry.armedAt >= Math.max(lastComplete, ...h.messages.map((event) => event.returnedAt ?? 0)),
  );
  const previousEpisodes = new Set(h.reports().map((report) => report.episode));
  h.child.send({ type: 'block', id, ms, native });
  await h.wait((message) => message.type === 'done' && message.id === id);
  await h.wait(
    (message) =>
      message.type === 'log' &&
      message.entry.kind === 'event_loop_stall' &&
      message.entry.phase === 'complete' &&
      !previousEpisodes.has(message.entry.episode),
  );
}
