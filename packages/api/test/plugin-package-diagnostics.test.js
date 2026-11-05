import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { PluginManagerServiceError } from '../dist/domains/plugin/manager/plugin-manager-service.js';
import { OfficialPluginInstallError } from '../dist/domains/plugin/official-package-errors.js';
import { pluginManagerUploadRoutes, registerPluginManagerRoutes } from '../dist/routes/plugin-manager-routes.js';

test('install, update and upload failures log one safe request-correlated diagnostic', async () => {
  const logs = [];
  const app = Fastify({ logger: { level: 'warn', stream: { write: (line) => logs.push(JSON.parse(line)) } } });
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user';
  });
  const fail = async () => {
    throw new OfficialPluginInstallError('UNSUPPORTED_TRANSPORT', 'unsupported package', {
      cause: new Error('SECRET_ERROR_CAUSE D:/private-owner/config.json'),
    });
  };
  const routes = { manager: { install: fail, update: fail }, auditLog: { append: async () => {} } };
  registerPluginManagerRoutes(app, routes);
  await app.register(pluginManagerUploadRoutes, routes);
  const boundary = '----diagnostic-fixture';
  const cases = [
    {
      url: '/api/plugin-manager/plugins/install',
      payload: {
        source: { kind: 'catalog', catalogId: 'codeagent' },
        expectedVersion: '0.1.0',
        expectedDigest: `sha512-${Buffer.alloc(64).toString('base64')}`,
      },
    },
    {
      url: '/api/plugin-manager/plugins/official.codeagent/update',
      payload: { expectedVersion: '0.2.0', expectedRevision: 1 },
    },
    {
      url: '/api/plugin-manager/plugins/install/upload',
      contentType: `multipart/form-data; boundary=${boundary}`,
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="SECRET_FILENAME.tgz"\r\nContent-Type: application/gzip\r\n\r\nSECRET_ARCHIVE_BYTES\r\n--${boundary}--\r\n`,
      ),
    },
  ];
  try {
    for (const fixture of cases) {
      const response = await app.inject({
        method: 'POST',
        ...fixture,
        remoteAddress: '127.0.0.1',
        headers: {
          host: 'localhost',
          origin: 'http://localhost',
          authorization: 'Bearer SECRET_AUTHORIZATION',
          ...(fixture.contentType ? { 'content-type': fixture.contentType } : {}),
        },
      });
      assert.equal(response.statusCode, 422, response.payload);
    }
    const failures = logs.filter((row) => row.msg === 'Plugin package operation failed');
    assert.equal(failures.length, 3);
    assert.deepEqual(
      failures.map((row) => row.code),
      Array(3).fill('UNSUPPORTED_TRANSPORT'),
    );
    assert.deepEqual(
      failures.map((row) => row.operation),
      ['install', 'update', 'install'],
    );
    assert.ok(failures.every((row) => typeof row.reqId === 'string'));
    assert.equal(failures[0].catalogId, 'codeagent');
    assert.equal(failures[1].pluginId, 'official.codeagent');
    assert.equal(failures[2].sourceKind, 'local-archive');
    assert.doesNotMatch(JSON.stringify(logs), /SECRET_|private-owner/);
  } finally {
    await app.close();
  }
});

test('marketplace preparation failure logs only its pre-sanitized bounded diagnostic', async () => {
  const logs = [];
  const app = Fastify({ logger: { level: 'warn', stream: { write: (line) => logs.push(JSON.parse(line)) } } });
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user';
  });
  const failure = new PluginManagerServiceError(
    'INSTALL_UNAVAILABLE',
    'Marketplace dependency install failed (pnpm@9.15.4, exit 1): ERR_PNPM_IGNORED_BUILDS',
    {
      packageManager: 'pnpm@9.15.4',
      phase: 'install',
      exitCode: 1,
      stderrExcerpt: 'ERR_PNPM_IGNORED_BUILDS: [TOKEN_REDACTED] at ~\\marketplace',
    },
  );
  const routes = {
    manager: {
      install: async () => {
        throw failure;
      },
    },
    auditLog: { append: async () => {} },
  };
  registerPluginManagerRoutes(app, routes);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/plugin-manager/plugins/install',
      headers: { host: 'localhost', origin: 'http://localhost' },
      payload: {
        source: {
          kind: 'git',
          url: 'https://example.invalid/plugins.git',
          marketplace: {
            sourceId: 'a'.repeat(24),
            commit: 'b'.repeat(40),
            path: 'packages/demo',
            pluginId: 'example.demo',
            version: '1.0.0',
          },
        },
      },
    });
    assert.equal(response.statusCode, 503, response.payload);
    assert.match(response.json().error, /ERR_PNPM_IGNORED_BUILDS/);
    const [logged] = logs.filter((row) => row.msg === 'Plugin package operation failed');
    assert.deepEqual(
      {
        code: logged.code,
        packageManager: logged.packageManager,
        phase: logged.phase,
        exitCode: logged.exitCode,
        stderrExcerpt: logged.stderrExcerpt,
      },
      {
        code: 'INSTALL_UNAVAILABLE',
        packageManager: 'pnpm@9.15.4',
        phase: 'install',
        exitCode: 1,
        stderrExcerpt: 'ERR_PNPM_IGNORED_BUILDS: [TOKEN_REDACTED] at ~\\marketplace',
      },
    );
  } finally {
    await app.close();
  }
});
