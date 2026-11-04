/**
 * F237 AC-P2-14a / F330: compare final native L0 sections with actual pipeline
 * patches, including edition rendering. Raw template replicas cannot prove it.
 * Each configuration runs in a fresh process; no services or source edits.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const profiles = JSON.parse(readFileSync(resolve(root, 'packages/shared/src/deployment-profiles.json'), 'utf8'));
const child = String.raw`
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const edition = process.env.F330_EQUIVALENCE_EDITION;
const policy = {
  coCreatorRole: 'Fixture owner ' + edition + ' {{PRODUCT_DISPLAY_NAME}}',
  decisionRole: 'Fixture decision ' + edition,
  runtimeSafetyRule: '1. **Fixture safety ' + edition + '** — isolated storage',
  acceptanceRule: '4. **Fixture acceptance ' + edition + '** — isolated acceptance',
  modifyDataBoundary: 'modify Fixture data ' + edition,
  capabilityQualifier: 'Fixture contextual ',
};
const brand = 'Fixture product ' + edition + ' {{CO_CREATOR_ROLE}}';
if (edition !== 'current') {
  const urls = new Set(['src', 'dist'].map(dir =>
    pathToFileURL(join(root, 'packages/shared', dir, 'deployment-profiles.json')).href));
  registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!urls.has(url)) return loaded;
    const config = JSON.parse(String(loaded.source));
    config.activeProfile = edition;
    config.profiles[edition].brand.displayName = brand;
    config.profiles[edition].promptPolicy = policy;
    return { ...loaded, source: JSON.stringify(config) };
  }});
}

await import('./packages/api/test/helpers/setup-cat-registry.js');
const { compileL0 } = await import('./scripts/compile-system-prompt-l0.mjs');
const { HookPipeline } = await import('./packages/api/dist/domains/prompt-hooks/HookPipeline.js');
const { HookRegistry } = await import('./packages/api/dist/domains/prompt-hooks/HookRegistry.js');
const { RESOLVER_MAP } = await import('./packages/api/dist/domains/prompt-hooks/resolvers/index.js');
const { renderSegment } = await import('./packages/api/dist/domains/cats/services/context/prompt-template-loader.js');
const { assembleForSession } = await import('./packages/api/dist/domains/prompt-hooks/assemble-bridge.js');
const scratch = mkdtempSync(join(tmpdir(), 'l0-equivalence-'));
try {
  const compiled = (await compileL0({ catId: 'codex', profileDir: scratch, dossierRoot: scratch })).replace(/\r\n/g, '\n');
  const registry = new HookRegistry(join(root, 'assets/prompt-hooks'), join(root, 'assets/prompt-templates'));
  registry.scan();
  const pipeline = new HookPipeline(registry, RESOLVER_MAP, renderSegment);
  const result = pipeline.executeStage('session-init', assembleForSession('codex', { mcpAvailable: true }));
  const patches = Object.fromEntries(result.patches
    .filter(patch => /^L[1-7]$/.test(patch.hookId)).map(patch => [patch.hookId, patch.content.replace(/\r\n/g, '\n')]));
  assert.deepEqual(Object.keys(patches).sort(), ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']);

  // Observe complete blocks in the native compiler's final output. Its public
  // numbered sections, roster and operator reference delimit them; no renderer or
  // annotation-stripping implementation is reproduced on this side.
  function section(number) {
    const match = compiled.match(new RegExp('^## ' + number + '\\. [^\\n]*\\n([\\s\\S]*?)(?=^## \\d+\\. |$(?![\\s\\S]))', 'm'));
    assert.ok(match, 'native section ' + number + ' is missing');
    return match[1].split('\n\n---')[0].trim();
  }
  const first = section(1);
  const l1Start = first.indexOf('你不是一个孤立的工具');
  const rosterStart = first.indexOf('\n\n## 队友名册');
  assert.ok(l1Start >= 0 && rosterStart > l1Start, 'native L1/roster boundaries missing');
  const routing = section(4);
  const cvoStart = routing.lastIndexOf('\n\n');
  assert.ok(cvoStart > 0 && routing.slice(cvoStart).includes('（co-creator/operator）'), 'native operator boundary missing');
  const native = {
    L1: first.slice(l1Start, rosterStart),
    L2: section(2),
    L3: routing.slice(0, cvoStart),
    L4: section(5),
    L5: section(7),
    L6: section(8),
    L7: section(9),
  };
  for (const id of Object.keys(native)) {
    assert.equal(patches[id], native[id], id + ': final compiler/pipeline mismatch');
  }
  if (edition !== 'current') {
    const expectations = [
      ['L1', brand], ['L1', policy.coCreatorRole], ['L3', policy.modifyDataBoundary],
      ['L4', policy.runtimeSafetyRule], ['L4', policy.acceptanceRule], ['L6', brand],
    ];
    for (const [id, expected] of expectations) {
      assert.ok(native[id].includes(expected), id + ': compiler ignored selected configuration');
      assert.ok(patches[id].includes(expected), id + ': pipeline ignored selected configuration');
    }
  }
  process.stdout.write('__F330_EQUIVALENCE__' + JSON.stringify({ edition, sections: Object.keys(native) }) + '\n');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
`;

for (const edition of ['current', ...Object.keys(profiles.profiles)]) {
  test(`final native L0 and pipeline agree for ${edition} configuration, preserving opaque values`, () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, F330_EQUIVALENCE_EDITION: edition },
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(result.stdout.includes('__F330_EQUIVALENCE__'), result.stdout);
  });
}
