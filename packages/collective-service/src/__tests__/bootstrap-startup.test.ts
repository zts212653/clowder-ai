import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertWindowsPrivatePath } from '../../../collective-connector/src/windows-private-path.js';
import { startCollectiveServer } from '../http-server.js';
import { digestSecret } from '../persistence.js';
import { CollectiveServiceStore } from '../store.js';

const directories: string[] = [];
const publicUrl = 'http://127.0.0.1:55231/';
const now = Date.parse('2026-10-01T00:00:00Z');
const faults = vi.hoisted(() => ({
  stateFailure: '',
  failLink: false,
  failPublish: false,
  unsupportedPublication: false,
  writes: [] as string[],
  exclusiveCollisions: [] as string[],
  pauseFirstWrite: undefined as { reached: () => void; resume: Promise<void> } | undefined,
  pausePendingRead: undefined as { reached: () => void; resume: Promise<void> } | undefined,
}));
vi.mock('@cat-cafe/shared/node-private-fs', async (load) => {
  const actual = await load<typeof import('@cat-cafe/shared/node-private-fs')>();
  function failBeforeWrite(path: string) {
    if (faults.failLink && path.includes('owner-bootstrap.url.pending.'))
      throw new Error('fixture link commit failure');
    if (faults.failPublish && path.endsWith('owner-bootstrap.url')) throw new Error('fixture link publication failure');
    if (!path.endsWith('collective-service.json')) return;
    if (faults.unsupportedPublication) {
      throw Object.assign(new Error('fixture hard links unsupported'), { code: 'EPERM' });
    }
    if (faults.stateFailure === 'before') throw new Error('fixture state commit failure');
  }
  async function write(path: string, contents: string, exclusive: boolean) {
    faults.writes.push(path);
    const pause = faults.pauseFirstWrite;
    if (pause) {
      faults.pauseFirstWrite = undefined;
      pause.reached();
      await pause.resume;
    }
    failBeforeWrite(path);
    const stateFile = path.endsWith('collective-service.json');
    const created = exclusive
      ? await actual.writeExclusivePrivate(path, contents)
      : await actual.writeAtomicPrivate(path, contents);
    if (created === false) faults.exclusiveCollisions.push(path);
    if (stateFile && faults.stateFailure === 'after') throw new Error('fixture post-rename failure');
    return created;
  }
  return {
    ...actual,
    writeAtomicPrivate: (path: string, contents: string) => write(path, contents, false),
    writeExclusivePrivate: (path: string, contents: string) => write(path, contents, true),
    readPrivateFile: async (path: string) => {
      const pause = faults.pausePendingRead;
      if (pause && path.includes('owner-bootstrap.url.pending.')) {
        faults.pausePendingRead = undefined;
        pause.reached();
        await pause.resume;
      }
      return actual.readPrivateFile(path);
    },
  };
});
afterEach(async () => {
  faults.stateFailure = '';
  faults.failLink = false;
  faults.failPublish = false;
  faults.unsupportedPublication = false;
  faults.pauseFirstWrite = undefined;
  faults.pausePendingRead = undefined;
  faults.writes.length = 0;
  faults.exclusiveCollisions.length = 0;
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'collective-bootstrap-startup-'));
  directories.push(parent);
  const dataDirectory = join(parent, 'private');
  if (process.platform === 'win32') await assertWindowsPrivatePath(dataDirectory, 'directory', true);
  return { dataDirectory, now: () => now, bootstrapUrl: publicUrl };
}
async function linkSecret(directory: string) {
  const url = new URL((await readFile(join(directory, 'owner-bootstrap.url'), 'utf8')).trim());
  const secret = new URLSearchParams(url.hash.slice(1)).get('bootstrap');
  if (!secret) throw new Error('fixture link has no bootstrap');
  return secret;
}
async function pendingLinks(directory: string) {
  return (await readdir(directory)).filter((name) => name.startsWith('owner-bootstrap.url.pending.'));
}

describe('bootstrap startup persistence and diagnosis without reissue', () => {
  it.each([
    'failed-state-commit',
    'winner-consumed',
  ])('preserves the winner of competing first starts when the delayed attempt has %s', async (schedule) => {
    const options = await fixture();
    let reached!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    faults.pauseFirstWrite = {
      reached,
      resume: new Promise<void>((resolve) => {
        resume = resolve;
      }),
    };
    const delayed = CollectiveServiceStore.open(options);
    await paused;
    const winner = await CollectiveServiceStore.open(options);
    const secret = await linkSecret(options.dataDirectory);
    if (schedule === 'winner-consumed') {
      await winner.store.consumeBootstrap({ secret, displayName: 'winner' });
    }
    const statePath = join(options.dataDirectory, 'collective-service.json');
    const linkPath = join(options.dataDirectory, 'owner-bootstrap.url');
    const stateBefore = await readFile(statePath, 'utf8');
    const linkBefore = await readFile(linkPath, 'utf8');
    if (schedule === 'failed-state-commit') faults.stateFailure = 'before';
    resume();
    // Either a safe refusal or loading the winner is acceptable; the loser
    // must not have any side effect on already committed identity/credentials.
    await delayed.catch(() => undefined);
    faults.stateFailure = '';
    expect(await readFile(statePath, 'utf8')).toBe(stateBefore);
    expect(await readFile(linkPath, 'utf8')).toBe(linkBefore);
    expect(await pendingLinks(options.dataDirectory)).toEqual(
      schedule === 'failed-state-commit' ? [expect.any(String)] : [],
    );
    if (schedule === 'winner-consumed') expect(faults.exclusiveCollisions).toContain(statePath);
    const reopened = await CollectiveServiceStore.open(options);
    expect(reopened.store.serviceInstanceId).toBe(winner.store.serviceInstanceId);
    if (schedule === 'failed-state-commit') {
      expect(() => reopened.store.authorizeProviderSetup({ bootstrapSecret: secret })).not.toThrow();
    } else {
      expect(reopened.store.getMetadata().bootstrapNeeded).toBe(false);
    }
  });
  it('stages the first link before exclusive state publication and preserves both on a normal restart', async () => {
    const options = await fixture();
    const first = await CollectiveServiceStore.open(options);
    const secret = await linkSecret(options.dataDirectory);
    expect(secret).toBe(first.bootstrapSecret);
    expect(faults.writes.map((path) => path.split(/[\\/]/).at(-1))).toEqual([
      expect.stringMatching(/^owner-bootstrap\.url\.pending\./),
      'collective-service.json',
      'owner-bootstrap.url',
    ]);
    expect(await pendingLinks(options.dataDirectory)).toEqual([]);
    const before = await readFile(join(options.dataDirectory, 'collective-service.json'), 'utf8');
    const reopened = await CollectiveServiceStore.open(options);
    expect(reopened.bootstrapSecret).toBeUndefined();
    expect(await linkSecret(options.dataDirectory)).toBe(secret);
    expect(await readFile(join(options.dataDirectory, 'collective-service.json'), 'utf8')).toBe(before);
  });
  it.each([
    'missing',
    'malformed',
    'mismatched',
  ])('diagnoses an unconsumed %s link without changing any records or provider files', async (failure) => {
    const options = await fixture();
    await CollectiveServiceStore.open(options);
    const statePath = join(options.dataDirectory, 'collective-service.json');
    const before = await readFile(statePath, 'utf8');
    const providerPaths = ['github-app-setup.json', 'github-app-oauth.json'].map((name) =>
      join(options.dataDirectory, name),
    );
    const providerHistory = '{"fixture":"existing provider history"}\n';
    for (const path of providerPaths) await writeFile(path, providerHistory, { mode: 0o600 });
    const path = join(options.dataDirectory, 'owner-bootstrap.url');
    if (failure === 'missing') await rm(path);
    if (failure === 'malformed') await writeFile(path, 'invalid\n');
    if (failure === 'mismatched') await writeFile(path, `${publicUrl}#bootstrap=wrong\n`);
    const linkBefore = failure === 'missing' ? undefined : await readFile(path, 'utf8');
    faults.writes.length = 0;
    await expect(CollectiveServiceStore.open(options)).rejects.toMatchObject({
      code: 'BOOTSTRAP_UNRECOVERABLE',
      message: expect.stringMatching(/does not support automatic recovery; data is preserved; see #1563/),
    });
    expect(faults.writes).toEqual([]);
    expect(await readFile(statePath, 'utf8')).toBe(before);
    if (failure === 'missing') await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    else expect(await readFile(path, 'utf8')).toBe(linkBefore);
    for (const path of providerPaths) expect(await readFile(path, 'utf8')).toBe(providerHistory);
  });
  it('listens after an unchanged matching link expires while rejecting its use at existing auth boundaries', async () => {
    const options = await fixture();
    await CollectiveServiceStore.open(options);
    const statePath = join(options.dataDirectory, 'collective-service.json');
    const linkPath = join(options.dataDirectory, 'owner-bootstrap.url');
    const stateBefore = await readFile(statePath, 'utf8');
    const linkBefore = await readFile(linkPath, 'utf8');
    const secret = await linkSecret(options.dataDirectory);
    faults.writes.length = 0;
    const reopened = await CollectiveServiceStore.open({ ...options, now: () => now + 86_400_001 });
    const server = await startCollectiveServer({
      store: reopened.store,
      host: '127.0.0.1',
      port: 0,
      allowedHostOrigins: [],
    });
    try {
      expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
      await expect(reopened.store.consumeBootstrap({ secret, displayName: 'owner' })).rejects.toMatchObject({
        code: 'BOOTSTRAP_EXPIRED',
      });
      await expect(
        Promise.resolve().then(() => reopened.store.authorizeProviderSetup({ bootstrapSecret: secret })),
      ).rejects.toMatchObject({ code: 'BOOTSTRAP_EXPIRED' });
      expect(faults.writes).toEqual([]);
      expect(await readFile(statePath, 'utf8')).toBe(stateBefore);
      expect(await readFile(linkPath, 'utf8')).toBe(linkBefore);
    } finally {
      await server.close();
    }
  });
  it('refuses an orphan with existing domain state through the same unchanged-state path', async () => {
    const options = await fixture();
    await CollectiveServiceStore.open(options);
    const statePath = join(options.dataDirectory, 'collective-service.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.humans.orphan = { humanId: 'orphan', displayName: 'existing', createdAt: new Date(now).toISOString() };
    const contents = `${JSON.stringify(state)}\n`;
    await writeFile(statePath, contents);
    await rm(join(options.dataDirectory, 'owner-bootstrap.url'));
    await expect(CollectiveServiceStore.open(options)).rejects.toMatchObject({ code: 'BOOTSTRAP_UNRECOVERABLE' });
    expect(await readFile(statePath, 'utf8')).toBe(contents);
    await expect(readFile(join(options.dataDirectory, 'owner-bootstrap.url'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('leaves an initialized owner unchanged when its consumed link has been removed', async () => {
    const options = await fixture();
    const first = await CollectiveServiceStore.open(options);
    const owner = await first.store.consumeBootstrap({
      secret: await linkSecret(options.dataDirectory),
      displayName: 'owner',
    });
    await rm(join(options.dataDirectory, 'owner-bootstrap.url'));
    const before = await readFile(join(options.dataDirectory, 'collective-service.json'), 'utf8');
    const reopened = await CollectiveServiceStore.open(options);
    expect(reopened.bootstrapSecret).toBeUndefined();
    expect((await reopened.store.requireSession(owner.sessionToken)).human.displayName).toBe('owner');
    expect(await readFile(join(options.dataDirectory, 'collective-service.json'), 'utf8')).toBe(before);
  });
  it('does not create state when the first link cannot be persisted', async () => {
    const options = await fixture();
    faults.failLink = true;
    await expect(CollectiveServiceStore.open(options)).rejects.toThrow('fixture link commit failure');
    await expect(readFile(join(options.dataDirectory, 'collective-service.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('retains only its pending link after a failing state commit without claiming success', async () => {
    const options = await fixture();
    faults.stateFailure = 'before';
    await expect(CollectiveServiceStore.open(options)).rejects.toThrow('fixture state commit failure');
    expect(await pendingLinks(options.dataDirectory)).toHaveLength(1);
    await expect(readFile(join(options.dataDirectory, 'owner-bootstrap.url'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(join(options.dataDirectory, 'collective-service.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('reopens after a post-publication state failure by delivering its original pending credential', async () => {
    const options = await fixture();
    faults.stateFailure = 'after';
    await expect(CollectiveServiceStore.open(options)).rejects.toThrow('fixture post-rename failure');
    const [pending] = await pendingLinks(options.dataDirectory);
    const pendingContents = await readFile(join(options.dataDirectory, pending), 'utf8');
    const secret = new URLSearchParams(new URL(pendingContents.trim()).hash.slice(1)).get('bootstrap');
    const before = await readFile(join(options.dataDirectory, 'collective-service.json'), 'utf8');
    faults.stateFailure = '';
    faults.writes.length = 0;
    const reopened = await CollectiveServiceStore.open(options);
    expect(reopened.bootstrapSecret).toBeUndefined();
    expect(reopened.store.serviceInstanceId).toBe(JSON.parse(before).serviceInstanceId);
    expect(await linkSecret(options.dataDirectory)).toBe(secret);
    expect(await readFile(join(options.dataDirectory, 'collective-service.json'), 'utf8')).toBe(before);
    expect(faults.writes).toEqual([join(options.dataDirectory, 'owner-bootstrap.url')]);
    expect(await pendingLinks(options.dataDirectory)).toEqual([]);
  });
  it('completes interrupted first-link publication with health 200 and the original credential', async () => {
    const options = await fixture();
    faults.failPublish = true;
    await expect(CollectiveServiceStore.open(options)).rejects.toThrow('fixture link publication failure');
    const [pending] = await pendingLinks(options.dataDirectory);
    const originalLink = await readFile(join(options.dataDirectory, pending), 'utf8');
    const stateBefore = await readFile(join(options.dataDirectory, 'collective-service.json'), 'utf8');
    faults.failPublish = false;
    const reopened = await CollectiveServiceStore.open(options);
    const server = await startCollectiveServer({
      store: reopened.store,
      host: '127.0.0.1',
      port: 0,
      allowedHostOrigins: [],
    });
    try {
      expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
      expect(await readFile(join(options.dataDirectory, 'owner-bootstrap.url'), 'utf8')).toBe(originalLink);
      expect(await readFile(join(options.dataDirectory, 'collective-service.json'), 'utf8')).toBe(stateBefore);
      const secret = await linkSecret(options.dataDirectory);
      expect(() =>
        reopened.store.authorizeProviderSetup({
          bootstrapSecret: secret,
        }),
      ).not.toThrow();
      expect(await pendingLinks(options.dataDirectory)).toEqual([]);
    } finally {
      await server.close();
    }
  });
  it('rejects a missing formal link with an unrelated pending credential without any writes', async () => {
    const options = await fixture();
    await CollectiveServiceStore.open(options);
    const formal = join(options.dataDirectory, 'owner-bootstrap.url');
    await rm(formal);
    const stateBefore = await readFile(join(options.dataDirectory, 'collective-service.json'), 'utf8');
    const pending = join(
      options.dataDirectory,
      `owner-bootstrap.url.pending.${digestSecret(JSON.parse(stateBefore).bootstrap.tokenDigest)}`,
    );
    await writeFile(pending, `${publicUrl}#bootstrap=unrelated\n`, { mode: 0o600 });
    faults.writes.length = 0;
    await expect(CollectiveServiceStore.open(options)).rejects.toMatchObject({ code: 'BOOTSTRAP_UNRECOVERABLE' });
    expect(faults.writes).toEqual([]);
    expect(await readFile(pending, 'utf8')).toBe(`${publicUrl}#bootstrap=unrelated\n`);
    expect(await readFile(join(options.dataDirectory, 'collective-service.json'), 'utf8')).toBe(stateBefore);
    await expect(readFile(formal)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('never replaces an invalid formal link even when a matching pending credential remains', async () => {
    const options = await fixture();
    faults.failPublish = true;
    await expect(CollectiveServiceStore.open(options)).rejects.toThrow();
    faults.failPublish = false;
    const formal = join(options.dataDirectory, 'owner-bootstrap.url');
    await writeFile(formal, 'invalid\n', { mode: 0o600 });
    faults.writes.length = 0;
    await expect(CollectiveServiceStore.open(options)).rejects.toMatchObject({ code: 'BOOTSTRAP_UNRECOVERABLE' });
    expect(faults.writes).toEqual([]);
    expect(await readFile(formal, 'utf8')).toBe('invalid\n');
    expect(await pendingLinks(options.dataDirectory)).toHaveLength(1);
  });
  it('fails closed without formal files on unsupported exclusive state publication', async () => {
    const options = await fixture();
    faults.unsupportedPublication = true;
    await expect(CollectiveServiceStore.open(options)).rejects.toMatchObject({ code: 'EPERM' });
    for (const name of ['collective-service.json', 'owner-bootstrap.url']) {
      await expect(readFile(join(options.dataDirectory, name))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
  it('accepts concurrent delivery when another opener removes the pending file before its read', async () => {
    const options = await fixture();
    faults.failPublish = true;
    await expect(CollectiveServiceStore.open(options)).rejects.toThrow();
    faults.failPublish = false;
    let reached!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    faults.pausePendingRead = {
      reached,
      resume: new Promise<void>((resolve) => {
        resume = resolve;
      }),
    };
    const delayed = CollectiveServiceStore.open(options);
    await paused;
    const winner = await CollectiveServiceStore.open(options);
    const stateBefore = await readFile(join(options.dataDirectory, 'collective-service.json'), 'utf8');
    const linkBefore = await readFile(join(options.dataDirectory, 'owner-bootstrap.url'), 'utf8');
    resume();
    expect((await delayed).store.serviceInstanceId).toBe(winner.store.serviceInstanceId);
    expect(await readFile(join(options.dataDirectory, 'collective-service.json'), 'utf8')).toBe(stateBefore);
    expect(await readFile(join(options.dataDirectory, 'owner-bootstrap.url'), 'utf8')).toBe(linkBefore);
    expect(await pendingLinks(options.dataDirectory)).toEqual([]);
  });
});
