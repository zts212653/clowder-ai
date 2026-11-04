import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MarketplacePreparationError } from '../dist/domains/plugin/manager/marketplace/git-marketplace-preparation.js';
import { PluginManagerServiceError } from '../dist/domains/plugin/manager/plugin-manager-service.js';
import { OfficialPluginInstallError } from '../dist/domains/plugin/official-package-errors.js';
import { pluginManagerUploadRoutes, registerPluginManagerRoutes } from '../dist/routes/plugin-manager-routes.js';

test('Git preparation failure reaches HTTP and one request-correlated sanitized diagnostic', async (t) => {
  const logs = [];
  const app = Fastify({
    genReqId: () => 'marketplace-install-failure',
    logger: { level: 'warn', stream: { write: (line) => logs.push(JSON.parse(line)) } },
  });
  t.after(() => app.close());
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user';
  });
  const cause = new MarketplacePreparationError({
    stage: 'install',
    requestedVersion: '9.15.4',
    actualVersion: '9.15.4',
    exitCode: 17,
    output: 'ERR_PNPM_IGNORED_BUILDS Bearer ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD',
  });
  registerPluginManagerRoutes(app, {
    manager: {
      install: async () => {
        throw new PluginManagerServiceError('INSTALL_UNAVAILABLE', cause.message, { cause });
      },
    },
    auditLog: { append: async () => {} },
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/plugin-manager/plugins/install',
    remoteAddress: '127.0.0.1',
    headers: { host: 'localhost', origin: 'http://localhost' },
    payload: { source: { kind: 'git', url: 'https://example.invalid/marketplace.git' } },
  });
  assert.equal(response.statusCode, 503, response.payload);
  assert.equal(response.json().code, 'INSTALL_UNAVAILABLE');
  assert.match(response.json().error, /ERR_PNPM_IGNORED_BUILDS/);
  const failures = logs.filter((row) => row.msg === 'Plugin package operation failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reqId, 'marketplace-install-failure');
  assert.equal(failures[0].preparation.stage, 'install');
  assert.equal(failures[0].preparation.actualVersion, '9.15.4');
  assert.equal(failures[0].preparation.exitCode, 17);
  assert.equal(
    JSON.stringify({ logs, payload: response.payload }).includes('ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD'),
    false,
  );
  assert.equal('cause' in failures[0], false);
  assert.equal('stack' in failures[0], false);
});

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
