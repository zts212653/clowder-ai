import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import {
  getTemplateFileInfo,
  getTemplateOverlayPath,
  TEMPLATES_DIR,
} from '../dist/domains/cats/services/context/prompt-template-loader.js';
import { promptInjectionRoutes } from '../dist/routes/prompt-injection.js';

const AUTH_HEADERS = { 'x-cat-cafe-user': 'test-user' };
const LOCAL_WRITE_HEADERS = {
  host: '127.0.0.1:3002',
  origin: 'http://127.0.0.1:3001',
};

/**
 * Focused test: YAML overlay endpoints must reject non-object YAML values.
 * Regression for codex-connector P2: `YAML.parse("null")` returns null,
 * `Object.entries(null)` throws, crashing prompt construction downstream.
 *
 * Write endpoints (PUT) require session-only auth (cookie-backed sessionUserId),
 * not header-based identity. Tests simulate this via onRequest hook.
 */
describe('prompt-injection YAML validation', () => {
  /** Build app WITHOUT session — for read/preview endpoints that accept header auth */
  async function buildApp() {
    const app = Fastify({ logger: false });
    await app.register(promptInjectionRoutes);
    await app.ready();
    return app;
  }

  /** Build app WITH simulated session — for write endpoints that require session cookie */
  async function buildSessionApp() {
    const app = Fastify({ logger: false });
    app.addHook('onRequest', (req, _reply, done) => {
      req.sessionUserId = 'test-user';
      done();
    });
    await app.register(promptInjectionRoutes);
    await app.ready();
    return app;
  }

  // S6 is the YAML segment (workflow-triggers)
  const YAML_SEGMENT = 'S6';

  function snapshotFile(path) {
    return existsSync(path) ? readFileSync(path, 'utf-8') : null;
  }

  function restoreFile(path, content) {
    if (content === null) {
      if (existsSync(path)) unlinkSync(path);
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
  }

  async function withPreservedOverlay(segmentId, fn) {
    const fileInfo = getTemplateFileInfo(segmentId);
    assert.ok(fileInfo?.local, `${segmentId} should have a local overlay path`);
    const localPath = getTemplateOverlayPath(segmentId);
    assert.ok(localPath, `${segmentId} should resolve a writable overlay path`);
    const bakPath = `${localPath}.bak`;
    const assetLocalPath = join(TEMPLATES_DIR, fileInfo.local);
    const assetBakPath = `${assetLocalPath}.bak`;
    const localSnapshot = snapshotFile(localPath);
    const bakSnapshot = snapshotFile(bakPath);
    const assetLocalSnapshot = snapshotFile(assetLocalPath);
    const assetBakSnapshot = snapshotFile(assetBakPath);
    try {
      await fn();
    } finally {
      restoreFile(localPath, localSnapshot);
      restoreFile(bakPath, bakSnapshot);
      restoreFile(assetLocalPath, assetLocalSnapshot);
      restoreFile(assetBakPath, assetBakSnapshot);
    }
  }

  describe('POST /api/prompt-injection/segment/:id/preview', () => {
    it('rejects null YAML with 400', async () => {
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/prompt-injection/segment/${YAML_SEGMENT}/preview`,
          headers: AUTH_HEADERS,
          payload: { content: 'null' },
        });
        assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}`);
        const body = JSON.parse(res.body);
        assert.ok(body.error, 'response should have error field');
        assert.match(body.error, /mapping|object/i, 'error should mention mapping/object');
      } finally {
        await app.close();
      }
    });

    it('rejects scalar YAML with 400', async () => {
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/prompt-injection/segment/${YAML_SEGMENT}/preview`,
          headers: AUTH_HEADERS,
          payload: { content: '42' },
        });
        assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}`);
        const body = JSON.parse(res.body);
        assert.match(body.error, /mapping|object/i);
      } finally {
        await app.close();
      }
    });

    it('rejects array YAML with 400', async () => {
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/prompt-injection/segment/${YAML_SEGMENT}/preview`,
          headers: AUTH_HEADERS,
          payload: { content: '- item1\n- item2' },
        });
        assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}`);
        const body = JSON.parse(res.body);
        assert.match(body.error, /mapping|object/i);
      } finally {
        await app.close();
      }
    });

    it('accepts valid YAML mapping', async () => {
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/prompt-injection/segment/${YAML_SEGMENT}/preview`,
          headers: AUTH_HEADERS,
          payload: { content: 'ragdoll: "test value"' },
        });
        assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}`);
        const body = JSON.parse(res.body);
        assert.equal(body.segmentId, YAML_SEGMENT);
        assert.ok(body.rendered, 'should have rendered field');
      } finally {
        await app.close();
      }
    });
  });

  describe('PUT /api/prompt-injection/segment/:id/override', () => {
    it('rejects header-only auth with 401 (requires session cookie)', async () => {
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/prompt-injection/segment/${YAML_SEGMENT}/override`,
          headers: AUTH_HEADERS,
          payload: { content: 'ragdoll: "valid"' },
        });
        assert.equal(res.statusCode, 401, `expected 401, got ${res.statusCode}`);
      } finally {
        await app.close();
      }
    });

    it('rejects non-owner session with 403 when DEFAULT_OWNER_USER_ID is set', async () => {
      const prev = process.env.DEFAULT_OWNER_USER_ID;
      process.env.DEFAULT_OWNER_USER_ID = 'real-owner';
      try {
        // buildSessionApp sets sessionUserId = 'test-user' (not the owner)
        const app = await buildSessionApp();
        try {
          const res = await app.inject({
            method: 'PUT',
            url: `/api/prompt-injection/segment/${YAML_SEGMENT}/override`,
            headers: LOCAL_WRITE_HEADERS,
            payload: { content: 'ragdoll: "valid"' },
          });
          assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}`);
          const body = JSON.parse(res.body);
          assert.ok(body.error, 'response should have error field');
        } finally {
          await app.close();
        }
      } finally {
        if (prev === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
        else process.env.DEFAULT_OWNER_USER_ID = prev;
      }
    });

    it('rejects session writes that do not come from direct localhost Hub access', async () => {
      await withPreservedOverlay(YAML_SEGMENT, async () => {
        const app = await buildSessionApp();
        try {
          const res = await app.inject({
            method: 'PUT',
            url: `/api/prompt-injection/segment/${YAML_SEGMENT}/override`,
            payload: { content: 'ragdoll: "valid"' },
          });
          assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${res.body}`);
          const body = JSON.parse(res.body);
          assert.match(body.error, /localhost|loopback|local/i);
        } finally {
          await app.close();
        }
      });
    });

    it('rejects null YAML with 400 (session auth)', async () => {
      const app = await buildSessionApp();
      try {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/prompt-injection/segment/${YAML_SEGMENT}/override`,
          headers: LOCAL_WRITE_HEADERS,
          payload: { content: 'null' },
        });
        assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}`);
        const body = JSON.parse(res.body);
        assert.ok(body.error, 'response should have error field');
        assert.match(body.error, /mapping|object/i, 'error should mention mapping/object');
      } finally {
        await app.close();
      }
    });

    it('rejects scalar YAML with 400 (session auth)', async () => {
      const app = await buildSessionApp();
      try {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/prompt-injection/segment/${YAML_SEGMENT}/override`,
          headers: LOCAL_WRITE_HEADERS,
          payload: { content: 'just a string' },
        });
        assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}`);
        const body = JSON.parse(res.body);
        assert.match(body.error, /mapping|object/i);
      } finally {
        await app.close();
      }
    });

    it('writes valid overlays under .cat-cafe prompt-overlays instead of assets', async () => {
      await withPreservedOverlay(YAML_SEGMENT, async () => {
        const fileInfo = getTemplateFileInfo(YAML_SEGMENT);
        const overlayPath = getTemplateOverlayPath(YAML_SEGMENT);
        assert.ok(fileInfo?.local);
        assert.ok(overlayPath);
        const assetLocalPath = join(TEMPLATES_DIR, fileInfo.local);
        restoreFile(overlayPath, null);
        restoreFile(`${overlayPath}.bak`, null);
        restoreFile(assetLocalPath, null);

        const app = await buildSessionApp();
        try {
          const content = 'ragdoll: "valid overlay"';
          const res = await app.inject({
            method: 'PUT',
            url: `/api/prompt-injection/segment/${YAML_SEGMENT}/override`,
            headers: LOCAL_WRITE_HEADERS,
            payload: { content },
          });
          assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
          assert.equal(readFileSync(overlayPath, 'utf-8'), content);
          assert.equal(
            existsSync(assetLocalPath),
            false,
            'overlay save must not create a .local file in packaged assets/prompt-templates',
          );
        } finally {
          await app.close();
        }
      });
    });
  });

  describe('DELETE /api/prompt-injection/segment/:id/override', () => {
    it('rejects readonly template-backed segments with 403', async () => {
      const app = await buildSessionApp();
      try {
        const res = await app.inject({
          method: 'DELETE',
          url: '/api/prompt-injection/segment/S1/override',
          headers: LOCAL_WRITE_HEADERS,
        });
        assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${res.body}`);
        const body = JSON.parse(res.body);
        assert.match(body.error, /readonly/i);
      } finally {
        await app.close();
      }
    });
  });

  describe('overlay write durability', () => {
    it('uses tmp+rename for overlay saves, backups, and restore-backup', () => {
      const source = readFileSync(new URL('../src/routes/prompt-injection.ts', import.meta.url), 'utf-8');
      assert.match(source, /renameSync/, 'overlay write route should use atomic rename');
      assert.doesNotMatch(
        source,
        /writeFileSync\(localPath,\s*content/,
        'overlay save must not write directly to localPath',
      );
      assert.doesNotMatch(source, /copyFileSync\(localPath,\s*bakPath/, 'backup must not copy directly to final .bak');
      assert.doesNotMatch(source, /copyFileSync\(bakPath,\s*localPath/, 'restore must not copy directly to localPath');
    });
  });
});
