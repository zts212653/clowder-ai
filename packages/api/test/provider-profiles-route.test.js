// @ts-check
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const AUTH_HEADERS = { 'x-cat-cafe-user': 'test-user' };

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  return mkdtemp(join(homedir(), `.cat-cafe-provider-profile-route-${prefix}-`));
}

/** @param {string} prefix */
async function makeWorkspaceDir(prefix) {
  return mkdtemp(join(process.cwd(), '..', '..', `.cat-cafe-provider-profile-route-workspace-${prefix}-`));
}

describe('provider profiles routes', () => {
  /** @type {string | undefined} */ let savedGlobalRoot;

  function setGlobalRoot(dir) {
    savedGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = dir;
  }

  function restoreGlobalRoot() {
    if (savedGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalRoot;
  }

  it('migrates legacy v1 provider profiles with anthropic protocol metadata', async () => {
    const { readProviderProfiles } = await import('../dist/config/provider-profiles.js');
    const projectDir = await makeTmpDir('legacy-v1');
    setGlobalRoot(projectDir);
    try {
      const catCafeDir = join(projectDir, '.cat-cafe');
      await mkdir(catCafeDir, { recursive: true });
      await writeFile(
        join(catCafeDir, 'provider-profiles.json'),
        JSON.stringify({
          version: 1,
          providers: {
            anthropic: {
              activeProfileId: 'anthropic-sponsor',
              profiles: [
                {
                  id: 'anthropic-sponsor',
                  displayName: 'Anthropic Sponsor',
                  authType: 'api_key',
                  mode: 'api_key',
                  baseUrl: 'https://api.anthropic-proxy.dev',
                },
              ],
            },
          },
        }),
      );

      const view = await readProviderProfiles(projectDir);
      const migrated = view.providers.find((profile) => profile.id === 'anthropic-sponsor');
      assert.ok(migrated, 'migrated anthropic profile should exist');
      assert.equal(migrated.protocol, 'anthropic');
      assert.deepEqual(view.bootstrapBindings.anthropic, {
        enabled: true,
        mode: 'api_key',
        accountRef: 'anthropic-sponsor',
      });
    } finally {
      restoreGlobalRoot();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('migrates legacy v2 provider profiles by preserving or inferring protocol metadata', async () => {
    const { readProviderProfiles } = await import('../dist/config/provider-profiles.js');
    const projectDir = await makeTmpDir('legacy-v2');
    setGlobalRoot(projectDir);
    try {
      const catCafeDir = join(projectDir, '.cat-cafe');
      await mkdir(catCafeDir, { recursive: true });
      await writeFile(
        join(catCafeDir, 'provider-profiles.json'),
        JSON.stringify({
          version: 2,
          activeProfileIds: {
            openai: 'openai-sponsor',
            google: 'google-sponsor',
          },
          profiles: [
            {
              id: 'openai-sponsor',
              displayName: 'OpenAI Sponsor',
              authType: 'api_key',
              mode: 'api_key',
              protocol: 'openai',
              baseUrl: 'https://api.openai-proxy.dev',
            },
            {
              id: 'google-sponsor',
              displayName: 'Google Sponsor',
              authType: 'api_key',
              mode: 'api_key',
              provider: 'google',
              baseUrl: 'https://generativelanguage.googleapis.com',
            },
          ],
        }),
      );

      const view = await readProviderProfiles(projectDir);
      const openai = view.providers.find((profile) => profile.id === 'openai-sponsor');
      const google = view.providers.find((profile) => profile.id === 'google-sponsor');
      assert.ok(openai, 'migrated openai profile should exist');
      assert.ok(google, 'migrated google profile should exist');
      assert.equal(openai.protocol, 'openai');
      assert.equal(google.protocol, 'google');
      assert.deepEqual(view.bootstrapBindings.openai, {
        enabled: true,
        mode: 'api_key',
        accountRef: 'openai-sponsor',
      });
      assert.deepEqual(view.bootstrapBindings.google, {
        enabled: true,
        mode: 'api_key',
        accountRef: 'google-sponsor',
      });
    } finally {
      restoreGlobalRoot();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('GET /api/provider-profiles requires identity', async () => {
    const Fastify = (await import('fastify')).default;
    const { providerProfilesRoutes } = await import('../dist/routes/provider-profiles.js');
    const app = Fastify();
    await app.register(providerProfilesRoutes);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/provider-profiles' });
    assert.equal(res.statusCode, 401);

    await app.close();
  });

  it('create + activate + list profile flow', async () => {
    const Fastify = (await import('fastify')).default;
    const { providerProfilesRoutes } = await import('../dist/routes/provider-profiles.js');
    const app = Fastify();
    await app.register(providerProfilesRoutes);
    await app.ready();

    const projectDir = await makeTmpDir('crud');
    setGlobalRoot(projectDir);
    try {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          provider: 'anthropic',
          displayName: 'sponsor-route',
          authType: 'api_key',
          baseUrl: 'https://api.route.dev',
          apiKey: 'sk-route',
          models: ['claude-opus-4-6'],
          setActive: true,
        }),
      });
      assert.equal(createRes.statusCode, 200);
      const created = createRes.json();
      assert.equal(created.profile.authType, 'api_key');
      assert.equal(created.profile.hasApiKey, true);

      const listRes = await app.inject({
        method: 'GET',
        url: `/api/provider-profiles?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });
      assert.equal(listRes.statusCode, 200);
      const list = listRes.json();
      assert.ok(Array.isArray(list.providers));
      assert.equal(list.activeProfileId, null);
      assert.deepEqual(list.bootstrapBindings, {
        anthropic: { enabled: true, mode: 'api_key', accountRef: created.profile.id },
        openai: { enabled: true, mode: 'oauth', accountRef: 'codex' },
        google: { enabled: true, mode: 'oauth', accountRef: 'gemini' },
        dare: { enabled: true, mode: 'oauth', accountRef: 'dare' },
        opencode: { enabled: false, mode: 'skip' },
      });
      assert.deepEqual(
        list.providers.slice(0, 3).map((profile) => profile.id),
        ['claude', 'codex', 'gemini'],
      );
      const listed = list.providers.find((p) => p.id === created.profile.id);
      assert.ok(listed);
      assert.equal(listed.hasApiKey, true);
    } finally {
      restoreGlobalRoot();
      await rm(projectDir, { recursive: true, force: true });
      await app.close();
    }
  });

  it('POST /api/provider-profiles/:id/test validates api_key profile via fetch', async () => {
    const Fastify = (await import('fastify')).default;
    const { providerProfilesRoutes } = await import('../dist/routes/provider-profiles.js');
    const app = Fastify();
    await app.register(providerProfilesRoutes, {
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    await app.ready();

    const projectDir = await makeTmpDir('test');
    setGlobalRoot(projectDir);
    try {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          displayName: 'sponsor-test',
          authType: 'api_key',
          baseUrl: 'https://api.route.dev',
          apiKey: 'sk-route',
          models: ['claude-opus-4-6'],
          setActive: false,
        }),
      });
      const profileId = createRes.json().profile.id;

      const testRes = await app.inject({
        method: 'POST',
        url: `/api/provider-profiles/${profileId}/test`,
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          protocol: 'anthropic',
        }),
      });
      assert.equal(testRes.statusCode, 200);
      const body = testRes.json();
      assert.equal(body.ok, true);
    } finally {
      restoreGlobalRoot();
      await rm(projectDir, { recursive: true, force: true });
      await app.close();
    }
  });

  it('POST /api/provider-profiles/:id/test falls back to /v1/messages when /v1/models is 404', async () => {
    const Fastify = (await import('fastify')).default;
    const calls = [];
    const { providerProfilesRoutes } = await import('../dist/routes/provider-profiles.js');
    const app = Fastify();
    await app.register(providerProfilesRoutes, {
      fetchImpl: async (url, init) => {
        const urlString = String(url);
        calls.push({ method: init?.method ?? 'GET', url: urlString });
        if (urlString.endsWith('/v1/models')) {
          return new Response('Not Found', { status: 404 });
        }
        if (urlString.endsWith('/v1/messages')) {
          return new Response('{"id":"msg_test"}', { status: 200 });
        }
        return new Response('Unhandled URL', { status: 500 });
      },
    });
    await app.ready();

    const projectDir = await makeTmpDir('test-fallback');
    setGlobalRoot(projectDir);
    try {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          displayName: 'felix',
          authType: 'api_key',
          baseUrl: 'https://chat.nuoda.vip/claudecode',
          apiKey: 'sk-route',
          models: ['claude-opus-4-6'],
          setActive: false,
        }),
      });
      const profileId = createRes.json().profile.id;

      const testRes = await app.inject({
        method: 'POST',
        url: `/api/provider-profiles/${profileId}/test`,
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          protocol: 'anthropic',
        }),
      });
      assert.equal(testRes.statusCode, 200);
      const body = testRes.json();
      assert.equal(body.ok, true);
      assert.equal(body.status, 200);
      assert.deepEqual(
        calls.map((call) => `${call.method} ${new URL(call.url).pathname}`),
        ['GET /claudecode/v1/models', 'POST /claudecode/v1/messages'],
      );
    } finally {
      restoreGlobalRoot();
      await rm(projectDir, { recursive: true, force: true });
      await app.close();
    }
  });

  it('POST /api/provider-profiles/:id/test treats invalid-model 400 as compatible success', async () => {
    const Fastify = (await import('fastify')).default;
    const calls = [];
    const { providerProfilesRoutes } = await import('../dist/routes/provider-profiles.js');
    const app = Fastify();
    await app.register(providerProfilesRoutes, {
      fetchImpl: async (url, init) => {
        const urlString = String(url);
        calls.push({ method: init?.method ?? 'GET', url: urlString });
        if (urlString.endsWith('/v1/models')) {
          return new Response('Not Found', { status: 404 });
        }
        if (urlString.endsWith('/v1/messages')) {
          return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"invalid model"}}', {
            status: 400,
          });
        }
        return new Response('Unhandled URL', { status: 500 });
      },
    });
    await app.ready();

    const projectDir = await makeTmpDir('test-invalid-model');
    setGlobalRoot(projectDir);
    try {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          displayName: 'felix-invalid-model',
          authType: 'api_key',
          baseUrl: 'https://chat.nuoda.vip/claudecode',
          apiKey: 'sk-route',
          models: ['claude-opus-4-6'],
          setActive: false,
        }),
      });
      const profileId = createRes.json().profile.id;

      const testRes = await app.inject({
        method: 'POST',
        url: `/api/provider-profiles/${profileId}/test`,
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
        }),
      });
      assert.equal(testRes.statusCode, 200);
      const body = testRes.json();
      assert.equal(body.ok, true);
      assert.deepEqual(
        calls.map((call) => `${call.method} ${new URL(call.url).pathname}`),
        ['GET /claudecode/v1/models', 'POST /claudecode/v1/messages'],
      );
    } finally {
      restoreGlobalRoot();
      await rm(projectDir, { recursive: true, force: true });
      await app.close();
    }
  });

  it('rejects blank profile name in create request', async () => {
    const Fastify = (await import('fastify')).default;
    const { providerProfilesRoutes } = await import('../dist/routes/provider-profiles.js');
    const app = Fastify();
    await app.register(providerProfilesRoutes);
    await app.ready();

    const projectDir = await makeTmpDir('blank-name');
    setGlobalRoot(projectDir);
    try {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          displayName: '   ',
          authType: 'api_key',
        }),
      });
      assert.equal(createRes.statusCode, 400);
    } finally {
      restoreGlobalRoot();
      await rm(projectDir, { recursive: true, force: true });
      await app.close();
    }
  });

  it('POST /api/provider-profiles/:id/test validates openai api_key providers via fetch', async () => {
    const Fastify = (await import('fastify')).default;
    const calls = [];
    const { providerProfilesRoutes } = await import('../dist/routes/provider-profiles.js');
    const app = Fastify();
    await app.register(providerProfilesRoutes, {
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), headers: init?.headers });
        return new Response('{}', { status: 200 });
      },
    });
    await app.ready();

    const projectDir = await makeTmpDir('test-openai');
    setGlobalRoot(projectDir);
    try {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          displayName: 'codex-sponsor',
          authType: 'api_key',
          baseUrl: 'https://api.openai-proxy.dev',
          apiKey: 'sk-openai',
          models: ['gpt-5.4'],
          setActive: false,
        }),
      });
      assert.equal(createRes.statusCode, 200);
      const profileId = createRes.json().profile.id;

      const testRes = await app.inject({
        method: 'POST',
        url: `/api/provider-profiles/${profileId}/test`,
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
        }),
      });
      assert.equal(testRes.statusCode, 200);
      assert.equal(testRes.json().ok, true);
      assert.equal(new URL(calls[0].url).pathname, '/v1/models');
      assert.equal(calls[0].headers.authorization, 'Bearer sk-openai');
    } finally {
      restoreGlobalRoot();
      await rm(projectDir, { recursive: true, force: true });
      await app.close();
    }
  });

  it('POST /api/provider-profiles/:id/test probes Gemini-style /v1beta/models endpoints', async () => {
    const Fastify = (await import('fastify')).default;
    const calls = [];
    const { providerProfilesRoutes } = await import('../dist/routes/provider-profiles.js');
    const app = Fastify();
    await app.register(providerProfilesRoutes, {
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), headers: init?.headers });
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/v1beta/models')) return new Response('{}', { status: 200 });
        return new Response('not found', { status: 404 });
      },
    });
    await app.ready();

    const projectDir = await makeTmpDir('test-google');
    setGlobalRoot(projectDir);
    try {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          displayName: 'gemini-sponsor',
          authType: 'api_key',
          baseUrl: 'https://generativelanguage.googleapis.com',
          apiKey: 'gsk-google',
          models: ['gemini-2.5-pro'],
          setActive: false,
        }),
      });
      assert.equal(createRes.statusCode, 200);
      const profileId = createRes.json().profile.id;

      const testRes = await app.inject({
        method: 'POST',
        url: `/api/provider-profiles/${profileId}/test`,
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
        }),
      });
      assert.equal(testRes.statusCode, 200);
      assert.equal(testRes.json().ok, true);
      assert.equal(new URL(calls[0].url).pathname, '/v1beta/models');
    } finally {
      restoreGlobalRoot();
      await rm(projectDir, { recursive: true, force: true });
      await app.close();
    }
  });

  it('accepts workspace projectPath even when validateProjectPath allowlist excludes it', async () => {
    const Fastify = (await import('fastify')).default;
    const { providerProfilesRoutes } = await import('../dist/routes/provider-profiles.js');
    const app = Fastify();
    await app.register(providerProfilesRoutes);
    await app.ready();

    const workspaceDir = await makeWorkspaceDir('switch');
    setGlobalRoot(workspaceDir);
    const previousRoots = process.env.PROJECT_ALLOWED_ROOTS;
    const previousAppend = process.env.PROJECT_ALLOWED_ROOTS_APPEND;
    process.env.PROJECT_ALLOWED_ROOTS = '/tmp';
    delete process.env.PROJECT_ALLOWED_ROOTS_APPEND;

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/provider-profiles?projectPath=${encodeURIComponent(workspaceDir)}`,
        headers: AUTH_HEADERS,
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().projectPath, await realpath(workspaceDir));
    } finally {
      restoreGlobalRoot();
      if (previousRoots === undefined) delete process.env.PROJECT_ALLOWED_ROOTS;
      else process.env.PROJECT_ALLOWED_ROOTS = previousRoots;
      if (previousAppend === undefined) delete process.env.PROJECT_ALLOWED_ROOTS_APPEND;
      else process.env.PROJECT_ALLOWED_ROOTS_APPEND = previousAppend;
      await rm(workspaceDir, { recursive: true, force: true });
      await app.close();
    }
  });

  it('defaults projectPath to CAT_TEMPLATE_PATH directory when query omits projectPath', async () => {
    const Fastify = (await import('fastify')).default;
    const { providerProfilesRoutes } = await import('../dist/routes/provider-profiles.js');
    const app = Fastify();
    await app.register(providerProfilesRoutes);
    await app.ready();

    const projectDir = await makeTmpDir('default-root');
    setGlobalRoot(projectDir);
    const templatePath = join(projectDir, 'cat-template.json');
    await writeFile(templatePath, '{}\n', 'utf-8');
    const prevTemplate = process.env.CAT_TEMPLATE_PATH;
    process.env.CAT_TEMPLATE_PATH = templatePath;

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/provider-profiles',
        headers: AUTH_HEADERS,
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().projectPath, await realpath(projectDir));
    } finally {
      restoreGlobalRoot();
      if (prevTemplate === undefined) delete process.env.CAT_TEMPLATE_PATH;
      else process.env.CAT_TEMPLATE_PATH = prevTemplate;
      await rm(projectDir, { recursive: true, force: true });
      await app.close();
    }
  });
});
