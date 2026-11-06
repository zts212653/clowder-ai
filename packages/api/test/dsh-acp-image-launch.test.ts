import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { createAcpServiceForConfig } from '../src/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import {
  prepareDshSecretPatch,
  verifyDshSecretPatch,
} from '../src/domains/cats/services/agents/providers/dsh-secret-patch.js';

test('DSH launch pins the selected route before initialize without editing the native profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-launch-'));
  try {
    const profile = join(root, 'home/profiles/acp');
    await mkdir(profile, { recursive: true });
    const original = '- id: acp\n  config: {provider: gateway, model: text-model}\n';
    await writeFile(join(profile, 'cordis.patch.yml'), original);
    const args = ['--profile', 'acp'];
    const first = await prepareDshSecretPatch('dsh', args, root, '["deepseek-official","deepseek-flash"]');
    const patch = first.at(-1);
    assert.ok(patch);
    const content = await readFile(patch, 'utf8');
    assert.deepEqual(parse(content).find((row: { id?: string }) => row.id === 'acp').config, {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    });
    assert.equal(verifyDshSecretPatch(patch), true);
    assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), original);
    assert.deepEqual(args, ['--profile', 'acp']);

    const second = await prepareDshSecretPatch('dsh', args, root, '["gateway","text-model"]');
    assert.notEqual(second.at(-1), patch, 'model switches must change the pool spawn signature');
    assert.equal(await readFile(patch, 'utf8'), content, 'a new route preserves the prior launch generation');
    const nextPatch = second.at(-1);
    assert.ok(nextPatch);
    assert.equal(verifyDshSecretPatch(nextPatch), true);
    await writeFile(patch, await readFile(nextPatch, 'utf8'));
    assert.equal(verifyDshSecretPatch(patch), false, 'a valid template cannot retarget an existing launch generation');
    await writeFile(patch, `${content}\n- insert: [{name: attacker}]\n`);
    assert.equal(verifyDshSecretPatch(patch), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DSH launch inherits native defaults when no model is selected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-default-'));
  try {
    const args = await prepareDshSecretPatch('dsh', ['--profile', 'acp'], root, '');
    const patch = args.at(-1);
    assert.ok(patch);
    const rows = parse(await readFile(patch, 'utf8'));
    assert.equal(rows.find((row: { id?: string }) => row.id === 'acp').config, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cached Node DSH entrypoints receive the route while generic ACP commands stay unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-node-'));
  try {
    const pkg = join(root, 'node_modules/@deepseek-ai/dsh');
    await mkdir(join(pkg, 'lib'), { recursive: true });
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }));
    const entry = join(pkg, 'lib/bin.js');
    await writeFile(entry, '// installed DSH fixture; never executed');
    const original = [entry, '--profile', 'acp'];
    const prepared = await prepareDshSecretPatch(process.execPath, original, root, '["p","vision"]');
    assert.notDeepEqual(prepared, original);
    const patch = prepared.at(-1);
    assert.ok(patch);
    assert.equal(verifyDshSecretPatch(patch), true);
    assert.deepEqual(await prepareDshSecretPatch('custom-acp', ['--acp'], root, 'opaque-model-id'), ['--acp']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DSH factory reuses an unchanged route and replaces the pool when the selected model changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-factory-'));
  const pools = new Map();
  const services = [];
  try {
    const command = join(root, process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
    await writeFile(command, '// fixture; no child process is started');
    const base = {
      projectRoot: root,
      bootstrapRoot: join(root, 'bootstrap'),
      profileId: 'dsh-images',
      acpConfig: { command, startupArgs: ['--profile', 'acp'] },
      poolRegistry: pools,
      log: { info() {}, warn() {} },
      config: {
        id: 'dsh-images',
        name: 'DSH',
        displayName: 'DSH',
        clientId: 'acp',
        configurationSource: 'native_tool',
        mcpSupport: false,
        color: { primary: '#111111', secondary: '#eeeeee' },
        avatar: '/fixture.png',
        mentionPatterns: ['@dsh-images'],
        roleDescription: 'fixture',
      },
    };
    const vision = '["deepseek-official","deepseek-flash"]';
    const first = await createAcpServiceForConfig({ ...base, effectiveModel: vision });
    assert.ok(first);
    services.push(first);
    const original = pools.get(base.profileId);
    const launch = original.clientFactory().config;
    const rows = parse(await readFile(launch.args.at(-1), 'utf8'));
    assert.equal(rows.find((row: { id?: string }) => row.id === 'acp').config?.model, 'deepseek-flash');
    const same = await createAcpServiceForConfig({ ...base, effectiveModel: vision });
    assert.ok(same);
    services.push(same);
    assert.equal(pools.get(base.profileId), original);
    const changed = await createAcpServiceForConfig({ ...base, effectiveModel: '["gateway","text-model"]' });
    assert.ok(changed);
    services.push(changed);
    assert.notEqual(pools.get(base.profileId), original);
  } finally {
    await Promise.all(services.map((service) => service.disposeHostService()));
    await Promise.all([...pools.values()].map((pool) => pool.closeAll()));
    await rm(root, { recursive: true, force: true });
  }
});
