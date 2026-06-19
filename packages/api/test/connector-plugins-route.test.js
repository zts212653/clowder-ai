import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const { connectorPluginRoutes, writeUploadedPluginArchive } = await import('../dist/routes/connector-plugins.js');

let previousConfigRoot;
let previousOwnerUserId;
let previousFrontendUrl;
const tempRoots = [];

afterEach(() => {
  if (previousConfigRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
  else process.env.CAT_CAFE_CONFIG_ROOT = previousConfigRoot;
  previousConfigRoot = undefined;

  if (previousOwnerUserId === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
  else process.env.DEFAULT_OWNER_USER_ID = previousOwnerUserId;
  previousOwnerUserId = undefined;

  if (previousFrontendUrl === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = previousFrontendUrl;
  previousFrontendUrl = undefined;

  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function useTempConfigRoot() {
  previousConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
  const root = mkdtempSync(join(os.tmpdir(), 'connector-plugin-route-'));
  tempRoots.push(root);
  process.env.CAT_CAFE_CONFIG_ROOT = root;
  return root;
}

function setOwnerUserId(ownerUserId) {
  previousOwnerUserId = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = ownerUserId;
}

function clearOwnerUserId() {
  previousOwnerUserId = process.env.DEFAULT_OWNER_USER_ID;
  delete process.env.DEFAULT_OWNER_USER_ID;
}

function setFrontendUrl(frontendUrl) {
  previousFrontendUrl = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = frontendUrl;
}

async function buildPluginRouteApp() {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    const raw = request.headers['x-test-session-user'];
    if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
  });
  await app.register(connectorPluginRoutes);
  await app.ready();
  return app;
}

describe('writeUploadedPluginArchive', () => {
  it('creates uploaded plugin archives with owner-only permissions', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'connector-plugin-upload-mode-'));
    tempRoots.push(root);
    const archivePath = join(root, 'plugin.tar.gz');

    await writeUploadedPluginArchive(archivePath, Buffer.from('archive-bytes'));

    assert.equal(statSync(archivePath).mode & 0o777, 0o600);
  });
});

describe('GET /api/connectors/plugins/:id/icon', () => {
  it('rejects icon symlinks that resolve outside the plugin directory', async () => {
    const root = useTempConfigRoot();
    const pluginDir = join(root, '.cat-cafe', 'plugins', 'icon-symlink');
    const secretPath = join(root, 'outside-secret.txt');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(secretPath, 'outside-secret');
    symlinkSync(secretPath, join(pluginDir, 'icon.png'));
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      [
        'id: icon-symlink',
        'name: Icon Symlink',
        'nameEn: Icon Symlink',
        'version: 1.0.0',
        'icon:',
        '  type: png',
        '  src: icon.png',
        'themeColor: "#336699"',
        'docsUrl: https://example.com/icon-symlink',
        'config: []',
        'steps:',
        '  - text: Step',
      ].join('\n'),
    );

    const app = Fastify();
    await app.register(connectorPluginRoutes);
    await app.ready();

    try {
      const res = await app.inject({ method: 'GET', url: '/api/connectors/plugins/icon-symlink/icon' });

      assert.equal(res.statusCode, 404);
      assert.notEqual(res.body, 'outside-secret');
    } finally {
      await app.close();
    }
  });

  it('rejects icon paths that escape through a prefix sibling directory', async () => {
    const root = useTempConfigRoot();
    const pluginsDir = join(root, '.cat-cafe', 'plugins');
    const pluginDir = join(pluginsDir, 'a');
    const siblingDir = join(pluginsDir, 'abc');
    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(join(siblingDir, 'index.js'), 'neighbor-secret');
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      [
        'id: a',
        'name: A',
        'nameEn: A',
        'version: 1.0.0',
        'icon:',
        '  type: png',
        '  src: ../abc/index.js',
        'themeColor: "#336699"',
        'docsUrl: https://example.com/a',
        'config: []',
        'steps:',
        '  - text: Step',
      ].join('\n'),
    );

    const app = Fastify();
    await app.register(connectorPluginRoutes);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/connectors/plugins/a/icon' });

    assert.equal(res.statusCode, 404);
    assert.notEqual(res.body, 'neighbor-secret');

    await app.close();
  });
});

describe('POST /api/connectors/plugins/install auth boundary', () => {
  it('requires a session identity before plugin install', async () => {
    setOwnerUserId('owner-user');
    const app = await buildPluginRouteApp();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/plugins/install',
        headers: { origin: 'http://localhost:3003', host: 'localhost:3003' },
      });

      assert.equal(res.statusCode, 401);
      assert.match(res.body, /authentication|session/i);
    } finally {
      await app.close();
    }
  });

  it('requires DEFAULT_OWNER_USER_ID before plugin install', async () => {
    clearOwnerUserId();
    const app = await buildPluginRouteApp();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/plugins/install',
        headers: {
          'x-test-session-user': 'single-user',
          origin: 'http://localhost:3003',
          host: 'localhost:3003',
        },
      });

      assert.equal(res.statusCode, 403);
      assert.match(res.body, /DEFAULT_OWNER_USER_ID|configured owner/i);
    } finally {
      await app.close();
    }
  });

  it('rejects non-owner sessions before plugin install', async () => {
    setOwnerUserId('owner-user');
    const app = await buildPluginRouteApp();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/plugins/install',
        headers: {
          'x-test-session-user': 'other-user',
          origin: 'http://localhost:3003',
          host: 'localhost:3003',
        },
      });

      assert.equal(res.statusCode, 403);
      assert.match(res.body, /owner/i);
    } finally {
      await app.close();
    }
  });

  it('rejects cross-origin browser plugin install attempts', async () => {
    setOwnerUserId('owner-user');
    const app = await buildPluginRouteApp();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/plugins/install',
        headers: {
          'x-test-session-user': 'owner-user',
          origin: 'https://evil.example',
          host: 'localhost:3003',
        },
      });

      assert.equal(res.statusCode, 403);
      assert.match(res.body, /same-origin|origin/i);
    } finally {
      await app.close();
    }
  });

  it('allows configured owner from trusted frontend origin through to upload validation', async () => {
    setOwnerUserId('owner-user');
    setFrontendUrl('https://hub.example.test');
    const app = await buildPluginRouteApp();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/plugins/install',
        headers: {
          'x-test-session-user': 'owner-user',
          origin: 'https://hub.example.test',
          host: 'api.example.test',
          'content-type': 'multipart/form-data; boundary=test-boundary',
        },
        payload: '--test-boundary--\r\n',
        remoteAddress: '203.0.113.10',
      });

      assert.equal(res.statusCode, 400);
      assert.match(res.body, /No file uploaded/);
    } finally {
      await app.close();
    }
  });
});

describe('DELETE /api/connectors/plugins/:id auth boundary', () => {
  it('rejects non-owner sessions before plugin uninstall', async () => {
    setOwnerUserId('owner-user');
    const app = await buildPluginRouteApp();

    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/connectors/plugins/missing-plugin',
        headers: {
          'x-test-session-user': 'other-user',
          origin: 'http://localhost:3003',
          host: 'localhost:3003',
        },
      });

      assert.equal(res.statusCode, 403);
      assert.match(res.body, /owner/i);
    } finally {
      await app.close();
    }
  });

  it('allows configured owner from trusted frontend origin through to uninstall lookup', async () => {
    setOwnerUserId('owner-user');
    setFrontendUrl('https://hub.example.test');
    const app = await buildPluginRouteApp();

    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/connectors/plugins/missing-plugin',
        headers: {
          'x-test-session-user': 'owner-user',
          origin: 'https://hub.example.test',
          host: 'api.example.test',
        },
        remoteAddress: '203.0.113.10',
      });

      assert.equal(res.statusCode, 404);
      assert.match(res.body, /not installed/);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/connectors/plugins', () => {
  it('requires a session identity before listing installed plugins', async () => {
    const root = useTempConfigRoot();
    const pluginDir = join(root, '.cat-cafe', 'plugins', 'listed-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      'id: listed-plugin\nname: Listed Plugin\nconfig: []\nsteps:\n  - text: Step\n',
    );
    writeFileSync(join(pluginDir, 'index.js'), 'export default {};\n');

    const app = Fastify();
    await app.register(connectorPluginRoutes);
    await app.ready();

    try {
      const res = await app.inject({ method: 'GET', url: '/api/connectors/plugins' });

      assert.equal(res.statusCode, 401);
      assert.match(res.body, /session/i);
      assert.doesNotMatch(res.body, /listed-plugin/);
    } finally {
      await app.close();
    }
  });

  it('requires DEFAULT_OWNER_USER_ID before listing installed plugins', async () => {
    clearOwnerUserId();
    const root = useTempConfigRoot();
    const pluginDir = join(root, '.cat-cafe', 'plugins', 'listed-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      'id: listed-plugin\nname: Listed Plugin\nconfig: []\nsteps:\n  - text: Step\n',
    );
    writeFileSync(join(pluginDir, 'index.js'), 'export default {};\n');

    const app = await buildPluginRouteApp();

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/connectors/plugins',
        headers: { 'x-test-session-user': 'single-user' },
      });

      assert.equal(res.statusCode, 403);
      assert.match(res.body, /DEFAULT_OWNER_USER_ID|configured owner/i);
      assert.doesNotMatch(res.body, /listed-plugin/);
    } finally {
      await app.close();
    }
  });

  it('rejects non-owner sessions before listing installed plugins', async () => {
    setOwnerUserId('owner-user');
    const root = useTempConfigRoot();
    const pluginDir = join(root, '.cat-cafe', 'plugins', 'listed-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      'id: listed-plugin\nname: Listed Plugin\nconfig: []\nsteps:\n  - text: Step\n',
    );
    writeFileSync(join(pluginDir, 'index.js'), 'export default {};\n');

    const app = await buildPluginRouteApp();

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/connectors/plugins',
        headers: { 'x-test-session-user': 'other-user' },
      });

      assert.equal(res.statusCode, 403);
      assert.match(res.body, /owner/i);
      assert.doesNotMatch(res.body, /listed-plugin/);
    } finally {
      await app.close();
    }
  });

  it('rejects cross-origin browser plugin list attempts', async () => {
    setOwnerUserId('owner-user');
    const root = useTempConfigRoot();
    const pluginDir = join(root, '.cat-cafe', 'plugins', 'listed-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      'id: listed-plugin\nname: Listed Plugin\nconfig: []\nsteps:\n  - text: Step\n',
    );
    writeFileSync(join(pluginDir, 'index.js'), 'export default {};\n');

    const app = await buildPluginRouteApp();

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/connectors/plugins',
        headers: {
          'x-test-session-user': 'owner-user',
          origin: 'https://evil.example',
          host: 'localhost:3003',
        },
      });

      assert.equal(res.statusCode, 403);
      assert.match(res.body, /same-origin|origin/i);
      assert.doesNotMatch(res.body, /listed-plugin/);
    } finally {
      await app.close();
    }
  });

  it('does not expose installed plugin filesystem paths', async () => {
    setOwnerUserId('owner-user');
    setFrontendUrl('https://hub.example.test');
    const root = useTempConfigRoot();
    const pluginDir = join(root, '.cat-cafe', 'plugins', 'listed-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      'id: listed-plugin\nname: Listed Plugin\nconfig: []\nsteps:\n  - text: Step\n',
    );
    writeFileSync(join(pluginDir, 'index.js'), 'export default {};\n');

    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      const raw = request.headers['x-test-session-user'];
      if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
    });
    await app.register(connectorPluginRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/connectors/plugins',
        headers: {
          'x-test-session-user': 'owner-user',
          origin: 'https://hub.example.test',
          host: 'api.example.test',
        },
        remoteAddress: '203.0.113.10',
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.plugins.length, 1);
      assert.equal(body.plugins[0].id, 'listed-plugin');
      assert.equal(body.plugins[0].name, 'Listed Plugin');
      assert.equal(body.plugins[0].directory, undefined);
      assert.doesNotMatch(res.body, /\\.cat-cafe/);
    } finally {
      await app.close();
    }
  });
});
