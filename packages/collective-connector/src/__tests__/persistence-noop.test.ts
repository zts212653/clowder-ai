import { chmod, lstat, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { hostRouteConfigSchema } from '../host-route-state.js';
import { ConnectorPersistence } from '../persistence.js';

const io = vi.hoisted(() => ({
  failRename: false,
  delayedRename: undefined as { arrived(): void; resume: Promise<void> } | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      if (io.failRename) throw Object.assign(new Error('Injected durable writer outage'), { code: 'EIO' });
      const delay = io.delayedRename;
      if (delay) {
        io.delayedRename = undefined;
        delay.arrived();
        await delay.resume;
      }
      return actual.rename(...args);
    }),
  };
});

let directory: string;
let persistence: ConnectorPersistence;
beforeEach(async () => {
  io.failRename = false;
  io.delayedRename = undefined;
  directory = await mkdtemp(join(tmpdir(), 'f290-connector-noop-'));
  await chmod(directory, 0o700);
  persistence = await ConnectorPersistence.open(directory);
});
afterEach(async () => {
  io.failRename = false;
  io.delayedRename = undefined;
  await rm(directory, { recursive: true, force: true });
});

async function seedRoute(owner = 'fixture-owner') {
  await persistence.transaction((state) => {
    state.hostRoutes.cafe = hostRouteConfigSchema.parse({
      connectionId: 'cafe',
      localOwnerUserId: owner,
      defaultIngressThreadId: 'fixture-thread',
      humanNotificationThreadId: 'fixture-notifications',
      agentRoutes: {},
      revision: 1,
      updatedAt: new Date(0).toISOString(),
    });
  });
}

it('an unchanged serialized state on exact private disk keeps inode and nanosecond mtime unchanged', async () => {
  await seedRoute();
  const before = await lstat(persistence.filePath, { bigint: true });
  const bytes = await readFile(persistence.filePath);
  expect(await persistence.transaction(() => 'classification-result')).toBe('classification-result');
  const after = await lstat(persistence.filePath, { bigint: true });
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeNs).toBe(before.mtimeNs);
  expect(after.ctimeNs).toBe(before.ctimeNs);
  expect(await readFile(persistence.filePath)).toEqual(bytes);
});

it('real changes are readable from the reopened producer before the transaction acknowledges', async () => {
  await seedRoute();
  const before = await lstat(persistence.filePath);
  const result = await persistence.transaction((state) => {
    state.hostRoutes.cafe.revision += 1;
    return 'committed';
  });
  expect(result).toBe('committed');
  expect((await lstat(persistence.filePath)).ino).not.toBe(before.ino);
  expect((await ConnectorPersistence.open(directory)).snapshot()).toEqual(persistence.snapshot());
  expect(persistence.snapshot().hostRoutes.cafe.revision).toBe(2);
});

for (const external of ['deleted', 'corrupt', 'different-valid-state']) {
  it(`an empty transaction repairs ${external} backing state instead of silently skipping`, async () => {
    await seedRoute();
    const canonical = await readFile(persistence.filePath);
    if (external === 'deleted') await rm(persistence.filePath);
    if (external === 'corrupt') await writeFile(persistence.filePath, '{broken', { mode: 0o600 });
    if (external === 'different-valid-state') {
      const other = persistence.snapshot();
      await writeFile(persistence.filePath, JSON.stringify({ ...other, hostRoutes: {} }), { mode: 0o600 });
    }
    await persistence.transaction(() => undefined);
    expect(await readFile(persistence.filePath)).toEqual(canonical);
    expect((await ConnectorPersistence.open(directory)).snapshot()).toEqual(persistence.snapshot());
  });
}

it('disk equality compares exact bytes rather than lossy UTF8 decoded strings', async () => {
  await seedRoute('fixture-owner-�');
  const canonical = await readFile(persistence.filePath);
  const position = canonical.indexOf(Buffer.from('�'));
  expect(position).toBeGreaterThan(0);
  const invalid = Buffer.concat([
    canonical.subarray(0, position),
    Buffer.from([0xff]),
    canonical.subarray(position + 3),
  ]);
  expect(invalid.toString('utf8')).toBe(canonical.toString('utf8'));
  await writeFile(persistence.filePath, invalid, { mode: 0o600 });
  await persistence.transaction(() => undefined);
  expect(await readFile(persistence.filePath)).toEqual(canonical);
});

for (const weak of ['file', 'directory']) {
  it(`an unchanged draft cannot skip ${weak} privacy violations`, async () => {
    const snapshot = persistence.snapshot();
    await chmod(weak === 'file' ? persistence.filePath : directory, weak === 'file' ? 0o644 : 0o755);
    const refusal = persistence.transaction(() => undefined);
    await expect(refusal).rejects.toThrow(/private|permission|mode/);
    await expect(refusal).rejects.not.toThrow(directory);
    expect(persistence.snapshot()).toEqual(snapshot);
    await chmod(weak === 'file' ? persistence.filePath : directory, weak === 'file' ? 0o600 : 0o700);
  });
}

for (const linked of ['file', 'directory']) {
  it(`an unchanged draft rejects a ${linked} symlink without following its target`, async () => {
    const bytes = await readFile(persistence.filePath);
    const target = join(directory, 'target.json');
    if (linked === 'file') {
      await rename(persistence.filePath, target);
      await symlink(target, persistence.filePath);
    } else {
      const moved = `${directory}-original`;
      await rename(directory, moved);
      await symlink(moved, directory);
      try {
        const refusal = persistence.transaction(() => undefined);
        await expect(refusal).rejects.toThrow(/private|regular directory/);
        await expect(refusal).rejects.not.toThrow(directory);
      } finally {
        await rm(directory);
        await rename(moved, directory);
      }
      return;
    }
    const refusal = persistence.transaction(() => undefined);
    await expect(refusal).rejects.toThrow(/private|regular file/);
    await expect(refusal).rejects.not.toThrow(directory);
    expect((await lstat(persistence.filePath)).isSymbolicLink()).toBe(true);
    expect(await readFile(target)).toEqual(bytes);
  });
}

it('serial transactions observe only committed predecessors while a genuine write is in flight', async () => {
  await seedRoute();
  const before = persistence.snapshot();
  let signalArrival!: () => void;
  const arrived = new Promise<void>((resolve) => {
    signalArrival = resolve;
  });
  let release!: () => void;
  io.delayedRename = {
    arrived: signalArrival,
    resume: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  const first = persistence.transaction((state) => {
    state.hostRoutes.cafe.revision += 1;
  });
  await arrived;
  let secondStarted = false;
  const second = persistence.transaction((state) => {
    secondStarted = true;
    expect(state.hostRoutes.cafe.revision).toBe(2);
    state.hostRoutes.cafe.revision += 1;
  });
  await Promise.resolve();
  expect(secondStarted).toBe(false);
  expect(persistence.snapshot()).toEqual(before);
  expect(JSON.parse(await readFile(persistence.filePath, 'utf8'))).toEqual(before);
  release();
  await Promise.all([first, second]);
  expect(persistence.snapshot().hostRoutes.cafe.revision).toBe(3);
  expect((await ConnectorPersistence.open(directory)).snapshot()).toEqual(persistence.snapshot());
});

it('a failed durable write cannot publish draft memory or acknowledge success, and the next transaction recovers', async () => {
  await seedRoute();
  const before = persistence.snapshot();
  const bytes = await readFile(persistence.filePath);
  io.failRename = true;
  await expect(
    persistence.transaction((state) => {
      state.hostRoutes.cafe.revision += 1;
    }),
  ).rejects.toMatchObject({ code: 'EIO' });
  expect(persistence.snapshot()).toEqual(before);
  expect(await readFile(persistence.filePath)).toEqual(bytes);
  io.failRename = false;
  await persistence.transaction((state) => {
    state.hostRoutes.cafe.revision += 1;
  });
  expect(persistence.snapshot().hostRoutes.cafe.revision).toBe(2);
  expect((await ConnectorPersistence.open(directory)).snapshot()).toEqual(persistence.snapshot());
});
