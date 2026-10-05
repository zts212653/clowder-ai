import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { signEditToken, writeWorkspaceFile } from '../src/domains/workspace/workspace-edit.js';
import { uploadWorkspaceFile } from '../src/domains/workspace/workspace-file-mutations.js';
import { readWorkspaceFilePreview } from '../src/domains/workspace/workspace-file-read.js';
import { WorkspaceWritebackService } from '../src/domains/workspace/writeback/service.js';

const digest = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'f309-writeback-'));
  const path = join(root, 'work.png');
  await writeFile(path, Buffer.from([0, 1, 255]));
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'human',
    resolveWorktreeRoot: async () => ({ root, canonicalWorktreeId: 'work' }),
  });
  const options = { source, databasePath: join(root, 'owner.sqlite'), proofDirectory: join(root, 'proofs') };
  const command = {
    acceptOperationId: '00000000-0000-4000-8000-000000000001',
    requestId: 'request-one',
    candidateRef: 'published:result:2',
    locator: { worktreeId: 'work', path: 'work.png' },
    baseRevision: digest(Buffer.from([0, 1, 255])),
    bytes: Buffer.from([0, 2, 254]),
  };
  const principal = { userId: 'human', editSessionToken: signEditToken('work') };
  return { root, path, options, command, principal, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('F063 binary accept is explicit, byte-CAS bound, durable and replay never overwrites later edits', async () => {
  const f = await fixture();
  let service = new WorkspaceWritebackService(f.options);
  try {
    assert.deepEqual(await readFile(f.path), Buffer.from([0, 1, 255]));
    await assert.rejects(service.accept(f.command, { ...f.principal, userId: 'other' }));
    await assert.rejects(service.accept(f.command, { ...f.principal, editSessionToken: signEditToken('elsewhere') }));
    const applied = await service.accept(f.command, f.principal);
    assert.equal(applied.state, 'applied');
    assert.equal(applied.writtenRevision, digest(f.command.bytes));
    await writeFile(f.path, 'later owner edit');
    service.close();
    service = new WorkspaceWritebackService(f.options);
    const replay = await service.accept(f.command, f.principal);
    assert.equal(replay.receiptRef, applied.receiptRef);
    assert.equal(replay.writtenRevision, applied.writtenRevision);
    assert.equal(replay.currentRevision, digest('later owner edit'));
    assert.equal(await readFile(f.path, 'utf8'), 'later owner edit');
    await assert.rejects(service.accept({ ...f.command, candidateRef: 'another' }, f.principal), /operation_reused/);
  } finally {
    service.close();
    await f.cleanup();
  }
});

for (const point of ['prepared', 'renamed'] as const) {
  test(`F063 survives ${point} response loss with one exact accept receipt`, async () => {
    const f = await fixture();
    let service = new WorkspaceWritebackService({
      ...f.options,
      checkpoint: async (at) => {
        if (at === point) throw new Error('lost process');
      },
    });
    try {
      await assert.rejects(service.accept(f.command, f.principal), /lost process/);
      assert.deepEqual(await readFile(f.path), point === 'prepared' ? Buffer.from([0, 1, 255]) : f.command.bytes);
      service.close();
      service = new WorkspaceWritebackService(f.options);
      assert.equal((await service.accept(f.command, f.principal)).state, 'applied');
      assert.deepEqual(await readFile(f.path), f.command.bytes);
    } finally {
      service.close();
      await f.cleanup();
    }
  });
}

test('same bytes in a replacement inode cannot prove unknown accept; in-place later edit is separate drift', async () => {
  for (const replace of [true, false]) {
    const f = await fixture();
    let service = new WorkspaceWritebackService({
      ...f.options,
      checkpoint: async (at) => {
        if (at === 'renamed') throw new Error('lost process');
      },
    });
    try {
      await assert.rejects(service.accept(f.command, f.principal));
      if (replace) {
        await writeFile(join(f.root, 'external'), f.command.bytes);
        await rename(join(f.root, 'external'), f.path);
      } else await writeFile(f.path, 'external in-place');
      service.close();
      service = new WorkspaceWritebackService(f.options);
      const recovered = await service.accept(f.command, f.principal);
      assert.equal(recovered.state, replace ? 'unknown' : 'applied');
      assert.equal(recovered.currentRevision, digest(replace ? f.command.bytes : 'external in-place'));
      if (!replace) {
        assert.equal(recovered.writtenRevision, digest(f.command.bytes));
        assert.notEqual(recovered.writtenRevision, recovered.currentRevision);
        assert.equal('newRevision' in recovered, false);
      }
    } finally {
      service.close();
      await f.cleanup();
    }
  }
});

test('drift before acceptance is conflict and preserves both candidate and current file', async () => {
  const f = await fixture();
  const service = new WorkspaceWritebackService(f.options);
  try {
    await writeFile(f.path, 'external');
    const result = await service.accept(f.command, f.principal);
    assert.equal(result.state, 'conflict');
    assert.equal(result.currentRevision, digest('external'));
    assert.equal(await readFile(f.path, 'utf8'), 'external');
  } finally {
    service.close();
    await f.cleanup();
  }
});

test('F063 upload waits for accept; legacy text writer and preview reject lossy UTF-8', async () => {
  const f = await fixture();
  const prepared = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const service = new WorkspaceWritebackService({
    ...f.options,
    checkpoint: async (at) => {
      if (at === 'prepared') {
        prepared.resolve();
        await release.promise;
      }
    },
  });
  try {
    const accepting = service.accept(f.command, f.principal);
    await prepared.promise;
    let uploaded = false;
    const uploading = uploadWorkspaceFile(f.path, Buffer.from('later upload'), true).then(() => {
      uploaded = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(uploaded, false);
    release.resolve();
    assert.equal((await accepting).state, 'applied');
    await uploading;
    assert.equal(await readFile(f.path, 'utf8'), 'later upload');
    const invalid = Buffer.from([0x66, 0x80]);
    const textPath = join(f.root, 'source.txt');
    await writeFile(textPath, invalid);
    assert.equal((await readWorkspaceFilePreview(textPath)).binary, true);
    await assert.rejects(writeWorkspaceFile(textPath, 'replacement', digest(invalid).slice(7)));
    const source = f.options.source;
    await assert.rejects(
      source.readText({
        principal: f.principal,
        locator: { worktreeId: 'work', path: 'source.txt' },
        expectedRevision: digest(invalid),
      }),
      /unsupported_text/,
    );
    assert.deepEqual(await readFile(textPath), invalid);
  } finally {
    release.resolve();
    service.close();
    await f.cleanup();
  }
});
