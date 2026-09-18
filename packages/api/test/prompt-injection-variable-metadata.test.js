import assert from 'node:assert/strict';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { TEMPLATE_FILES } from '../dist/domains/cats/services/context/prompt-template-loader.js';
import { parseHookManifest } from '../dist/domains/prompt-hooks/hook-manifest-parser.js';
import { promptInjectionRoutes } from '../dist/routes/prompt-injection.js';

const TEST_USER_ID = 'test-user';
const AUTH_HEADERS = { 'x-cat-cafe-user': TEST_USER_ID };

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(promptInjectionRoutes);
  await app.ready();
  return app;
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

  function collectDuplicates(defNames, id, duplicate) {
    const seen = new Set();
    for (const name of defNames) {
      if (seen.has(name)) duplicate.push({ id, name });
      seen.add(name);
    }
  }

  function collectEmptyDescriptions(variableDefs, id, emptyDesc) {
    for (const v of variableDefs ?? []) {
      if (!v.description || v.description.trim().length === 0) {
        emptyDesc.push({ id, name: v.name });
      }
    }
  }

  function collectMissingAndExtra(placeholderSet, defSet, id, missing, extra) {
    for (const name of placeholderSet) {
      if (!defSet.has(name)) missing.push({ id, name });
    }
    for (const name of defSet) {
      if (!placeholderSet.has(name)) extra.push({ id, name });
    }
  }

  async function fetchSegmentContent(app, id) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/prompt-injection/segment/${id}/content`,
      headers: AUTH_HEADERS,
    });
    assert.equal(res.statusCode, 200, `expected 200 for ${id}, got ${res.statusCode}: ${res.body}`);
    return JSON.parse(res.body);
  }

  function classifySegment(body) {
    const placeholderSet = new Set(body.vars ?? []);
    const defNames = (body.variableDefs ?? []).map((v) => v.name);
    const defSet = new Set(defNames);
    return { placeholderSet, defNames, defSet, hasPlaceholders: placeholderSet.size > 0 };
  }

  async function runParityCensus(app) {
    const missing = [];
    const extra = [];
    const duplicate = [];
    const emptyDesc = [];
    let placeholderCount = 0;

    for (const id of Object.keys(TEMPLATE_FILES)) {
      const body = await fetchSegmentContent(app, id);
      const { placeholderSet, defNames, defSet, hasPlaceholders } = classifySegment(body);
      if (hasPlaceholders) placeholderCount++;
      collectDuplicates(defNames, id, duplicate);
      collectEmptyDescriptions(body.variableDefs, id, emptyDesc);
      collectMissingAndExtra(placeholderSet, defSet, id, missing, extra);
    }

    return { missing, extra, duplicate, emptyDesc, placeholderCount };
  }

  describe('TEMPLATE_FILES variable metadata parity', () => {
    it('placeholder names and definition names are exactly equal for every segment (fail-closed)', async () => {
      const app = await buildApp();
      try {
        const { missing, extra, duplicate, emptyDesc, placeholderCount } = await runParityCensus(app);
        const total = Object.keys(TEMPLATE_FILES).length;
        assert.equal(total, 53, `production resolver census: total=${total}`);
        assert.equal(
          placeholderCount,
          36,
          `production resolver census: placeholder-bearing=${placeholderCount}, non-placeholder=${total - placeholderCount}`,
        );
        assert.deepEqual(missing, [], 'every placeholder must have a definition');
        assert.deepEqual(extra, [], 'every definition must correspond to a placeholder (no extras)');
        assert.deepEqual(duplicate, [], 'variable definitions must not contain duplicate names');
        assert.deepEqual(emptyDesc, [], 'all variable definitions must have non-empty descriptions');
      } finally {
        await app.close();
      }
    });

    it('rejects an extra variable definition injected into TEMPLATE_FILES (GHOST_VAR regression)', async () => {
      const original = (TEMPLATE_FILES.M1.variables ?? []).slice();
      TEMPLATE_FILES.M1.variables = [
        ...(TEMPLATE_FILES.M1.variables ?? []),
        { name: 'GHOST_VAR', description: 'should not exist', placeholder: 'ghost' },
      ];
      try {
        const app = await buildApp();
        try {
          const body = await fetchSegmentContent(app, 'M1');
          const placeholderSet = new Set(body.vars ?? []);
          const extra = (body.variableDefs ?? []).map((v) => v.name).filter((name) => !placeholderSet.has(name));
          assert.deepEqual(extra, ['GHOST_VAR'], 'extra definition should be detected by exact parity');
        } finally {
          await app.close();
        }
      } finally {
        TEMPLATE_FILES.M1.variables = original;
      }
    });
  });
});
