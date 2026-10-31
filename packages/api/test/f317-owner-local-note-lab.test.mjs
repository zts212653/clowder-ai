import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createCdpPageActionPort } from '../src/domains/concierge/action/CdpPageActionPort.ts';
import { maybeStartOwnerLocalNoteLab } from '../src/domains/concierge/live/host/owner-local-note-lab.ts';

const projectRoot = resolve('../..');
const isolated = {
  projectRoot,
  apiPort: 3202,
  apiHost: '127.0.0.1',
  memoryStore: true,
  nodeEnv: 'development',
};

test('ordinary Host keeps the named page and owner action disabled', async () => {
  assert.equal(await maybeStartOwnerLocalNoteLab({ ...isolated, enabled: false }), null);
});

test('a requested local trial refuses daily, Alpha, network and persistent-state launches', async () => {
  for (const unsafe of [
    { apiPort: 3002 },
    { apiPort: 3012 },
    { apiHost: '0.0.0.0' },
    { memoryStore: false },
    { nodeEnv: 'production' },
    { projectRoot: resolve('.') },
  ]) {
    await assert.rejects(
      maybeStartOwnerLocalNoteLab({ ...isolated, ...unsafe, enabled: true }),
      /isolated local note lab/,
    );
  }
});

test('an isolated Host starts one exact fixture and supplies its own browser connector', async (t) => {
  // A real browser's physical exit can exceed the default Host deadline; deadline semantics are tested separately.
  const lab = await maybeStartOwnerLocalNoteLab({ ...isolated, enabled: true }, 10_000);
  assert.ok(lab);
  t.after(() => lab.close());
  assert.match(lab.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(lab.profile.url, lab.url);
  const handle = await lab.connector.open(lab.profile, new AbortController().signal);
  const port = createCdpPageActionPort(handle.page, lab.profile.spec);
  try {
    const snapshot = await port.inspect();
    assert.equal(snapshot.url, lab.url);
    assert.equal(snapshot.readback, JSON.stringify({ open: false, note: '', deleted: false }));
  } finally {
    await port.close();
    await handle.close();
  }
  await lab.close();
  await assert.rejects(lab.connector.open(lab.profile, new AbortController().signal), /unavailable/);
});

test('resource cleanup starts both closes, bounds a hang, and remains single-flight', async () => {
  const { createOwnerLocalNoteCleanup } = await import('../src/domains/concierge/live/host/owner-local-note-lab.ts');
  assert.equal(typeof createOwnerLocalNoteCleanup, 'function');
  let browserCloses = 0;
  let serverCloses = 0;
  const browser = {
    close() {
      browserCloses++;
      return new Promise(() => {});
    },
  };
  const server = {
    close() {
      serverCloses++;
    },
  };
  const close = createOwnerLocalNoteCleanup(() => browser, server, 20);
  const first = close();
  await assert.rejects(first, /cleanup unconfirmed/);
  await assert.rejects(close(), /cleanup unconfirmed/);
  assert.equal(browserCloses, 1);
  assert.equal(serverCloses, 1);
});

test('initialization failure with a hung server close settles as cleanup unconfirmed', async (t) => {
  const fakeRoot = await mkdtemp(join(tmpdir(), 'f317-host-cleanup-'));
  t.after(() => rm(fakeRoot, { recursive: true, force: true }));
  const scripts = join(fakeRoot, 'scripts/f317-page-action');
  await mkdir(scripts, { recursive: true });
  await writeFile(join(fakeRoot, '.git'), 'gitdir: fake\n');
  const key = `f317Close${Date.now()}`;
  globalThis[key] = 0;
  t.after(() => {
    delete globalThis[key];
  });
  await writeFile(
    join(scripts, 'serve.mjs'),
    `export async function startFixtureServer() { return { url: 'http://127.0.0.1:5227/', server: { close() { globalThis[${JSON.stringify(key)}]++; } } }; }`,
  );
  await writeFile(
    join(scripts, 'browser-binary.mjs'),
    "export async function loadChromium() { throw new Error('browser unavailable'); }\n",
  );
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('probe deadline exceeded')), 3_000);
  });
  try {
    await assert.rejects(
      Promise.race([maybeStartOwnerLocalNoteLab({ ...isolated, projectRoot: fakeRoot, enabled: true }), deadline]),
      /cleanup unconfirmed/,
    );
  } finally {
    clearTimeout(timer);
  }
  assert.equal(globalThis[key], 1);
});

test('a fixture cleanup budget waits for owned settlement after the default deadline', async (t) => {
  const fakeRoot = await mkdtemp(join(tmpdir(), 'f317-host-late-cleanup-'));
  t.after(() => rm(fakeRoot, { recursive: true, force: true }));
  const scripts = join(fakeRoot, 'scripts/f317-page-action');
  await mkdir(scripts, { recursive: true });
  await writeFile(join(fakeRoot, '.git'), 'gitdir: fake\n');
  const key = `f317LateClose${Date.now()}`;
  globalThis[key] = { closes: 0, settled: false };
  t.after(() => delete globalThis[key]);
  await writeFile(
    join(scripts, 'serve.mjs'),
    `export async function startFixtureServer() {
      return { url: 'http://127.0.0.1:5227/', server: { close(callback) {
        const state = globalThis[${JSON.stringify(key)}];
        state.closes++;
        setTimeout(() => { state.settled = true; callback(); }, 2100);
      } } };
    }`,
  );
  await writeFile(
    join(scripts, 'browser-binary.mjs'),
    "export async function loadChromium() { throw new Error('browser unavailable'); }\n",
  );
  await assert.rejects(
    maybeStartOwnerLocalNoteLab({ ...isolated, projectRoot: fakeRoot, enabled: true }, 10_000),
    /^Error: browser unavailable$/,
  );
  assert.deepEqual(globalThis[key], { closes: 1, settled: true });
});

test('invalid fixture cleanup budgets are refused before starting an owned server', async (t) => {
  const fakeRoot = await mkdtemp(join(tmpdir(), 'f317-host-invalid-cleanup-'));
  t.after(() => rm(fakeRoot, { recursive: true, force: true }));
  const scripts = join(fakeRoot, 'scripts/f317-page-action');
  await mkdir(scripts, { recursive: true });
  await writeFile(join(fakeRoot, '.git'), 'gitdir: fake\n');
  const key = `f317InvalidClose${Date.now()}`;
  globalThis[key] = 0;
  t.after(() => delete globalThis[key]);
  await writeFile(
    join(scripts, 'serve.mjs'),
    `export async function startFixtureServer() { globalThis[${JSON.stringify(key)}]++; return { url: 'http://127.0.0.1:5227/', server: { close(callback) { callback(); } } }; }`,
  );
  await writeFile(
    join(scripts, 'browser-binary.mjs'),
    "export async function loadChromium() { throw new Error('browser unavailable'); }\n",
  );
  for (const budget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 60_001])
    await assert.rejects(
      maybeStartOwnerLocalNoteLab({ ...isolated, projectRoot: fakeRoot, enabled: true }, budget),
      /cleanup deadline must be a positive integer at most 60000ms/,
    );
  assert.equal(globalThis[key], 0);
});
