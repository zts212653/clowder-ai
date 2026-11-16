import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCapabilityTruth } from '../dist/agent-hooks/capability-truth.js';
import { getAgentHookStatus, syncAgentHooks } from '../dist/agent-hooks/index.js';
import { resolveStartupProjectRoot } from '../dist/utils/startup-root.js';

async function fixture(t, declared = true) {
  const root = await mkdtemp(join(tmpdir(), 'agent-hook-capability-roots-'));
  const binary = join(root, 'runtime');
  const authority = join(root, 'workspace');
  const project = join(root, 'project');
  const home = join(root, 'home');
  const env = {
    CAT_CAFE_CONFIG_ROOT: declared ? authority : undefined,
    CAT_CAFE_RUNTIME_ROOT: binary,
    CAT_CAFE_WORKSPACE_ROOT: authority,
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  for (const directory of [binary, authority, project]) {
    await mkdir(join(directory, '.cat-cafe'), { recursive: true });
  }
  await mkdir(home);
  const hooks = join(binary, '.claude/hooks/user-level');
  await mkdir(hooks, { recursive: true });
  for (const script of ['session-start-recall.sh', 'session-stop-check.sh']) {
    await writeFile(join(hooks, script), '#!/bin/bash\nexit 0\n');
  }
  for (const directory of [binary, authority]) {
    await mkdir(join(directory, 'cat-cafe-skills'));
    await writeFile(join(directory, 'cat-cafe-skills/manifest.yaml'), 'version: 1\n');
  }
  const entry = (id, source) => ({
    id,
    type: 'mcp',
    source,
    enabled: true,
    globalEnabled: true,
    mcpServer: { command: 'echo', args: [id] },
  });
  const file = (directory) => join(directory, '.cat-cafe/capabilities.json');
  await writeFile(file(authority), JSON.stringify({ version: 2, capabilities: [entry('canonical-mcp', 'external')] }));
  await writeFile(file(binary), JSON.stringify({ version: 2, capabilities: [entry('runtime-only', 'cat-cafe')] }));
  await writeFile(file(project), JSON.stringify({ version: 2, capabilities: [] }));
  return { binary, authority, project, home, file };
}

test('packaged skill sources retain their checkout while MCP configuration uses persistent authority', async (t) => {
  const f = await fixture(t);
  const truth = await resolveCapabilityTruth(f.binary);
  assert.equal(truth.root, f.binary);
  assert.equal(truth.skillsSource, join(f.binary, 'cat-cafe-skills'));
  assert.equal(truth.mcpRoot, f.authority);
});

async function checkExternalProject(t, declared) {
  const f = await fixture(t, declared);
  // Model the running API's module location without writing to the checkout.
  if (!declared) process.env.CAT_CAFE_RUNTIME_ROOT = resolveStartupProjectRoot();
  const binaryBefore = await readFile(f.file(f.binary), 'utf8');
  const authorityBefore = await readFile(f.file(f.authority), 'utf8');
  const options = { projectRoot: f.binary, targetRoot: f.home, capabilityProjectRoot: f.project };

  const before = await getAgentHookStatus(options);
  assert.equal(before.targets.find((target) => target.name === 'mcp')?.status, 'stale');

  const synced = await syncAgentHooks({ ...options, ownerAuthorized: true });
  assert.equal(synced.targets.find((target) => target.name === 'mcp')?.status, 'configured');
  const config = JSON.parse(await readFile(f.file(f.project), 'utf8'));
  assert.deepEqual(
    config.capabilities.filter((entry) => entry.type === 'mcp').map((entry) => entry.id),
    ['canonical-mcp'],
  );
  assert.equal(await readFile(f.file(f.binary), 'utf8'), binaryBefore);
  assert.equal(await readFile(f.file(f.authority), 'utf8'), authorityBefore);
}

for (const declared of [true, false]) {
  test(`host-scope Skills keep the runtime inventory (${declared ? 'declared' : 'runtime mapping'})`, async (t) => {
    const f = await fixture(t, declared);
    for (const [directory, names] of [
      [f.binary, ['runtime-skill']],
      [f.authority, ['runtime-skill', 'workspace-only-skill']],
    ]) {
      for (const name of names) {
        const source = join(directory, 'cat-cafe-skills', name);
        await mkdir(source);
        await writeFile(join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill\n---\n`);
      }
    }
    const options = { projectRoot: f.binary, targetRoot: f.home };
    const health = await getAgentHookStatus(options);
    assert.equal(health.targets.find((target) => target.name === 'skills')?.reason, '1 new');

    const synced = await syncAgentHooks({ ...options, ownerAuthorized: true });
    assert.equal(synced.targets.find((target) => target.name === 'skills')?.status, 'configured');
    assert.equal(
      await realpath(join(f.authority, '.claude/skills/runtime-skill')),
      await realpath(join(f.binary, 'cat-cafe-skills/runtime-skill')),
    );
    const config = JSON.parse(await readFile(f.file(f.authority), 'utf8'));
    assert.equal(
      config.capabilities.some((entry) => entry.type === 'skill' && entry.id === 'workspace-only-skill'),
      false,
    );
  });

  test(`external-project health and sync use persistent MCP truth (${declared ? 'declared' : 'runtime mapping'})`, async (t) => {
    await checkExternalProject(t, declared);
  });

  test(`host-scope health and sync target the persistent configuration (${declared ? 'declared' : 'runtime mapping'})`, async (t) => {
    const f = await fixture(t, declared);
    const binaryBefore = await readFile(f.file(f.binary), 'utf8');
    const authorityBefore = await readFile(f.file(f.authority), 'utf8');
    const options = { projectRoot: f.binary, targetRoot: f.home };

    const health = await getAgentHookStatus(options);
    assert.equal(health.targets.find((target) => target.name === 'mcp')?.status, 'configured');
    await syncAgentHooks({ ...options, ownerAuthorized: true });
    assert.equal(await readFile(f.file(f.binary), 'utf8'), binaryBefore);
    assert.equal(await readFile(f.file(f.authority), 'utf8'), authorityBefore);
  });
}
