// F257: a governance `add` lands a hook directory at runtime. The Console
// journey for that segment — list → content → preview → version validation —
// must work through the prompt pipeline's shared registry after
// `resetPipelineSingleton()`, with no private scan cache on any route and no
// static TEMPLATE_FILES dependency for hook-only segments (sol review of #177).
//
// The pipeline scans an isolated hooks directory (CAT_CAFE_PROMPT_HOOKS_DIR):
// this test never writes to, or deletes from, the repository's assets.

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const REAL_HOOKS = join(repoRoot, 'assets', 'prompt-hooks');
const WARM_HOOK_DIR = 's13-mcp-工具文档';
const FIXTURE_ID = 'Z99';
const FIXTURE_DIR_NAME = 'z99-dynamic-probe';
const SESSION_HEADERS = { 'x-test-session-user': 'test-user' };

let hooksDir;

function writeFixtureHook(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'hook.yaml'),
    [
      `id: ${FIXTURE_ID}`,
      'name: Dynamic probe segment',
      'stage: per-turn',
      'order: 9990',
      'version: 1',
      'enabled: true',
      'template: z99-dynamic-probe.md',
      'inputs: []',
      'variables:',
      '  - name: PROBE',
      '    description: probe value',
      'disableable: true',
      'safetyTier: editable',
      'transparencyTier: visible-by-default',
      'governanceTier: auto-evolve',
      'userExplanation: regression fixture for a governance-added segment',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(dir, 'z99-dynamic-probe.md'), 'Probe segment body with {{PROBE}}.\n', 'utf8');
}

async function buildApp() {
  const { promptInjectionManifestRoutes } = await import('../dist/routes/prompt-injection-manifest.js');
  const { promptInjectionRoutes } = await import('../dist/routes/prompt-injection.js');
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    const sessionUser = request.headers['x-test-session-user'];
    if (typeof sessionUser === 'string' && sessionUser.trim()) request.sessionUserId = sessionUser.trim();
  });
  await app.register(promptInjectionManifestRoutes);
  await app.register(promptInjectionRoutes);
  await app.ready();
  return app;
}

async function get(app, url) {
  return app.inject({ method: 'GET', url, headers: SESSION_HEADERS });
}

describe('governance-added segment: Console journey without restart', () => {
  before(async () => {
    hooksDir = join(mkdtempSync(join(tmpdir(), 'f257-dynamic-')), 'prompt-hooks');
    cpSync(join(REAL_HOOKS, WARM_HOOK_DIR), join(hooksDir, WARM_HOOK_DIR), { recursive: true });
    process.env.CAT_CAFE_PROMPT_HOOKS_DIR = hooksDir;
    const { resetPipelineSingleton } = await import('../dist/domains/prompt-hooks/PipelinePromptBuilder.js');
    resetPipelineSingleton();
  });
  after(async () => {
    delete process.env.CAT_CAFE_PROMPT_HOOKS_DIR;
    const { resetPipelineSingleton } = await import('../dist/domains/prompt-hooks/PipelinePromptBuilder.js');
    resetPipelineSingleton();
    rmSync(dirname(hooksDir), { recursive: true, force: true });
  });

  test('list, content, preview and canonical validation all follow the reloaded shared registry', async () => {
    const { resetPipelineSingleton } = await import('../dist/domains/prompt-hooks/PipelinePromptBuilder.js');
    const { validateCanonicalVersionContent } = await import('../dist/routes/prompt-injection-version-content.js');
    const app = await buildApp();
    try {
      // Production order: the operator opened some segment before the approval,
      // so every content reader is already warm.
      const warm = await get(app, '/api/prompt-injection/segment/S13/content');
      assert.equal(warm.statusCode, 200, warm.body);
      const before = await get(app, '/api/prompt-injection/manifest');
      const beforeIds = JSON.parse(before.body).segments.map((s) => s.id);
      assert.ok(beforeIds.includes('S13'), 'the isolated hooks directory is what the pipeline scans');
      assert.ok(!beforeIds.includes(FIXTURE_ID), 'precondition: not listed yet');

      // Governance `add`: files land, then the executor reloads the pipeline.
      writeFixtureHook(join(hooksDir, FIXTURE_DIR_NAME));
      resetPipelineSingleton();

      const listed = await get(app, '/api/prompt-injection/manifest');
      assert.ok(
        JSON.parse(listed.body).segments.some((s) => s.id === FIXTURE_ID),
        'the new segment is listed',
      );

      const content = await get(app, `/api/prompt-injection/segment/${FIXTURE_ID}/content`);
      assert.equal(content.statusCode, 200, `content must open, got ${content.statusCode}: ${content.body}`);
      const body = JSON.parse(content.body);
      assert.equal(body.templateRef, 'z99-dynamic-probe.md');
      assert.deepEqual(body.vars, ['PROBE']);
      assert.equal(body.variableDefs[0]?.name, 'PROBE');
      assert.ok(body.content.includes('{{PROBE}}'), 'source placeholders are preserved');
      const actions = body.enablementMatrix?.runtimeOverride?.actions;
      assert.ok(actions, 'the content contract carries the enablement matrix');
      assert.equal(actions.createVersion.allowed, true, 'an editable governance-added segment can produce versions');
      assert.equal(actions.disable.allowed, true, 'disableable is derived from the hook manifest');

      const preview = await app.inject({
        method: 'POST',
        url: `/api/prompt-injection/segment/${FIXTURE_ID}/preview`,
        headers: SESSION_HEADERS,
        payload: { content: 'edited {{PROBE}}' },
      });
      assert.equal(preview.statusCode, 200, `preview must render, got ${preview.statusCode}: ${preview.body}`);

      assert.equal(validateCanonicalVersionContent(FIXTURE_ID, 'edited body {{PROBE}}'), null);
      assert.match(validateCanonicalVersionContent(FIXTURE_ID, 'dropped the placeholder') ?? '', /\{\{PROBE\}\}/);

      assert.ok(!existsSync(join(REAL_HOOKS, FIXTURE_DIR_NAME)), 'the repository assets were never touched');
    } finally {
      await app.close();
    }
  });
});
