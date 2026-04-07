// @ts-check
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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

  // F136 Phase 4d: legacy v1/v2 migration tests removed — old provider-profiles.js store retired.
  // Migration to accounts is tested in account-startup-hook.test.js.

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
      // F136 Phase 4d: new response format — no legacy bootstrapBindings
      assert.equal(list.activeProfileId, null);
      assert.deepEqual(list.bootstrapBindings, {});
      const listed = list.providers.find((p) => p.id === created.profile.id);
      assert.ok(listed, 'created profile should appear in list');
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

  it('POST /api/provider-profiles assigns unique IDs when displayName collides', async () => {
    const Fastify = (await import('fastify')).default;
    const { providerProfilesRoutes } = await import('../dist/routes/provider-profiles.js');
    const app = Fastify();
    await app.register(providerProfilesRoutes);
    await app.ready();

    const projectDir = await makeTmpDir('slug-collision');
    setGlobalRoot(projectDir);
    try {
      const first = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          displayName: 'My Sponsor',
          authType: 'api_key',
          baseUrl: 'https://api.first.example',
          apiKey: 'sk-first',
        }),
      });
      assert.equal(first.statusCode, 200, 'first create should succeed');
      const firstId = first.json().profile.id;

      const second = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          displayName: 'My Sponsor',
          authType: 'api_key',
          baseUrl: 'https://api.second.example',
          apiKey: 'sk-second',
        }),
      });
      assert.equal(second.statusCode, 200, 'second create with same name should succeed');
      const secondId = second.json().profile.id;
      assert.notEqual(firstId, secondId, 'duplicate displayName must produce different IDs');

      const listRes = await app.inject({
        method: 'GET',
        url: `/api/provider-profiles?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });
      const list = listRes.json();
      const ids = list.providers.map((p) => p.id);
      assert.ok(ids.includes(firstId), 'first profile must still exist');
      assert.ok(ids.includes(secondId), 'second profile must exist alongside first');
    } finally {
      restoreGlobalRoot();
      await rm(projectDir, { recursive: true, force: true });
      await app.close();
    }
  });

  it('PATCH /api/provider-profiles/:id clears credential when apiKey is empty string', async () => {
    const Fastify = (await import('fastify')).default;
    const { providerProfilesRoutes } = await import('../dist/routes/provider-profiles.js');
    const app = Fastify();
    await app.register(providerProfilesRoutes);
    await app.ready();

    const projectDir = await makeTmpDir('clear-cred');
    setGlobalRoot(projectDir);
    try {
      // Create profile with apiKey
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          displayName: 'Clearable',
          authType: 'api_key',
          apiKey: 'sk-to-clear',
        }),
      });
      assert.equal(createRes.statusCode, 200);
      const profileId = createRes.json().profile.id;
      assert.equal(createRes.json().profile.hasApiKey, true, 'should have credential after create');

      // PATCH with empty apiKey to clear credential
      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/provider-profiles/${profileId}`,
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          apiKey: '',
        }),
      });
      assert.equal(patchRes.statusCode, 200);
      assert.equal(
        patchRes.json().profile.hasApiKey,
        false,
        'credential should be cleared after PATCH with empty apiKey',
      );

      // Verify via GET
      const listRes = await app.inject({
        method: 'GET',
        url: `/api/provider-profiles?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });
      const profile = listRes.json().providers.find((p) => p.id === profileId);
      assert.equal(profile.hasApiKey, false, 'credential should remain cleared');
    } finally {
      restoreGlobalRoot();
      await rm(projectDir, { recursive: true, force: true });
      await app.close();
    }
  });

  it('PATCH /api/provider-profiles/:id preserves existing protocol when baseUrl changes without explicit override', async () => {
    const Fastify = (await import('fastify')).default;
    const { providerProfilesRoutes } = await import('../dist/routes/provider-profiles.js');
    const app = Fastify();
    await app.register(providerProfilesRoutes);
    await app.ready();

    const projectDir = await makeTmpDir('reinfer-proto');
    setGlobalRoot(projectDir);
    try {
      // Create an anthropic account behind a vendor-neutral proxy URL.
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          displayName: 'Anthropic Proxy',
          authType: 'api_key',
          protocol: 'anthropic',
          baseUrl: 'https://proxy.example.com/v1',
          apiKey: 'sk-test',
          models: ['claude-sonnet-4-5'],
        }),
      });
      assert.equal(createRes.statusCode, 200);
      const profileId = createRes.json().profile.id;
      assert.equal(createRes.json().profile.protocol, 'anthropic');

      // Normal proxy baseUrl maintenance must not silently rewrite the account family.
      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/provider-profiles/${profileId}`,
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          baseUrl: 'https://proxy-2.example.com/v1',
        }),
      });
      assert.equal(patchRes.statusCode, 200);
      assert.equal(
        patchRes.json().profile.protocol,
        'anthropic',
        'hidden protocol must be preserved across baseUrl-only edits',
      );
    } finally {
      restoreGlobalRoot();
      await rm(projectDir, { recursive: true, force: true });
      await app.close();
    }
  });

  it('PATCH keeps current protocol even when the new baseUrl would hint another family', async () => {
    const Fastify = (await import('fastify')).default;
    const { providerProfilesRoutes } = await import('../dist/routes/provider-profiles.js');
    const app = Fastify();
    await app.register(providerProfilesRoutes);
    await app.ready();

    const projectDir = await makeTmpDir('reinfer-name-trap');
    setGlobalRoot(projectDir);
    try {
      // displayName "Codex Sponsor" contains "codex" → would match openai in nameHints
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          displayName: 'Codex Sponsor',
          authType: 'api_key',
          baseUrl: 'https://proxy.example.com',
          apiKey: 'sk-test',
          models: ['gpt-5.4'],
        }),
      });
      assert.equal(createRes.statusCode, 200);
      const profileId = createRes.json().profile.id;
      assert.equal(createRes.json().profile.protocol, 'openai');

      // PATCH baseUrl to an anthropic-looking endpoint — protocol should stay openai.
      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/provider-profiles/${profileId}`,
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          baseUrl: 'https://api.minimaxi.com/anthropic',
        }),
      });
      assert.equal(patchRes.statusCode, 200);
      assert.equal(
        patchRes.json().profile.protocol,
        'openai',
        'hidden protocol must not be silently reclassified by a new baseUrl hint',
      );
    } finally {
      restoreGlobalRoot();
      await rm(projectDir, { recursive: true, force: true });
      await app.close();
    }
  });

  it('PATCH /api/provider-profiles/:id accepts explicit protocol override for API clients', async () => {
    const Fastify = (await import('fastify')).default;
    const { providerProfilesRoutes } = await import('../dist/routes/provider-profiles.js');
    const app = Fastify();
    await app.register(providerProfilesRoutes);
    await app.ready();

    const projectDir = await makeTmpDir('patch-explicit-protocol');
    setGlobalRoot(projectDir);
    try {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/provider-profiles',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          displayName: 'proxy-account',
          authType: 'api_key',
          baseUrl: 'https://proxy.example.com',
          apiKey: 'sk-test',
          models: ['gpt-5.4'],
        }),
      });
      assert.equal(createRes.statusCode, 200);
      const profileId = createRes.json().profile.id;

      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/provider-profiles/${profileId}`,
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        payload: JSON.stringify({
          projectPath: projectDir,
          baseUrl: 'https://api.minimaxi.com/anthropic',
          protocol: 'anthropic',
        }),
      });
      assert.equal(patchRes.statusCode, 200);
      assert.equal(patchRes.json().profile.protocol, 'anthropic');
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

  it('GET /api/provider-profiles returns correct client for non-standard builtins (dare/opencode)', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { writeCatalogAccount } = await import('../dist/config/catalog-accounts.js');
    const Fastify = (await import('fastify')).default;
    const { providerProfilesRoutes } = await import('../dist/routes/provider-profiles.js');
    const app = Fastify();
    await app.register(providerProfilesRoutes);
    await app.ready();

    const projectDir = await makeTmpDir('client-field');
    setGlobalRoot(projectDir);
    try {
      // Bootstrap minimal catalog
      const catCafeDir = join(projectDir, '.cat-cafe');
      mkdirSync(catCafeDir, { recursive: true });
      writeFileSync(
        join(catCafeDir, 'cat-catalog.json'),
        JSON.stringify({ version: 2, breeds: [], roster: {}, reviewPolicy: {}, accounts: {} }),
      );

      // Write builtin accounts with standard and non-standard clients
      writeCatalogAccount(projectDir, 'claude', { authType: 'oauth', protocol: 'anthropic', models: ['m1'] });
      writeCatalogAccount(projectDir, 'dare', { authType: 'oauth', protocol: 'openai', models: ['glm'] });
      writeCatalogAccount(projectDir, 'opencode', { authType: 'oauth', protocol: 'anthropic', models: ['m2'] });

      const res = await app.inject({
        method: 'GET',
        url: `/api/provider-profiles?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });
      assert.equal(res.statusCode, 200);
      const providers = res.json().providers;

      const claude = providers.find((p) => p.id === 'claude');
      assert.equal(claude.client, 'anthropic', 'claude builtin client should be protocol (anthropic)');

      const dare = providers.find((p) => p.id === 'dare');
      assert.equal(dare.client, 'dare', 'dare builtin client should be its own ID, not protocol');

      const opencode = providers.find((p) => p.id === 'opencode');
      assert.equal(opencode.client, 'opencode', 'opencode builtin client should be its own ID, not protocol');
    } finally {
      restoreGlobalRoot();
      await rm(projectDir, { recursive: true, force: true });
      await app.close();
    }
  });
});
