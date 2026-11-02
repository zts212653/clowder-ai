import assert from 'node:assert/strict';
import fs, { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CANONICAL_TOOL_REGISTRY } from '../src/canonical-server-tools.js';
import { applyReadonlyFilter, registerCollabToolset } from '../src/server-toolsets.js';
import { readMemberImage } from '../src/tools/member-image-tools.js';

let dir: string;
let root: string;
let oldRoots: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'member-image-client-'));
  root = join(dir, 'workspace');
  await mkdir(root);
  oldRoots = process.env.ALLOWED_WORKSPACE_DIRS;
  process.env.ALLOWED_WORKSPACE_DIRS = root;
});
afterEach(async () => {
  mock.restoreAll();
  syncBuiltinESMExports();
  if (oldRoots === undefined) delete process.env.ALLOWED_WORKSPACE_DIRS;
  else process.env.ALLOWED_WORKSPACE_DIRS = oldRoots;
  await rm(dir, { recursive: true, force: true });
});
test('reads only the exact bounded regular file in existing allowed roots', async () => {
  const path = join(root, 'image.png');
  await writeFile(path, Buffer.from('fixture-bytes'));
  const image = await readMemberImage(path);
  assert.equal(image.sourcePath, await realpath(path));
  assert.deepEqual(image.bytes, Buffer.from('fixture-bytes'));
});
test('rejects outside roots and symlink escapes, including a symlinked directory', async () => {
  const outside = join(dir, 'secret.png');
  await writeFile(outside, 'secret');
  await symlink(outside, join(root, 'link.png'));
  await symlink(dir, join(root, 'outside'));
  const opener = mock.method(fs, 'open');
  syncBuiltinESMExports();
  for (const path of [outside, join(root, 'link.png'), join(root, 'outside', 'secret.png')]) {
    await assert.rejects(readMemberImage(path), /Access denied/);
  }
  assert.equal(opener.mock.callCount(), 0, 'forbidden files must not even be opened');
});

test('a parent-directory swap cannot make the checked descriptor read outside bytes', async () => {
  const parent = join(root, 'render');
  const forbidden = join(dir, 'forbidden');
  await mkdir(parent);
  await mkdir(forbidden);
  await writeFile(join(parent, 'image.png'), 'allowed');
  await writeFile(join(forbidden, 'image.png'), 'secret outside bytes');
  const originalOpen = fs.open;
  let reads = 0;
  mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    await rename(parent, `${parent}-old`);
    await symlink(forbidden, parent);
    const file = await originalOpen(...args);
    mock.method(file, 'read', () => {
      reads += 1;
      throw new Error('outside bytes were read');
    });
    return file;
  });
  syncBuiltinESMExports();
  await assert.rejects(readMemberImage(join(parent, 'image.png')), /Access denied|ELOOP/);
  assert.equal(reads, 0);
});

test('swapping a parent before stat then restoring it after open cannot return outside bytes', async () => {
  const parent = join(root, 'render');
  const forbidden = join(dir, 'forbidden');
  await mkdir(parent);
  await mkdir(forbidden);
  await writeFile(join(parent, 'image.png'), 'allowed');
  await writeFile(join(forbidden, 'image.png'), 'secret outside bytes');
  const originalStat = fs.stat;
  const originalOpen = fs.open;
  mock.method(fs, 'stat', async (...args: Parameters<typeof fs.stat>) => {
    await rename(parent, `${parent}-old`);
    await symlink(forbidden, parent);
    return originalStat(...args);
  });
  mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    try {
      return await originalOpen(...args);
    } finally {
      await rm(parent);
      await rename(`${parent}-old`, parent);
    }
  });
  syncBuiltinESMExports();
  await assert.rejects(readMemberImage(join(parent, 'image.png')), /Access denied|ELOOP/);
});
test('rejects relative paths, directories and oversized files', async () => {
  await assert.rejects(readMemberImage('image.png'), /absolute/);
  await assert.rejects(readMemberImage(root), /regular file/);
  const path = join(root, 'big.png');
  await writeFile(path, Buffer.alloc(10 * 1024 * 1024 + 1));
  await assert.rejects(readMemberImage(path), /too large/);
});

test('Linux descriptor verification rejects an outside target before reading any bytes', async () => {
  const path = join(root, 'image.png');
  const outside = join(dir, 'outside.png');
  await writeFile(path, 'allowed');
  await writeFile(outside, 'outside');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(platform);
  const originalRealpath = fs.realpath;
  const originalOpen = fs.open;
  let descriptorChecks = 0;
  let reads = 0;
  mock.method(fs, 'realpath', async (...args: Parameters<typeof fs.realpath>) => {
    if (typeof args[0] === 'string' && args[0].startsWith('/proc/self/fd/')) {
      descriptorChecks += 1;
      return originalRealpath(outside);
    }
    return originalRealpath(...args);
  });
  mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const file = await originalOpen(...args);
    mock.method(file, 'read', () => {
      reads += 1;
      throw new Error('unexpected read');
    });
    return file;
  });
  syncBuiltinESMExports();
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    await assert.rejects(readMemberImage(path), /Access denied/);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
  assert.equal(descriptorChecks, 1);
  assert.equal(reads, 0);
});

test('the canonical member publication entry is exposed only to the full member profile', async () => {
  const tool = CANONICAL_TOOL_REGISTRY.find((row) => row.name === 'cat_cafe_publish_image');
  assert.ok(tool);
  assert.deepEqual(tool.policy.runtimeProfiles, ['full']);
  assert.equal(tool.serverFamily, 'collab');
  for (const env of [
    { readonly: true },
    { readonly: true, hasAgentKey: true, agentKeyUnion: true },
    { desktopMode: 'live-companion' },
  ]) {
    assert.equal(applyReadonlyFilter([tool], env).length, 0);
  }
  assert.equal(applyReadonlyFilter([tool], { readonly: false }).length, 1);
  // Private principals use the actual durable allowlist consumed at registration;
  // collectiveWork/participation are not ToolsetEnv fields and never selected a profile.
  const server = new McpServer({ name: 'restricted-member', version: '1' });
  registerCollabToolset(server, { allowedToolNames: ['cat_cafe_list_threads'] });
  const client = new Client({ name: 'restricted-reader', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    assert.equal(
      (await client.listTools()).tools.some((entry) => entry.name === tool.name),
      false,
    );
    const denied = await client.callTool({ name: tool.name, arguments: {} });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /not found/i);
  } finally {
    await client.close();
    await server.close();
  }
});
