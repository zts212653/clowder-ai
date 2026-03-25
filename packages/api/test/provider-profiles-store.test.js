// @ts-check

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const {
  readProviderProfiles,
  createProviderProfile,
  updateProviderProfile,
  activateProviderProfile,
  deleteProviderProfile,
  getProviderProfile,
  resolveAnthropicRuntimeProfile,
} = await import('../dist/config/provider-profiles.js');
const { createRuntimeCat, updateRuntimeCat } = await import('../dist/config/runtime-cat-catalog.js');

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  const dir = join('/tmp', `provider-profile-store-${prefix}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function seedTemplate(projectRoot) {
  const templateRaw = await readFile(join(process.cwd(), '..', '..', 'cat-template.json'), 'utf-8');
  await writeFile(join(projectRoot, 'cat-template.json'), templateRaw, 'utf-8');
}

describe('provider profile store', () => {
  /** @type {string} */ let projectRoot;
  /** @type {string | undefined} */ let savedGlobalRoot;

  beforeEach(async () => {
    projectRoot = await makeTmpDir('case');
    savedGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;
  });

  afterEach(async () => {
    if (savedGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalRoot;
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('bootstraps with five builtin accounts and default oauth/skip bindings', async () => {
    const data = await readProviderProfiles(projectRoot);
    assert.equal(data.activeProfileId, null);
    assert.deepEqual(
      data.providers.map((profile) => ({
        id: profile.id,
        kind: profile.kind,
        client: profile.client,
        authType: profile.authType,
        builtin: profile.builtin,
      })),
      [
        { id: 'claude', kind: 'builtin', client: 'anthropic', authType: 'oauth', builtin: true },
        { id: 'codex', kind: 'builtin', client: 'openai', authType: 'oauth', builtin: true },
        { id: 'gemini', kind: 'builtin', client: 'google', authType: 'oauth', builtin: true },
        { id: 'dare', kind: 'builtin', client: 'dare', authType: 'oauth', builtin: true },
        { id: 'opencode', kind: 'builtin', client: 'opencode', authType: 'oauth', builtin: true },
      ],
    );
    assert.deepEqual(data.bootstrapBindings, {
      anthropic: { enabled: true, mode: 'oauth', accountRef: 'claude' },
      openai: { enabled: true, mode: 'oauth', accountRef: 'codex' },
      google: { enabled: true, mode: 'oauth', accountRef: 'gemini' },
      dare: { enabled: true, mode: 'oauth', accountRef: 'dare' },
      opencode: { enabled: false, mode: 'skip' },
    });
  });

  it('bootstraps the builtin Claude account with the canonical opus model id', async () => {
    const data = await readProviderProfiles(projectRoot);
    const claude = data.providers.find((profile) => profile.id === 'claude');
    assert.ok(claude, 'builtin Claude account should exist');
    assert.ok(claude.models.includes('claude-opus-4-6'));
    assert.equal(
      claude.models.some((model) => model.includes('[1m]')),
      false,
    );
  });

  it('creates a client-agnostic api_key account and keeps secrets out of meta', async () => {
    const created = await createProviderProfile(projectRoot, {
      displayName: 'API Key Account 1',
      authType: 'api_key',
      baseUrl: 'https://proxy.example.dev',
      apiKey: 'sk-generic-account',
    });

    assert.equal(created.kind, 'api_key');
    assert.equal(created.client, undefined);
    assert.equal(created.displayName, 'API Key Account 1');

    const metaPath = join(projectRoot, '.cat-cafe', 'provider-profiles.json');
    const secretsPath = join(projectRoot, '.cat-cafe', 'provider-profiles.secrets.local.json');
    const [metaRaw, secretsRaw] = await Promise.all([readFile(metaPath, 'utf-8'), readFile(secretsPath, 'utf-8')]);
    assert.ok(!metaRaw.includes('sk-generic-account'));
    assert.ok(secretsRaw.includes('sk-generic-account'));
  });

  it('serializes concurrent api_key account creation to avoid lost updates', async () => {
    const created = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        createProviderProfile(projectRoot, {
          displayName: 'Concurrent Sponsor',
          authType: 'api_key',
          baseUrl: 'https://api.concurrent.dev',
          apiKey: `sk-concurrent-${index + 1}`,
        }),
      ),
    );

    const ids = new Set(created.map((profile) => profile.id));
    assert.equal(ids.size, 3);

    const data = await readProviderProfiles(projectRoot);
    const concurrentProfiles = data.providers.filter((profile) => profile.displayName === 'Concurrent Sponsor');
    assert.equal(concurrentProfiles.length, 3);
  });

  it('binds a generic api_key account to the selected client for bootstrap/runtime resolution', async () => {
    const created = await createProviderProfile(projectRoot, {
      displayName: 'Sponsor 1',
      authType: 'api_key',
      baseUrl: 'https://api.sponsor.dev',
      apiKey: 'sk-sponsor-1',
    });

    await activateProviderProfile(projectRoot, 'anthropic', created.id);
    const data = await readProviderProfiles(projectRoot);
    assert.equal(data.activeProfileId, null);
    assert.deepEqual(data.bootstrapBindings.anthropic, {
      enabled: true,
      mode: 'api_key',
      accountRef: created.id,
    });

    const runtime = await resolveAnthropicRuntimeProfile(projectRoot);
    assert.equal(runtime.mode, 'api_key');
    assert.equal(runtime.baseUrl, 'https://api.sponsor.dev');
    assert.equal(runtime.apiKey, 'sk-sponsor-1');
  });

  it('preserves builtin Dare/OpenCode oauth bootstrap bindings across reads', async () => {
    await readProviderProfiles(projectRoot);
    await activateProviderProfile(projectRoot, 'dare', 'dare');
    await activateProviderProfile(projectRoot, 'opencode', 'opencode');

    const data = await readProviderProfiles(projectRoot);
    assert.deepEqual(data.bootstrapBindings.dare, {
      enabled: true,
      mode: 'oauth',
      accountRef: 'dare',
    });
    assert.deepEqual(data.bootstrapBindings.opencode, {
      enabled: true,
      mode: 'oauth',
      accountRef: 'opencode',
    });
  });

  it('rejects deleting an account that is still referenced by a runtime member', async () => {
    await seedTemplate(projectRoot);
    const created = await createProviderProfile(projectRoot, {
      displayName: 'Bound Account',
      authType: 'api_key',
      baseUrl: 'https://api.bound.dev',
      apiKey: 'sk-bound',
    });

    await createRuntimeCat(projectRoot, {
      catId: 'bound-runtime-cat',
      breedId: 'bound-runtime-cat',
      name: '绑定猫',
      displayName: '绑定猫',
      avatar: '/avatars/bound.png',
      color: { primary: '#64748b', secondary: '#cbd5e1' },
      mentionPatterns: ['@bound-runtime-cat'],
      accountRef: created.id,
      roleDescription: '依赖专属账号',
      personality: '稳定',
      provider: 'anthropic',
      defaultModel: 'claude-opus-4-6',
      mcpSupport: false,
      cli: { command: 'claude', outputFormat: 'stream-json' },
    });

    await assert.rejects(
      deleteProviderProfile(projectRoot, created.id, created.id),
      /still referenced by runtime cats: bound-runtime-cat/i,
    );
  });

  it('allows deleting an account after the runtime member clears accountRef', async () => {
    await seedTemplate(projectRoot);
    const created = await createProviderProfile(projectRoot, {
      displayName: 'Unbind Account',
      authType: 'api_key',
      baseUrl: 'https://api.unbind.dev',
      apiKey: 'sk-unbind',
    });

    await createRuntimeCat(projectRoot, {
      catId: 'unbind-runtime-cat',
      breedId: 'unbind-runtime-cat',
      name: '解绑猫',
      displayName: '解绑猫',
      avatar: '/avatars/unbind.png',
      color: { primary: '#64748b', secondary: '#cbd5e1' },
      mentionPatterns: ['@unbind-runtime-cat'],
      accountRef: created.id,
      roleDescription: '先绑定再解绑',
      personality: '稳定',
      provider: 'anthropic',
      defaultModel: 'claude-opus-4-6',
      mcpSupport: false,
      cli: { command: 'claude', outputFormat: 'stream-json' },
    });

    updateRuntimeCat(projectRoot, 'unbind-runtime-cat', { accountRef: null });
    await deleteProviderProfile(projectRoot, created.id, created.id);

    const profiles = await readProviderProfiles(projectRoot);
    assert.equal(
      profiles.providers.some((profile) => profile.id === created.id),
      false,
    );
  });

  it('blocks deleting a global profile still referenced by a sibling worktree', async () => {
    const repoRoot = await makeTmpDir('shared-delete-main');
    const runtimeRoot = await makeTmpDir('shared-delete-runtime');
    try {
      const runtimeGitDir = join(repoRoot, '.git', 'worktrees', 'runtime');
      await mkdir(runtimeGitDir, { recursive: true });
      await writeFile(join(runtimeRoot, '.git'), `gitdir: ${runtimeGitDir}\n`, 'utf-8');
      await writeFile(join(runtimeGitDir, 'gitdir'), `${join(runtimeRoot, '.git')}\n`, 'utf-8');
      await writeFile(join(runtimeGitDir, 'commondir'), '../..\n', 'utf-8');
      await Promise.all([seedTemplate(repoRoot), seedTemplate(runtimeRoot)]);

      const created = await createProviderProfile(runtimeRoot, {
        displayName: 'Shared Delete Account',
        authType: 'api_key',
        baseUrl: 'https://api.shared-delete.dev',
        apiKey: 'sk-shared-delete',
      });

      await createRuntimeCat(repoRoot, {
        catId: 'shared-root-bound-cat',
        breedId: 'shared-root-bound-cat',
        name: '共享绑定猫',
        displayName: '共享绑定猫',
        avatar: '/avatars/shared.png',
        color: { primary: '#64748b', secondary: '#cbd5e1' },
        mentionPatterns: ['@shared-root-bound-cat'],
        accountRef: created.id,
        roleDescription: '跨 worktree 绑定',
        personality: '稳定',
        provider: 'anthropic',
        defaultModel: 'claude-opus-4-6',
        mcpSupport: false,
        cli: { command: 'claude', outputFormat: 'stream-json' },
      });

      await assert.rejects(
        deleteProviderProfile(runtimeRoot, created.id, created.id),
        /still referenced by runtime cats/,
      );
    } finally {
      await Promise.all([
        rm(repoRoot, { recursive: true, force: true }),
        rm(runtimeRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it('builtin accounts only allow model-list updates', async () => {
    await assert.rejects(
      updateProviderProfile(projectRoot, 'claude', 'claude', {
        displayName: 'Nope',
      }),
      /builtin accounts only support model updates/i,
    );
  });

  it('readProviderProfiles and getProviderProfile do not rewrite normalized files', async () => {
    const created = await createProviderProfile(projectRoot, {
      displayName: 'Readonly Check',
      authType: 'api_key',
      apiKey: 'sk-readonly',
    });
    const metaPath = join(projectRoot, '.cat-cafe', 'provider-profiles.json');
    const secretsPath = join(projectRoot, '.cat-cafe', 'provider-profiles.secrets.local.json');
    const [metaBefore, secretsBefore] = await Promise.all([stat(metaPath), stat(secretsPath)]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await readProviderProfiles(projectRoot);
    await getProviderProfile(projectRoot, created.id, created.id);

    const [metaAfter, secretsAfter] = await Promise.all([stat(metaPath), stat(secretsPath)]);
    assert.equal(metaAfter.mtimeMs, metaBefore.mtimeMs);
    assert.equal(secretsAfter.mtimeMs, secretsBefore.mtimeMs);
  });

  it('shares provider profiles globally across different project roots', async () => {
    const projectA = await makeTmpDir('project-a');
    const projectB = await makeTmpDir('project-b');
    try {
      const created = await createProviderProfile(projectA, {
        displayName: 'Shared Account',
        authType: 'api_key',
        baseUrl: 'https://api.shared.dev',
        apiKey: 'sk-shared',
      });
      await activateProviderProfile(projectA, 'anthropic', created.id);

      const profileFromA = await resolveAnthropicRuntimeProfile(projectA);
      assert.equal(profileFromA.mode, 'api_key');
      assert.equal(profileFromA.baseUrl, 'https://api.shared.dev');

      const profileFromB = await resolveAnthropicRuntimeProfile(projectB);
      assert.equal(profileFromB.mode, 'api_key');
      assert.equal(profileFromB.baseUrl, 'https://api.shared.dev');
      assert.equal(profileFromB.apiKey, 'sk-shared');
    } finally {
      await Promise.all([
        rm(projectA, { recursive: true, force: true }),
        rm(projectB, { recursive: true, force: true }),
      ]);
    }
  });

  it('does not allow incomplete .git pointers to redirect storage outside the project', async () => {
    const escapedRoot = await makeTmpDir('escaped-root');
    try {
      await mkdir(join(escapedRoot, '.git', 'worktrees', 'runtime'), { recursive: true });
      await writeFile(
        join(projectRoot, '.git'),
        `gitdir: ${join(escapedRoot, '.git', 'worktrees', 'runtime')}\n`,
        'utf-8',
      );

      const created = await createProviderProfile(projectRoot, {
        displayName: 'Local Account',
        authType: 'api_key',
        baseUrl: 'https://api.local.dev',
        apiKey: 'sk-local',
      });
      await activateProviderProfile(projectRoot, 'anthropic', created.id);

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
      assert.ok(localMetaRaw.includes('Local Account'));
      assert.ok(localSecretsRaw.includes('sk-local'));

      const escapedMetaPath = join(escapedRoot, '.cat-cafe', 'provider-profiles.json');
      const escapedSecretsPath = join(escapedRoot, '.cat-cafe', 'provider-profiles.secrets.local.json');
      await assert.rejects(readFile(escapedMetaPath, 'utf-8'));
      await assert.rejects(readFile(escapedSecretsPath, 'utf-8'));
    } finally {
      await rm(escapedRoot, { recursive: true, force: true });
    }
  });

  it('migrates project-local profiles to global storage on first read', async () => {
    const localProject = await makeTmpDir('local-project');
    const globalRoot = await makeTmpDir('global-root');
    const previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = globalRoot;
    try {
      const localDir = join(localProject, '.cat-cafe');
      await mkdir(localDir, { recursive: true });
      await writeFile(
        join(localDir, 'provider-profiles.json'),
        JSON.stringify({
          version: 3,
          activeProfileId: null,
          providers: [
            {
              id: 'migrated-acct',
              displayName: 'Migrated Account',
              kind: 'api_key',
              authType: 'api_key',
              builtin: false,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
          bootstrapBindings: {},
        }),
      );
      await writeFile(
        join(localDir, 'provider-profiles.secrets.local.json'),
        JSON.stringify({ version: 3, profiles: { 'migrated-acct': { apiKey: 'sk-migrated' } } }),
      );

      const view = await readProviderProfiles(localProject);
      const migrated = view.providers.find((p) => p.id === 'migrated-acct');
      assert.ok(migrated, 'migrated profile should be visible from global storage');
      assert.equal(migrated.hasApiKey, true);

      const globalMeta = join(globalRoot, '.cat-cafe', 'provider-profiles.json');
      const raw = await readFile(globalMeta, 'utf-8');
      assert.ok(raw.includes('migrated-acct'), 'profile should exist in global storage');
    } finally {
      if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
      await Promise.all([
        rm(localProject, { recursive: true, force: true }),
        rm(globalRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it('migration triggers from resolveAnthropicRuntimeProfile (readRaw path)', async () => {
    const localProject = await makeTmpDir('readraw-local');
    const globalRoot = await makeTmpDir('readraw-global');
    const previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = globalRoot;
    try {
      const localDir = join(localProject, '.cat-cafe');
      await mkdir(localDir, { recursive: true });
      const created = await createProviderProfile(globalRoot, {
        displayName: 'Runtime Account',
        authType: 'api_key',
        baseUrl: 'https://api.runtime.dev',
        apiKey: 'sk-runtime',
      });
      await activateProviderProfile(globalRoot, 'anthropic', created.id);

      const meta = JSON.parse(await readFile(join(globalRoot, '.cat-cafe', 'provider-profiles.json'), 'utf-8'));
      const secrets = JSON.parse(
        await readFile(join(globalRoot, '.cat-cafe', 'provider-profiles.secrets.local.json'), 'utf-8'),
      );

      await rm(join(globalRoot, '.cat-cafe'), { recursive: true, force: true });
      await mkdir(localDir, { recursive: true });
      await writeFile(join(localDir, 'provider-profiles.json'), JSON.stringify(meta));
      await writeFile(join(localDir, 'provider-profiles.secrets.local.json'), JSON.stringify(secrets));

      const runtime = await resolveAnthropicRuntimeProfile(localProject);
      assert.equal(runtime.mode, 'api_key');
      assert.equal(runtime.apiKey, 'sk-runtime');
    } finally {
      if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
      await Promise.all([
        rm(localProject, { recursive: true, force: true }),
        rm(globalRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it('migration triggers from readBootstrapBindingsSync', async () => {
    const { readBootstrapBindings } = await import('../dist/config/provider-profiles.js');
    const localProject = await makeTmpDir('sync-local');
    const globalRoot = await makeTmpDir('sync-global');
    const previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = globalRoot;
    try {
      const localDir = join(localProject, '.cat-cafe');
      await mkdir(localDir, { recursive: true });
      const created = await createProviderProfile(globalRoot, {
        displayName: 'Sync Account',
        authType: 'api_key',
        baseUrl: 'https://api.sync.dev',
        apiKey: 'sk-sync',
      });
      await activateProviderProfile(globalRoot, 'anthropic', created.id);

      const meta = await readFile(join(globalRoot, '.cat-cafe', 'provider-profiles.json'), 'utf-8');
      const secrets = await readFile(join(globalRoot, '.cat-cafe', 'provider-profiles.secrets.local.json'), 'utf-8');

      await rm(join(globalRoot, '.cat-cafe'), { recursive: true, force: true });
      await mkdir(localDir, { recursive: true });
      await writeFile(join(localDir, 'provider-profiles.json'), meta);
      await writeFile(join(localDir, 'provider-profiles.secrets.local.json'), secrets);

      const { readBootstrapBindingsSync } = await import('../dist/config/provider-profiles.js');
      const bindings = readBootstrapBindingsSync(localProject);
      assert.equal(bindings.anthropic?.mode, 'api_key');
      assert.equal(bindings.anthropic?.accountRef, created.id);
    } finally {
      if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
      await Promise.all([
        rm(localProject, { recursive: true, force: true }),
        rm(globalRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it('writeRaw preserves 0o600 permissions on the secrets file', async () => {
    const created = await createProviderProfile(projectRoot, {
      displayName: 'Chmod Check',
      authType: 'api_key',
      baseUrl: 'https://api.chmod.dev',
      apiKey: 'sk-chmod-check',
    });

    const secretsPath = join(projectRoot, '.cat-cafe', 'provider-profiles.secrets.local.json');
    const secretsStat = await stat(secretsPath);
    assert.equal(
      secretsStat.mode & 0o777,
      0o600,
      `secrets file should have mode 0600 but got ${(secretsStat.mode & 0o777).toString(8)}`,
    );
  });

  it('merges second project profiles into existing global store', async () => {
    const projectA = await makeTmpDir('merge-projA');
    const projectB = await makeTmpDir('merge-projB');
    const globalRoot = await makeTmpDir('merge-global');
    const previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = globalRoot;
    try {
      // --- Project A: seed local profiles and migrate via readProviderProfiles ---
      const localDirA = join(projectA, '.cat-cafe');
      await mkdir(localDirA, { recursive: true });
      await writeFile(
        join(localDirA, 'provider-profiles.json'),
        JSON.stringify({
          version: 3,
          activeProfileId: null,
          providers: [
            {
              id: 'acct-alpha',
              displayName: 'Alpha',
              kind: 'api_key',
              authType: 'api_key',
              builtin: false,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
          bootstrapBindings: {},
        }),
      );
      await writeFile(
        join(localDirA, 'provider-profiles.secrets.local.json'),
        JSON.stringify({ version: 3, profiles: { 'acct-alpha': { apiKey: 'sk-alpha' } } }),
      );

      // Trigger first migration (empty global -> copy)
      await readProviderProfiles(projectA);

      // Verify first migration populated global
      const globalMeta1 = JSON.parse(await readFile(join(globalRoot, '.cat-cafe', 'provider-profiles.json'), 'utf-8'));
      assert.ok(
        globalMeta1.providers.some((p) => p.id === 'acct-alpha'),
        'alpha should be in global after first migration',
      );

      // --- Project B: seed local profiles with a collision ID and a unique ID ---
      const localDirB = join(projectB, '.cat-cafe');
      await mkdir(localDirB, { recursive: true });
      await writeFile(
        join(localDirB, 'provider-profiles.json'),
        JSON.stringify({
          version: 3,
          activeProfileId: null,
          providers: [
            {
              id: 'acct-alpha',
              displayName: 'Alpha Copy',
              kind: 'api_key',
              authType: 'api_key',
              builtin: false,
              createdAt: '2026-02-01T00:00:00Z',
              updatedAt: '2026-02-01T00:00:00Z',
            },
            {
              id: 'acct-beta',
              displayName: 'Beta',
              kind: 'api_key',
              authType: 'api_key',
              builtin: false,
              createdAt: '2026-02-01T00:00:00Z',
              updatedAt: '2026-02-01T00:00:00Z',
            },
          ],
          bootstrapBindings: {},
        }),
      );
      await writeFile(
        join(localDirB, 'provider-profiles.secrets.local.json'),
        JSON.stringify({
          version: 3,
          profiles: { 'acct-alpha': { apiKey: 'sk-alpha-b' }, 'acct-beta': { apiKey: 'sk-beta' } },
        }),
      );

      // Trigger second migration (merge into existing global)
      const view = await readProviderProfiles(projectB);

      // --- Assertions ---
      // 1. Original alpha from project A still exists
      const alpha = view.providers.find((p) => p.id === 'acct-alpha');
      assert.ok(alpha, 'original acct-alpha from project A should still exist');

      // 2. Colliding alpha from project B was re-ID'd with -migrated- suffix
      const migratedAlpha = view.providers.find(
        (p) => p.id !== 'acct-alpha' && p.id.startsWith('acct-alpha-migrated-'),
      );
      assert.ok(migratedAlpha, 'colliding acct-alpha from project B should be re-IDd with -migrated- suffix');
      assert.equal(migratedAlpha.displayName, 'Alpha Copy');

      // 3. Unique beta from project B exists as-is
      const beta = view.providers.find((p) => p.id === 'acct-beta');
      assert.ok(beta, 'unique acct-beta from project B should exist in global');

      // 4. Secrets from both projects are present
      const globalSecrets = JSON.parse(
        await readFile(join(globalRoot, '.cat-cafe', 'provider-profiles.secrets.local.json'), 'utf-8'),
      );
      assert.equal(globalSecrets.profiles['acct-alpha']?.apiKey, 'sk-alpha', 'project A secret preserved');
      assert.equal(
        globalSecrets.profiles[migratedAlpha.id]?.apiKey,
        'sk-alpha-b',
        'colliding profile secret mapped to new ID',
      );
      assert.equal(globalSecrets.profiles['acct-beta']?.apiKey, 'sk-beta', 'project B unique secret present');

      // 4b. Cat catalog refs in project B are rewritten to point to the new migrated ID
      const catalogPathB = join(localDirB, 'cat-catalog.json');
      if (existsSync(catalogPathB)) {
        const catalog = JSON.parse(await readFile(catalogPathB, 'utf-8'));
        for (const breed of catalog.breeds ?? []) {
          for (const variant of breed.variants ?? []) {
            const ref = variant.accountRef ?? variant.providerProfileId;
            assert.ok(
              !ref || ref !== 'acct-alpha' || ref === migratedAlpha.id,
              'cat catalog ref should point to migrated ID, not original',
            );
          }
        }
      }

      // 5. Project B local file was renamed to .migrated
      const localMetaB = join(localDirB, 'provider-profiles.json');
      assert.equal(existsSync(localMetaB), false, 'project B local meta should be gone');
      assert.equal(existsSync(`${localMetaB}.migrated`), true, 'project B local meta should be renamed to .migrated');

      // 6. Builtin profiles were NOT duplicated
      const builtinClaudes = view.providers.filter((p) => p.id === 'claude');
      assert.equal(builtinClaudes.length, 1, 'builtin claude should not be duplicated');

      // 7. Sync merge with legacy v1 global — normalizeMeta must handle it
      const projectC = await makeTmpDir('merge-projC');
      const localDirC = join(projectC, '.cat-cafe');
      await mkdir(localDirC, { recursive: true });
      // Write a v3 local meta with a new account
      const now = new Date().toISOString();
      await writeFile(
        join(localDirC, 'provider-profiles.json'),
        JSON.stringify({
          version: 3,
          providers: [
            {
              id: 'acct-charlie',
              displayName: 'Charlie',
              kind: 'api_key',
              authType: 'api_key',
              builtin: false,
              baseUrl: 'https://api.charlie.dev',
              createdAt: now,
              updatedAt: now,
            },
          ],
          bootstrapBindings: {},
        }),
      );
      // Write local secrets in legacy v1 format (providers.anthropic keyed)
      await writeFile(
        join(localDirC, 'provider-profiles.secrets.local.json'),
        JSON.stringify({
          version: 1,
          providers: { anthropic: { 'acct-charlie': { apiKey: 'sk-charlie' } } },
        }),
      );
      // Force global meta AND secrets to legacy v1 format
      await writeFile(
        join(globalRoot, '.cat-cafe', 'provider-profiles.json'),
        JSON.stringify({
          version: 1,
          providers: {
            anthropic: {
              activeProfileId: null,
              profiles: [
                { id: 'acct-alpha', displayName: 'Alpha Acct', authType: 'api_key', baseUrl: 'https://api.alpha.dev' },
              ],
            },
          },
        }),
      );
      await writeFile(
        join(globalRoot, '.cat-cafe', 'provider-profiles.secrets.local.json'),
        JSON.stringify({
          version: 1,
          providers: { anthropic: { 'acct-alpha': { apiKey: 'sk-alpha-global' } } },
        }),
      );
      // Sync migration should normalize legacy v1 meta+secrets before merging
      const { readBootstrapBindingsSync } = await import('../dist/config/provider-profiles.js');
      process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = globalRoot;
      readBootstrapBindingsSync(projectC);
      const finalView = await readProviderProfiles(globalRoot);
      const charlieProfile = finalView.providers.find((p) => p.id === 'acct-charlie');
      assert.ok(charlieProfile, 'project C profile should be merged into global after legacy v1 normalization');
      assert.ok(charlieProfile.hasApiKey, 'project C api key must survive legacy v1 secrets normalization');
      await rm(projectC, { recursive: true, force: true });
    } finally {
      if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
      await Promise.all([
        rm(projectA, { recursive: true, force: true }),
        rm(projectB, { recursive: true, force: true }),
        rm(globalRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it('rewrites cat catalog accountRef when profile ID is renamed during migration', async () => {
    const projectA = await makeTmpDir('rewrite-projA');
    const projectB = await makeTmpDir('rewrite-projB');
    const globalRoot = await makeTmpDir('rewrite-global');
    const previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = globalRoot;
    try {
      // --- Project A: seed with acct-shared ---
      const localDirA = join(projectA, '.cat-cafe');
      await mkdir(localDirA, { recursive: true });
      await writeFile(
        join(localDirA, 'provider-profiles.json'),
        JSON.stringify({
          version: 3,
          activeProfileId: null,
          providers: [
            {
              id: 'acct-shared',
              displayName: 'Shared A',
              kind: 'api_key',
              authType: 'api_key',
              builtin: false,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
          bootstrapBindings: {},
        }),
      );
      await writeFile(
        join(localDirA, 'provider-profiles.secrets.local.json'),
        JSON.stringify({ version: 3, profiles: { 'acct-shared': { apiKey: 'sk-a' } } }),
      );
      await readProviderProfiles(projectA);

      // --- Project B: seed with same acct-shared + cat catalog referencing it ---
      const localDirB = join(projectB, '.cat-cafe');
      await mkdir(localDirB, { recursive: true });
      await writeFile(
        join(localDirB, 'provider-profiles.json'),
        JSON.stringify({
          version: 3,
          activeProfileId: null,
          providers: [
            {
              id: 'acct-shared',
              displayName: 'Shared B',
              kind: 'api_key',
              authType: 'api_key',
              builtin: false,
              createdAt: '2026-02-01T00:00:00Z',
              updatedAt: '2026-02-01T00:00:00Z',
            },
          ],
          bootstrapBindings: {},
        }),
      );
      await writeFile(
        join(localDirB, 'provider-profiles.secrets.local.json'),
        JSON.stringify({ version: 3, profiles: { 'acct-shared': { apiKey: 'sk-b' } } }),
      );
      // Cat catalog in project B references acct-shared
      await writeFile(
        join(localDirB, 'cat-catalog.json'),
        JSON.stringify({
          breeds: [
            {
              catId: 'test-cat',
              defaultVariantId: 'v1',
              variants: [
                { id: 'v1', provider: 'anthropic', accountRef: 'acct-shared', providerProfileId: 'acct-shared' },
              ],
            },
          ],
        }),
      );

      // Trigger migration for project B (merge into existing global → collision)
      await readProviderProfiles(projectB);

      // Verify cat catalog was rewritten
      const catalogPath = join(localDirB, 'cat-catalog.json');
      const catalog = JSON.parse(await readFile(catalogPath, 'utf-8'));
      const variant = catalog.breeds[0].variants[0];
      assert.ok(
        variant.accountRef.startsWith('acct-shared-migrated-'),
        `accountRef should be rewritten to migrated ID, got: ${variant.accountRef}`,
      );
      assert.ok(
        variant.providerProfileId.startsWith('acct-shared-migrated-'),
        `providerProfileId should be rewritten to migrated ID, got: ${variant.providerProfileId}`,
      );
    } finally {
      if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
      await Promise.all([
        rm(projectA, { recursive: true, force: true }),
        rm(projectB, { recursive: true, force: true }),
        rm(globalRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it('skips re-migration when project root is recorded in global migrated-roots', async () => {
    const project = await makeTmpDir('migrated-roots-proj');
    const globalRoot = await makeTmpDir('migrated-roots-global');
    const previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = globalRoot;
    try {
      // Seed a local profile in the project
      const localDir = join(project, '.cat-cafe');
      await mkdir(localDir, { recursive: true });
      await writeFile(
        join(localDir, 'provider-profiles.json'),
        JSON.stringify({
          version: 3,
          activeProfileId: null,
          providers: [
            {
              id: 'acct-once',
              name: 'Once',
              provider: 'anthropic',
              kind: 'account',
              builtin: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
          bootstrapBindings: {},
        }),
      );
      await writeFile(
        join(localDir, 'provider-profiles.secrets.local.json'),
        JSON.stringify({ version: 3, profiles: { 'acct-once': { apiKey: 'sk-once' } } }),
      );

      // First read triggers migration
      const view1 = await readProviderProfiles(project);
      const once1 = view1.providers.filter((p) => p.id.startsWith('acct-once'));
      assert.equal(once1.length, 1, 'profile migrated once');

      // Simulate read-only local FS: re-create the local meta (rename didn't delete it)
      // The global migrated-roots marker should prevent re-migration even though local file exists.
      await writeFile(
        join(localDir, 'provider-profiles.json'),
        JSON.stringify({
          version: 3,
          activeProfileId: null,
          providers: [
            {
              id: 'acct-once',
              name: 'Once',
              provider: 'anthropic',
              kind: 'account',
              builtin: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
          bootstrapBindings: {},
        }),
      );

      // Write global migrated-roots marker (as if rename had failed and fallback wrote it)
      const { markProjectRootMigrated } = await import('../dist/config/provider-profiles-root.js');
      markProjectRootMigrated(project);

      // Second read should NOT re-merge (no duplicate)
      const view2 = await readProviderProfiles(project);
      const once2 = view2.providers.filter((p) => p.id.startsWith('acct-once'));
      assert.equal(once2.length, 1, 'no duplicate after migrated-roots marker prevents re-migration');
    } finally {
      if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
      await Promise.all([
        rm(project, { recursive: true, force: true }),
        rm(globalRoot, { recursive: true, force: true }),
      ]);
    }
  });
});
