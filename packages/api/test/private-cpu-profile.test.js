import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { savePrivateCpuProfile } = await import('../dist/infrastructure/telemetry/cpu/private-cpu-profile.js');
const profile = { nodes: [], samples: [], startTime: 0, endTime: 1000 };

test('private originals refuse symlink/public directories and omit over-budget profiles', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task229-private-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  const outside = join(root, 'outside');
  await mkdir(data);
  await mkdir(outside);
  await symlink(outside, join(data, 'private-cpu-profiles'));
  await assert.rejects(savePrivateCpuProfile(data, profile), /private_cpu_directory_invalid/);
  assert.deepEqual(await readdir(outside), []);
  await rm(join(data, 'private-cpu-profiles'));
  await mkdir(join(data, 'private-cpu-profiles'));
  await chmod(join(data, 'private-cpu-profiles'), 0o755);
  await assert.rejects(savePrivateCpuProfile(data, profile), /private_cpu_directory_invalid/);
  assert.deepEqual(await readdir(join(data, 'private-cpu-profiles')), []);
  const oversized = { ...profile, nodes: Array(65537).fill({ children: [] }) };
  assert.deepEqual(await savePrivateCpuProfile(join(root, 'never-created'), oversized), {
    status: 'omitted',
    reason: 'profile_budget',
  });
  assert.deepEqual((await readdir(root)).sort(), ['data', 'outside']);
});
