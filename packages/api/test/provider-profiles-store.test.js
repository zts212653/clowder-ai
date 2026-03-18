// @ts-check

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const {
  readProviderProfiles,
  createProviderProfile,
  activateProviderProfile,
  deleteProviderProfile,
  getProviderProfile,
  resolveAnthropicRuntimeProfile,
  resolveRuntimeProviderProfile,
} = await import('../dist/config/provider-profiles.js');
const { createRuntimeCat } = await import('../dist/config/runtime-cat-catalog.js');

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  const dir = join('/tmp', `provider-profile-store-${prefix}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('provider profile store', () => {
  /** @type {string} */ let projectRoot;

  beforeEach(async () => {
    projectRoot = await makeTmpDir('case');
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('bootstraps with builtin OAuth providers', async () => {
    const data = await readProviderProfiles(projectRoot);
    assert.equal(data.activeProfileId, 'claude-oauth');
    assert.deepEqual(
      data.providers.map((profile) => ({
        id: profile.id,
        authType: profile.authType,
        builtin: profile.builtin,
      })),
      [
        { id: 'claude-oauth', authType: 'oauth', builtin: true },
        { id: 'codex-oauth', authType: 'oauth', builtin: true },
        { id: 'gemini-oauth', authType: 'oauth', builtin: true },
      ],
    );
  });

  it('stores api_key secret in secrets file but not in meta file', async () => {
    const created = await createProviderProfile(projectRoot, {
      provider: 'anthropic',
      name: 'sponsor',
      mode: 'api_key',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-secret-test',
      setActive: true,
    });
    assert.equal(created.authType, 'api_key');
    assert.equal(created.protocol, 'anthropic');
    assert.equal(created.displayName, 'sponsor');

    const metaPath = join(projectRoot, '.cat-cafe', 'provider-profiles.json');
    const secretsPath = join(projectRoot, '.cat-cafe', 'provider-profiles.secrets.local.json');
    const [metaRaw, secretsRaw] = await Promise.all([readFile(metaPath, 'utf-8'), readFile(secretsPath, 'utf-8')]);

    assert.ok(!metaRaw.includes('sk-secret-test'), 'meta should not contain api key');
    assert.ok(secretsRaw.includes('sk-secret-test'), 'secrets should contain api key');
  });

  it('activate + resolve returns active api_key runtime payload', async () => {
    const created = await createProviderProfile(projectRoot, {
      provider: 'anthropic',
      name: 'sponsor2',
      mode: 'api_key',
      baseUrl: 'https://api.sponsor.dev',
      apiKey: 'sk-sponsor-2',
      setActive: false,
    });

    await activateProviderProfile(projectRoot, 'anthropic', created.id);
    const data = await readProviderProfiles(projectRoot);
    assert.equal(data.activeProfileId, created.id);
    const runtime = await resolveAnthropicRuntimeProfile(projectRoot);
    assert.equal(runtime.mode, 'api_key');
    assert.equal(runtime.baseUrl, 'https://api.sponsor.dev');
    assert.equal(runtime.apiKey, 'sk-sponsor-2');
  });

  it('deleting active profile falls back to subscription profile', async () => {
    const sponsor = await createProviderProfile(projectRoot, {
      provider: 'anthropic',
      name: 'to-delete',
      mode: 'api_key',
      baseUrl: 'https://api.sponsor.dev',
      apiKey: 'sk-delete',
      setActive: true,
    });
    await deleteProviderProfile(projectRoot, 'anthropic', sponsor.id);

    const data = await readProviderProfiles(projectRoot);
    assert.equal(data.activeProfileId, 'claude-oauth');
    const runtime = await resolveAnthropicRuntimeProfile(projectRoot);
    assert.equal(runtime.mode, 'subscription');
    assert.equal(runtime.apiKey, undefined);
  });

  it('rejects deleting a profile that is still bound to a runtime cat', async () => {
    const templateRaw = await readFile(join(process.cwd(), '..', '..', 'cat-template.json'), 'utf-8');
    await writeFile(join(projectRoot, 'cat-template.json'), templateRaw, 'utf-8');

    const sponsor = await createProviderProfile(projectRoot, {
      provider: 'anthropic',
      name: 'bound-sponsor',
      mode: 'api_key',
      baseUrl: 'https://api.bound.dev',
      apiKey: 'sk-bound',
      setActive: false,
    });

    await createRuntimeCat(projectRoot, {
      catId: 'bound-runtime-cat',
      breedId: 'bound-runtime-cat',
      name: '绑定猫',
      displayName: '绑定猫',
      avatar: '/avatars/bound.png',
      color: { primary: '#64748b', secondary: '#cbd5e1' },
      mentionPatterns: ['@bound-runtime-cat'],
      providerProfileId: sponsor.id,
      roleDescription: '依赖专属账号',
      personality: '稳定',
      provider: 'anthropic',
      defaultModel: 'claude-opus-4-6',
      mcpSupport: false,
      cli: { command: 'claude', outputFormat: 'stream-json' },
    });

    await assert.rejects(
      deleteProviderProfile(projectRoot, 'anthropic', sponsor.id),
      /still referenced by runtime cats: bound-runtime-cat/i,
    );
  });

  it('keeps anthropic active profile when activating non-anthropic profiles', async () => {
    const anthropicSponsor = await createProviderProfile(projectRoot, {
      provider: 'anthropic',
      name: 'anthropic-sponsor',
      mode: 'api_key',
      baseUrl: 'https://api.anthropic-sponsor.dev',
      apiKey: 'sk-anthropic-sponsor',
      setActive: true,
    });
    const openaiSponsor = await createProviderProfile(projectRoot, {
      provider: 'openai',
      name: 'codex-sponsor',
      mode: 'api_key',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.codex-sponsor.dev',
      apiKey: 'sk-codex-sponsor',
      setActive: false,
    });

    await activateProviderProfile(projectRoot, 'openai', openaiSponsor.id);
    const data = await readProviderProfiles(projectRoot);
    assert.equal(data.activeProfileId, anthropicSponsor.id);
    assert.equal(data.activeProfileIds.anthropic, anthropicSponsor.id);
    assert.equal(data.activeProfileIds.openai, openaiSponsor.id);

    const anthropicRuntime = await resolveAnthropicRuntimeProfile(projectRoot);
    assert.equal(anthropicRuntime.mode, 'api_key');
    assert.equal(anthropicRuntime.baseUrl, 'https://api.anthropic-sponsor.dev');
    assert.equal(anthropicRuntime.apiKey, 'sk-anthropic-sponsor');

    const openaiRuntime = await resolveRuntimeProviderProfile(projectRoot, 'openai');
    assert.equal(openaiRuntime?.mode, 'api_key');
    assert.equal(openaiRuntime?.baseUrl, 'https://api.codex-sponsor.dev');
    assert.equal(openaiRuntime?.apiKey, 'sk-codex-sponsor');
  });

  it('readProviderProfiles does not rewrite files when state is already normalized', async () => {
    await readProviderProfiles(projectRoot);
    const metaPath = join(projectRoot, '.cat-cafe', 'provider-profiles.json');
    const secretsPath = join(projectRoot, '.cat-cafe', 'provider-profiles.secrets.local.json');
    const [metaBefore, secretsBefore] = await Promise.all([stat(metaPath), stat(secretsPath)]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await readProviderProfiles(projectRoot);

    const [metaAfter, secretsAfter] = await Promise.all([stat(metaPath), stat(secretsPath)]);
    assert.equal(metaAfter.mtimeMs, metaBefore.mtimeMs);
    assert.equal(secretsAfter.mtimeMs, secretsBefore.mtimeMs);
  });

  it('getProviderProfile does not rewrite files when state is already normalized', async () => {
    const created = await createProviderProfile(projectRoot, {
      provider: 'anthropic',
      name: 'readonly-check',
      mode: 'subscription',
    });
    const metaPath = join(projectRoot, '.cat-cafe', 'provider-profiles.json');
    const secretsPath = join(projectRoot, '.cat-cafe', 'provider-profiles.secrets.local.json');
    const [metaBefore, secretsBefore] = await Promise.all([stat(metaPath), stat(secretsPath)]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const profile = await getProviderProfile(projectRoot, 'anthropic', created.id);

    assert.ok(profile);
    assert.equal(profile?.displayName, 'readonly-check');
    const [metaAfter, secretsAfter] = await Promise.all([stat(metaPath), stat(secretsPath)]);
    assert.equal(metaAfter.mtimeMs, metaBefore.mtimeMs);
    assert.equal(secretsAfter.mtimeMs, secretsBefore.mtimeMs);
  });

  it('rejects blank profile name', async () => {
    await assert.rejects(
      createProviderProfile(projectRoot, {
        provider: 'anthropic',
        name: '   ',
        mode: 'subscription',
      }),
      /name is required/,
    );
  });

  it('shares profiles across worktrees of the same repo', async () => {
    const repoRoot = await makeTmpDir('repo-main');
    const runtimeRoot = await makeTmpDir('repo-runtime');
    try {
      const runtimeGitDir = join(repoRoot, '.git', 'worktrees', 'runtime');
      await mkdir(runtimeGitDir, { recursive: true });
      await writeFile(join(runtimeRoot, '.git'), `gitdir: ${runtimeGitDir}\n`, 'utf-8');
      await writeFile(join(runtimeGitDir, 'gitdir'), `${join(runtimeRoot, '.git')}\n`, 'utf-8');
      await writeFile(join(runtimeGitDir, 'commondir'), '../..\n', 'utf-8');

      const created = await createProviderProfile(runtimeRoot, {
        provider: 'anthropic',
        name: 'sponsor-shared',
        mode: 'api_key',
        baseUrl: 'https://api.shared.dev',
        apiKey: 'sk-shared',
        setActive: true,
      });
      assert.equal(created.mode, 'api_key');

      const runtime = await resolveAnthropicRuntimeProfile(repoRoot);
      assert.equal(runtime.mode, 'api_key');
      assert.equal(runtime.baseUrl, 'https://api.shared.dev');
      assert.equal(runtime.apiKey, 'sk-shared');
    } finally {
      await Promise.all([
        rm(repoRoot, { recursive: true, force: true }),
        rm(runtimeRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it('does not allow .git pointer to redirect storage when worktree metadata is incomplete', async () => {
    const escapedRoot = await makeTmpDir('escaped-root');
    try {
      await mkdir(join(escapedRoot, '.git', 'worktrees', 'runtime'), { recursive: true });
      await writeFile(
        join(projectRoot, '.git'),
        `gitdir: ${join(escapedRoot, '.git', 'worktrees', 'runtime')}\n`,
        'utf-8',
      );

      const created = await createProviderProfile(projectRoot, {
        provider: 'anthropic',
        name: 'sponsor-local',
        mode: 'api_key',
        baseUrl: 'https://api.local.dev',
        apiKey: 'sk-local',
        setActive: true,
      });
      assert.equal(created.mode, 'api_key');

      const runtime = await resolveAnthropicRuntimeProfile(projectRoot);
      assert.equal(runtime.mode, 'api_key');
      assert.equal(runtime.baseUrl, 'https://api.local.dev');
      assert.equal(runtime.apiKey, 'sk-local');

      const localMetaPath = join(projectRoot, '.cat-cafe', 'provider-profiles.json');
      const localSecretsPath = join(projectRoot, '.cat-cafe', 'provider-profiles.secrets.local.json');
      const [localMetaRaw, localSecretsRaw] = await Promise.all([
        readFile(localMetaPath, 'utf-8'),
        readFile(localSecretsPath, 'utf-8'),
      ]);
      assert.ok(localMetaRaw.includes('sponsor-local'));
      assert.ok(localSecretsRaw.includes('sk-local'));

      const escapedMetaPath = join(escapedRoot, '.cat-cafe', 'provider-profiles.json');
      const escapedSecretsPath = join(escapedRoot, '.cat-cafe', 'provider-profiles.secrets.local.json');
      await assert.rejects(readFile(escapedMetaPath, 'utf-8'));
      await assert.rejects(readFile(escapedSecretsPath, 'utf-8'));
    } finally {
      await rm(escapedRoot, { recursive: true, force: true });
    }
  });
});
