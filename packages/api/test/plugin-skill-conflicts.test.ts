import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readCapabilitiesConfig, writeCapabilitiesConfig } from '../src/config/capabilities/capability-orchestrator.js';
import { PluginRuntimeCarrierRouter } from '../src/domains/plugin/carrier/runtime-carrier.js';
import {
  activateDeclaredSkills,
  removeDeclaredSkills,
  removeDeclaredStaticResources,
} from '../src/domains/plugin/declared/declared-static-resources.js';
import { PluginSkillResources } from '../src/domains/plugin/declared/plugin-skill-resources.js';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-skill-conflicts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'package');
  await mkdir(join(packageRoot, 'skills/guide'), { recursive: true });
  await writeFile(join(packageRoot, 'skills/guide/SKILL.md'), '# Plugin guide\n');
  const manifest = {
    pluginId: 'fixture.skills',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Skills',
    features: [],
    contributions: [{ type: 'skill', id: 'guide', path: 'skills/guide' }],
  };
  const admission = {
    instance: { pluginId: manifest.pluginId },
    packageRecord: { pluginId: manifest.pluginId, packageDigest: 'sha512-fixture', manifest },
  };
  const host = {
    projectRoot: root,
    configuration: {},
    packages: {
      resolveInstalledPackage: async () => ({
        rootDir: packageRoot,
        manifest,
        verifyIntegrity: async () => {},
        release: async () => {},
      }),
    },
  };
  await writeCapabilitiesConfig(root, {
    version: 2,
    capabilities: [],
    defaultMountRules: [
      { name: 'claude', path: '.claude/skills', enabled: true },
      { name: 'codex', path: '.codex/skills', enabled: true },
      { name: 'gemini', path: '.gemini/skills', enabled: false },
      { name: 'kimi', path: '.kimi/skills', enabled: true },
    ],
  });
  const clients = ['claude', 'codex', 'kimi'];
  for (const client of clients) await mkdir(join(root, `.${client}/skills`), { recursive: true });
  const activate = () => activateDeclaredSkills(admission as never, host as never);
  const resources = new PluginSkillResources(host);
  return { root, manifest, host, activate, clients, resources, pkg: admission.packageRecord as never };
}

test('filesystem conflicts retain skill registration without failing plugin activation', async (t) => {
  const f = await fixture(t);
  for (const client of f.clients) {
    await mkdir(join(f.root, `.${client}/skills/guide`));
    await writeFile(join(f.root, `.${client}/skills/guide/user.md`), 'user content');
  }
  await f.activate();
  const registered = (await readCapabilitiesConfig(f.root))!.capabilities.find((c) => c.id === 'guide');
  assert.equal(registered?.pluginId, f.manifest.pluginId);
  for (const client of f.clients)
    assert.equal(await readFile(join(f.root, `.${client}/skills/guide/user.md`), 'utf8'), 'user content');
});

test('legacy dangling built-in links migrate and uninstall removes all plugin mounts', async (t) => {
  const f = await fixture(t);
  for (const client of f.clients) await symlink('../../cat-cafe-skills/guide', join(f.root, `.${client}/skills/guide`));
  await f.activate();
  for (const client of f.clients) {
    const link = join(f.root, `.${client}/skills/guide`);
    assert.notEqual(await readlink(link), '../../cat-cafe-skills/guide');
    assert.equal(await readFile(join(link, 'SKILL.md'), 'utf8'), '# Plugin guide\n');
  }
  await removeDeclaredSkills(f.manifest.pluginId, f.host as never);
  for (const client of f.clients)
    await assert.rejects(readlink(join(f.root, `.${client}/skills/guide`)), { code: 'ENOENT' });
  await f.activate();
  assert.equal(await readFile(join(f.root, '.codex/skills/guide/SKILL.md'), 'utf8'), '# Plugin guide\n');
});

test('repeated activation retains managed mounts when another client conflicts', async (t) => {
  const f = await fixture(t);
  await f.activate();
  await rm(join(f.root, '.kimi/skills/guide'));
  await mkdir(join(f.root, '.kimi/skills/guide'));
  await f.activate();
  assert.equal(await readFile(join(f.root, '.claude/skills/guide/SKILL.md'), 'utf8'), '# Plugin guide\n');
});

test('a built-in name collision leaves the existing skill intact without failing the plugin', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'cat-cafe-skills/guide'), { recursive: true });
  await writeFile(join(f.root, 'cat-cafe-skills/guide/SKILL.md'), '# Built-in guide');
  await f.activate();
  assert.equal(await readFile(join(f.root, 'cat-cafe-skills/guide/SKILL.md'), 'utf8'), '# Built-in guide');
});

test('owner resolves one filesystem conflict with a durable backup and without unmounting other clients', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, '.codex/skills/guide'));
  await writeFile(join(f.root, '.codex/skills/guide/user.md'), 'keep this');
  await f.activate();
  const [conflict] = await f.resources.read(f.pkg);
  assert.equal(conflict?.mountPointId, 'codex');
  assert.equal(conflict.canResolve, true);
  const result = await f.resources.resolve(f.pkg, conflict);
  assert.equal(await readFile(join(f.root, result.backupPath, 'user.md'), 'utf8'), 'keep this');
  assert.equal(await readFile(join(f.root, '.codex/skills/guide/SKILL.md'), 'utf8'), '# Plugin guide\n');
  assert.equal(await readFile(join(f.root, '.claude/skills/guide/SKILL.md'), 'utf8'), '# Plugin guide\n');
  assert.deepEqual(await f.resources.read(f.pkg), []);
});

test('a changed blocker rejects a stale conflict choice without touching user content', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.codex/skills/guide'), 'old');
  await f.activate();
  const [conflict] = await f.resources.read(f.pkg);
  await writeFile(join(f.root, '.codex/skills/guide'), 'new user content');
  await assert.rejects(f.resources.resolve(f.pkg, conflict), /changed/);
  assert.equal(await readFile(join(f.root, '.codex/skills/guide'), 'utf8'), 'new user content');
});

test('explicit source choice resolves a registered built-in collision while preserving its files', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'cat-cafe-skills/guide'), { recursive: true });
  await writeFile(join(f.root, 'cat-cafe-skills/guide/SKILL.md'), '# Existing source');
  await f.activate();
  const [conflict] = await f.resources.read(f.pkg);
  assert.equal(conflict.mountPointId, 'registration');
  await f.resources.resolve(f.pkg, conflict);
  assert.equal(await readFile(join(f.root, 'cat-cafe-skills/guide/SKILL.md'), 'utf8'), '# Existing source');
  assert.equal(await readFile(join(f.root, '.claude/skills/guide/SKILL.md'), 'utf8'), '# Plugin guide\n');
  assert.deepEqual(await f.resources.read(f.pkg), []);
  await f.activate();
});

test('read-only deployments cannot mutate shared skill mounts', async (t) => {
  const f = await fixture(t);
  const resources = new PluginSkillResources({ ...f.host, persistCapabilities: false });
  assert.deepEqual(await resources.read(f.pkg), []);
  await assert.rejects(
    resources.resolve(f.pkg, { skillName: 'guide', mountPointId: 'codex', revision: 'x' }),
    /read-only/,
  );
});

test('the real carrier keeps unrelated runtime work alive when all skill clients conflict', async (t) => {
  const f = await fixture(t);
  for (const client of f.clients) await mkdir(join(f.root, `.${client}/skills/guide`));
  const calls: string[] = [];
  const inventory = {
    snapshot: async () => ({
      packages: [f.pkg],
      instances: [{ pluginInstanceId: 'pi_skills', pluginId: f.manifest.pluginId, packageDigest: 'sha512-fixture' }],
      grants: [],
    }),
  };
  const router = new PluginRuntimeCarrierRouter(inventory as never, f.host as never);
  router.register({
    claims: () => true,
    start: async () => {
      calls.push('start');
    },
    stop: async () => {
      calls.push('stop');
    },
    invoke: async () => 'runtime result',
  } as never);
  await router.start('pi_skills');
  assert.deepEqual(calls, ['start']);
  assert.equal(await router.invoke('pi_skills', 'fixture.read', {}), 'runtime result');
  assert.equal((await router.skillResources!.read(f.pkg)).length, 3);
  await router.stop('pi_skills', 'owner_uninstalled');
  assert.deepEqual(calls, ['start', 'stop']);
  for (const client of f.clients)
    assert.equal((await lstat(join(f.root, `.${client}/skills/guide`))).isDirectory(), true);
});

test('package verification errors still fail activation instead of becoming skill warnings', async (t) => {
  const f = await fixture(t);
  f.host.packages.resolveInstalledPackage = async () => {
    throw new Error('package integrity failed');
  };
  await assert.rejects(f.activate(), /integrity failed/);
});

test('uninstall cleans legacy dangling links even if activation never registered the skill', async (t) => {
  const f = await fixture(t);
  for (const client of f.clients) await symlink('../../cat-cafe-skills/guide', join(f.root, `.${client}/skills/guide`));
  await removeDeclaredStaticResources(f.manifest.pluginId, f.host as never, f.manifest as never);
  for (const client of f.clients)
    await assert.rejects(readlink(join(f.root, `.${client}/skills/guide`)), { code: 'ENOENT' });
});

test('legacy source=plugin metadata reports its real owner and requires an explicit source choice', async (t) => {
  const f = await fixture(t);
  const previous = (await readCapabilitiesConfig(f.root))!;
  const oldSource = join(f.root, 'other-plugin');
  await mkdir(join(oldSource, 'guide'), { recursive: true });
  await writeFile(join(oldSource, 'guide/SKILL.md'), '# Other plugin');
  previous.capabilities.push({
    id: 'guide',
    type: 'skill',
    source: 'plugin',
    pluginId: 'fixture.other',
    enabled: true,
    skillsSource: oldSource,
    mountPaths: ['claude'],
  });
  await writeCapabilitiesConfig(f.root, previous);
  await f.activate();
  const [conflict] = await f.resources.read(f.pkg);
  assert.equal(conflict.sourcePluginId, 'fixture.other');
  assert.equal((await readCapabilitiesConfig(f.root))!.capabilities.filter((c) => c.id === 'guide').length, 1);
  await f.resources.resolve(f.pkg, conflict);
  assert.equal(await readFile(join(oldSource, 'guide/SKILL.md'), 'utf8'), '# Other plugin');
  assert.equal(
    (await readCapabilitiesConfig(f.root))!.capabilities.find((c) => c.id === 'guide')?.pluginId,
    f.manifest.pluginId,
  );
});

test(
  'failed registration switch restores both the previous owner and exact mount state',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  async (t) => {
    const f = await fixture(t);
    await f.activate();
    const oldSource = join(f.root, 'old-plugin');
    await mkdir(join(oldSource, 'guide'), { recursive: true });
    await writeFile(join(oldSource, 'guide/SKILL.md'), '# Previous guide');
    const previous = (await readCapabilitiesConfig(f.root))!;
    const entry = previous.capabilities.find((c) => c.id === 'guide')!;
    Object.assign(entry, { pluginId: 'fixture.old', skillsSource: oldSource, mountPaths: ['claude', 'codex'] });
    await writeCapabilitiesConfig(f.root, previous);
    for (const client of f.clients) await rm(join(f.root, `.${client}/skills/guide`));
    await symlink(join(oldSource, 'guide'), join(f.root, '.claude/skills/guide'));
    const [conflict] = await f.resources.read(f.pkg);
    await chmod(join(f.root, '.codex/skills'), 0o555);
    try {
      await assert.rejects(f.resources.resolve(f.pkg, conflict), { code: 'EACCES' });
      assert.deepEqual(await readCapabilitiesConfig(f.root), previous);
      assert.equal(await readFile(join(f.root, '.claude/skills/guide/SKILL.md'), 'utf8'), '# Previous guide');
      for (const client of ['codex', 'kimi'])
        await assert.rejects(lstat(join(f.root, `.${client}/skills/guide`)), { code: 'ENOENT' });
    } finally {
      await chmod(join(f.root, '.codex/skills'), 0o755);
    }
  },
);

test(
  'failed registration switch also removes newly created mounts that were absent before',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  async (t) => {
    const f = await fixture(t);
    await f.activate();
    const oldSource = join(f.root, 'old-plugin');
    await mkdir(join(oldSource, 'guide'), { recursive: true });
    await writeFile(join(oldSource, 'guide/SKILL.md'), '# Previous guide');
    const previous = (await readCapabilitiesConfig(f.root))!;
    const entry = previous.capabilities.find((c) => c.id === 'guide')!;
    Object.assign(entry, { pluginId: 'fixture.old', skillsSource: oldSource, mountPaths: ['claude', 'codex'] });
    await writeCapabilitiesConfig(f.root, previous);
    for (const client of f.clients) await rm(join(f.root, `.${client}/skills/guide`));

    const [conflict] = await f.resources.read(f.pkg);
    await chmod(join(f.root, '.codex/skills'), 0o555);
    try {
      await assert.rejects(f.resources.resolve(f.pkg, conflict), { code: 'EACCES' });
      assert.deepEqual(await readCapabilitiesConfig(f.root), previous);
      await assert.rejects(lstat(join(f.root, '.claude/skills/guide')), { code: 'ENOENT' });
      for (const client of ['codex', 'kimi'])
        await assert.rejects(lstat(join(f.root, `.${client}/skills/guide`)), { code: 'ENOENT' });
    } finally {
      await chmod(join(f.root, '.codex/skills'), 0o755);
    }
  },
);

test('legacy duplicate registration is reported even when the plugin row appears first', async (t) => {
  const f = await fixture(t);
  await f.activate();
  const config = (await readCapabilitiesConfig(f.root))!;
  config.capabilities.push({ id: 'guide', type: 'skill', source: 'cat-cafe', enabled: true });
  await writeCapabilitiesConfig(f.root, config);
  const [conflict] = await f.resources.read(f.pkg);
  assert.equal(conflict.mountPointId, 'registration');
  await f.resources.resolve(f.pkg, conflict);
  assert.equal((await readCapabilitiesConfig(f.root))!.capabilities.filter((c) => c.id === 'guide').length, 1);
  assert.deepEqual(await f.resources.read(f.pkg), []);
});
