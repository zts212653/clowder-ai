import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import {
  getTemplateFileInfo,
  getTemplateOverlayPath,
  TEMPLATES_DIR,
} from '../dist/domains/cats/services/context/prompt-template-loader.js';
import { parseHookManifest } from '../dist/domains/prompt-hooks/hook-manifest-parser.js';
import { promptInjectionRoutes } from '../dist/routes/prompt-injection.js';

const TEST_USER_ID = 'test-user';
const AUTH_HEADERS = { 'x-cat-cafe-user': TEST_USER_ID };
const LOCAL_WRITE_HEADERS = {
  host: '127.0.0.1:3004',
  origin: 'http://127.0.0.1:3003',
};

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(promptInjectionRoutes);
  await app.ready();
  return app;
}

async function buildSessionApp() {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', (req, _reply, done) => {
    req.sessionUserId = TEST_USER_ID;
    done();
  });
  await app.register(promptInjectionRoutes);
  await app.ready();
  return app;
}

async function withDefaultOwnerUserId(value, fn) {
  const prev = process.env.DEFAULT_OWNER_USER_ID;
  if (value === null) delete process.env.DEFAULT_OWNER_USER_ID;
  else process.env.DEFAULT_OWNER_USER_ID = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = prev;
  }
}

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

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const HOOKS_DIR = join(ROOT, 'assets', 'prompt-hooks');

function extractPlaceholders(content) {
  const names = new Set();
  for (const m of content.matchAll(/\{\{(\w+)\}\}/g)) {
    names.add(m[1]);
  }
  return [...names];
}

describe('prompt-injection variable metadata', () => {
  describe('GET /api/prompt-injection/segment/:id/content', () => {
    it('returns templateRef and variableDefs for a template-backed segment', async () => {
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/prompt-injection/segment/S4/content',
          headers: AUTH_HEADERS,
        });
        assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
        const body = JSON.parse(res.body);
        assert.equal(body.segmentId, 'S4');
        assert.equal(body.templateRef, 's4-collaboration.md');
        assert.ok(Array.isArray(body.variableDefs), 'variableDefs should be an array');
        const varDef = body.variableDefs.find((v) => v.name === 'CALLABLE_MENTIONS');
        assert.ok(varDef, 'CALLABLE_MENTIONS variable def should exist');
        assert.ok(varDef.description && varDef.description.length > 0, 'description should be present');
        assert.ok(body.content.includes('{{CALLABLE_MENTIONS}}'), 'content should retain placeholder');
      } finally {
        await app.close();
      }
    });

    it('returns templateRef and variableDefs for a hook-registered segment', async () => {
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/prompt-injection/segment/S1/content',
          headers: AUTH_HEADERS,
        });
        assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
        const body = JSON.parse(res.body);
        assert.equal(body.segmentId, 'S1');
        assert.equal(body.templateRef, 's1-identity.md');
        assert.ok(Array.isArray(body.variableDefs));
      } finally {
        await app.close();
      }
    });

    it('returns variableDefs from TEMPLATE_FILES registry for non-hook template-backed segments', async () => {
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/prompt-injection/segment/M1/content',
          headers: AUTH_HEADERS,
        });
        assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
        const body = JSON.parse(res.body);
        assert.equal(body.segmentId, 'M1');
        assert.ok(Array.isArray(body.variableDefs));
        const missionDef = body.variableDefs.find((v) => v.name === 'MISSION');
        assert.ok(missionDef, 'MISSION variable def should come from TEMPLATE_FILES registry');
        assert.ok(missionDef.description && missionDef.description.length > 0, 'description should be present');
      } finally {
        await app.close();
      }
    });

    it('returns empty variableDefs for segments without variable metadata', async () => {
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/prompt-injection/segment/D8/content',
          headers: AUTH_HEADERS,
        });
        assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
        const body = JSON.parse(res.body);
        assert.equal(body.segmentId, 'D8');
        assert.deepEqual(body.variableDefs, []);
      } finally {
        await app.close();
      }
    });

    it('preserves source placeholders in content (not expanded)', async () => {
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/prompt-injection/segment/S13/content',
          headers: AUTH_HEADERS,
        });
        assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
        const body = JSON.parse(res.body);
        assert.equal(body.segmentId, 'S13');
        assert.ok(body.content.includes('{{RICH_BLOCK_SHORT}}'), 'content should contain RICH_BLOCK_SHORT placeholder');
      } finally {
        await app.close();
      }
    });
  });

  describe('PUT /api/prompt-injection/segment/:id/override', () => {
    it('saves source with placeholders and rejects expanded runtime value in payload', async () => {
      await withDefaultOwnerUserId(TEST_USER_ID, async () => {
        await withPreservedOverlay('S13', async () => {
          const app = await buildSessionApp();
          try {
            // Raw source must retain HTML comment bytes; stripping is a UI preview concern only.
            const sourceWithPlaceholder =
              '<!-- @segment S13 --><!-- Variable: {{RICH_BLOCK_SHORT}} -->\nRich block short: {{RICH_BLOCK_SHORT}}';
            const expandedValue = 'Rich block short: <xml/>';

            const saveRes = await app.inject({
              method: 'PUT',
              url: '/api/prompt-injection/segment/S13/override',
              headers: LOCAL_WRITE_HEADERS,
              payload: { content: sourceWithPlaceholder },
            });
            assert.equal(saveRes.statusCode, 200, `expected 200, got ${saveRes.statusCode}: ${saveRes.body}`);

            // Now verify GET still returns the source with placeholder and comment bytes
            const getRes = await app.inject({
              method: 'GET',
              url: '/api/prompt-injection/segment/S13/content',
              headers: AUTH_HEADERS,
            });
            const body = JSON.parse(getRes.body);
            assert.ok(body.content.includes('{{RICH_BLOCK_SHORT}}'), 'saved content should retain placeholder');
            assert.ok(body.content.includes('<!-- @segment S13 -->'), 'saved content should retain HTML comment bytes');

            // Expanded value should not be persisted as override
            const badSaveRes = await app.inject({
              method: 'PUT',
              url: '/api/prompt-injection/segment/S13/override',
              headers: LOCAL_WRITE_HEADERS,
              payload: { content: expandedValue },
            });
            assert.equal(
              badSaveRes.statusCode,
              400,
              `expected 400 for expanded value, got ${badSaveRes.statusCode}: ${badSaveRes.body}`,
            );
          } finally {
            await app.close();
          }
        });
      });
    });

    it('rejects a legacy expanded overlay without placeholders and allows recovery with canonical source', async () => {
      await withDefaultOwnerUserId(TEST_USER_ID, async () => {
        await withPreservedOverlay('S13', async () => {
          const app = await buildSessionApp();
          try {
            const localPath = getTemplateOverlayPath('S13');
            assert.ok(localPath);
            // Simulate a legacy overlay that already contains an expanded runtime value.
            const expandedOverlay = 'Rich block short: <xml/>';
            writeFileSync(localPath, expandedOverlay, 'utf-8');

            // Re-saving the expanded value must be rejected against the canonical base template.
            const badRes = await app.inject({
              method: 'PUT',
              url: '/api/prompt-injection/segment/S13/override',
              headers: LOCAL_WRITE_HEADERS,
              payload: { content: expandedOverlay },
            });
            assert.equal(badRes.statusCode, 400, `expected 400, got ${badRes.statusCode}: ${badRes.body}`);

            // Recovery: saving canonical source with the required placeholder succeeds.
            const canonicalSource = '<!-- S13 source -->\nRich block short: {{RICH_BLOCK_SHORT}}';
            const goodRes = await app.inject({
              method: 'PUT',
              url: '/api/prompt-injection/segment/S13/override',
              headers: LOCAL_WRITE_HEADERS,
              payload: { content: canonicalSource },
            });
            assert.equal(goodRes.statusCode, 200, `expected 200, got ${goodRes.statusCode}: ${goodRes.body}`);

            const getRes = await app.inject({
              method: 'GET',
              url: '/api/prompt-injection/segment/S13/content',
              headers: AUTH_HEADERS,
            });
            const body = JSON.parse(getRes.body);
            assert.ok(body.content.includes('{{RICH_BLOCK_SHORT}}'), 'recovered content should retain placeholder');
          } finally {
            await app.close();
          }
        });
      });
    });
  });

  describe('hook-manifest-parser variables', () => {
    it('accepts valid variables array', () => {
      const tmpDir = `/tmp/f257-parser-test-${process.hrtime.bigint()}`;
      mkdirSync(tmpDir, { recursive: true });
      const yamlPath = join(tmpDir, 'hook.yaml');
      writeFileSync(
        yamlPath,
        `id: T1
name: Test
stage: session-init
order: 100
version: 1
enabled: true
disableable: false
safetyTier: readonly
transparencyTier: visible-by-default
governanceTier: immutable
template: test.md
inputs: []
variables:
  - name: FOO
    description: foo desc
    placeholder: foo-value
`,
      );
      try {
        const result = parseHookManifest(yamlPath);
        assert.ok(result.ok, `parser should accept valid variables: ${result.errors.join('; ')}`);
        assert.equal(result.manifest.variables.length, 1);
        assert.equal(result.manifest.variables[0].name, 'FOO');
        assert.equal(result.manifest.variables[0].description, 'foo desc');
        assert.equal(result.manifest.variables[0].placeholder, 'foo-value');
      } finally {
        unlinkSync(yamlPath);
      }
    });

    it('rejects variable missing name', () => {
      const tmpDir = `/tmp/f257-parser-test-${process.hrtime.bigint()}`;
      mkdirSync(tmpDir, { recursive: true });
      const yamlPath = join(tmpDir, 'hook.yaml');
      writeFileSync(
        yamlPath,
        `id: T1
name: Test
stage: session-init
order: 100
version: 1
enabled: true
disableable: false
safetyTier: readonly
transparencyTier: visible-by-default
governanceTier: immutable
template: test.md
inputs: []
variables:
  - description: no name
`,
      );
      try {
        const result = parseHookManifest(yamlPath);
        assert.equal(result.ok, false);
        assert.ok(result.errors.some((e) => /variables.*name/i.test(e)));
      } finally {
        unlinkSync(yamlPath);
      }
    });

    it('rejects variable with non-string description', () => {
      const tmpDir = `/tmp/f257-parser-test-${process.hrtime.bigint()}`;
      mkdirSync(tmpDir, { recursive: true });
      const yamlPath = join(tmpDir, 'hook.yaml');
      writeFileSync(
        yamlPath,
        `id: T1
name: Test
stage: session-init
order: 100
version: 1
enabled: true
disableable: false
safetyTier: readonly
transparencyTier: visible-by-default
governanceTier: immutable
template: test.md
inputs: []
variables:
  - name: FOO
    description: 42
`,
      );
      try {
        const result = parseHookManifest(yamlPath);
        assert.equal(result.ok, false);
        assert.ok(result.errors.some((e) => /variables.*description/i.test(e)));
      } finally {
        unlinkSync(yamlPath);
      }
    });
  });

  describe('hook variable metadata parity', () => {
    it('every {{VAR}} placeholder in a hook template has a canonical variable definition', async () => {
      const entries = await readdir(HOOKS_DIR);
      const missing = [];
      const emptyDesc = [];
      for (const entry of entries) {
        const yamlPath = join(HOOKS_DIR, entry, 'hook.yaml');
        if (!existsSync(yamlPath)) continue;
        const result = parseHookManifest(yamlPath);
        if (!result.ok) continue;
        const { manifest } = result;
        if (!manifest.template) continue;
        let templatePath = join(HOOKS_DIR, entry, manifest.template);
        if (!existsSync(templatePath)) templatePath = join(TEMPLATES_DIR, manifest.template);
        if (!existsSync(templatePath)) continue;
        const template = readFileSync(templatePath, 'utf-8');
        const placeholders = extractPlaceholders(template);
        if (placeholders.length === 0) continue;
        const defs = new Map((manifest.variables || []).map((v) => [v.name, v]));
        for (const name of placeholders) {
          const def = defs.get(name);
          if (!def) missing.push({ hook: manifest.id, var: name });
          else if (!def.description || def.description.trim().length === 0)
            emptyDesc.push({ hook: manifest.id, var: name });
        }
      }
      assert.deepEqual(missing, [], 'all placeholders must have variable definitions');
      assert.deepEqual(emptyDesc, [], 'all variable definitions must have non-empty descriptions');
    });
  });
});
