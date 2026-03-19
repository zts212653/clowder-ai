// @ts-check
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
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
    try {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          displayName: 'sponsor-route',
          authType: 'api_key',
          protocol: 'anthropic',
          baseUrl: 'https://api.route.dev',
          apiKey: 'sk-route',
          models: ['claude-opus-4-6'],
          setActive: true,
        }),
      });
      assert.equal(createRes.statusCode, 200);
      const created = createRes.json();
      assert.equal(created.profile.authType, 'api_key');
      assert.equal(created.profile.protocol, 'anthropic');
      assert.equal(created.profile.hasApiKey, true);

      const listRes = await app.inject({
        method: 'GET',
        url: `/api/provider-profiles?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });
      assert.equal(listRes.statusCode, 200);
      const list = listRes.json();
      assert.ok(Array.isArray(list.providers));
      assert.equal(list.activeProfileId, created.profile.id);
      assert.equal(list.activeProfileIds.anthropic, created.profile.id);
      assert.equal(list.activeProfileIds.openai, 'codex-oauth');
      assert.equal(list.activeProfileIds.google, 'gemini-oauth');
      assert.deepEqual(
        list.providers.slice(0, 3).map((profile) => profile.id),
        ['claude-oauth', 'codex-oauth', 'gemini-oauth'],
      );
      const listed = list.providers.find((p) => p.id === created.profile.id);
      assert.ok(listed);
      assert.equal(listed.hasApiKey, true);
    } finally {
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
    try {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          displayName: 'sponsor-test',
          authType: 'api_key',
          protocol: 'anthropic',
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
        }),
      });
      assert.equal(testRes.statusCode, 200);
      const body = testRes.json();
      assert.equal(body.ok, true);
    } finally {
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
    try {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          displayName: 'felix',
          authType: 'api_key',
          protocol: 'anthropic',
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
      assert.equal(body.status, 200);
      assert.deepEqual(
        calls.map((call) => `${call.method} ${new URL(call.url).pathname}`),
        ['GET /claudecode/v1/models', 'POST /claudecode/v1/messages'],
      );
    } finally {
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
    try {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          displayName: 'felix-invalid-model',
          authType: 'api_key',
          protocol: 'anthropic',
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
    try {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          displayName: '   ',
          authType: 'api_key',
          protocol: 'anthropic',
        }),
      });
      assert.equal(createRes.statusCode, 400);
    } finally {
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
    try {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          displayName: 'codex-sponsor',
          authType: 'api_key',
          protocol: 'openai',
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
      if (previousRoots === undefined) delete process.env.PROJECT_ALLOWED_ROOTS;
      else process.env.PROJECT_ALLOWED_ROOTS = previousRoots;
      if (previousAppend === undefined) delete process.env.PROJECT_ALLOWED_ROOTS_APPEND;
      else process.env.PROJECT_ALLOWED_ROOTS_APPEND = previousAppend;
      await rm(workspaceDir, { recursive: true, force: true });
      await app.close();
    }
  });
});
