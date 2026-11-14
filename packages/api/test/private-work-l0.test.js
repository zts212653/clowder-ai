import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry, resolveL0Projections } from '@cat-cafe/shared';
import { parseFrozenL0Input, renderFrozenL0Input } from '@cat-cafe/shared/l0-input';
import { captureFrozenL0Input } from '@cat-cafe/shared/l0-input-capture';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const script = join(root, 'scripts/compile-system-prompt-l0.mjs');
const hasWork = resolveL0Projections().includes('collective-work');
const publicPreload = `data:text/javascript;base64,${Buffer.from(`
  import { registerHooks } from 'node:module';
  registerHooks({ load(url, context, next) {
    const result = next(url, context);
    if (!url.endsWith('/shared/dist/deployment-profiles.json')) return result;
    const input = JSON.parse(String(result.source));
    return { ...result, source: JSON.stringify({ ...input, activeProfile: 'opensource',
      profiles: { opensource: input.profiles.opensource } }) };
  }});
`).toString('base64')}`;

function captureOptions() {
  return {
    catId: 'codex',
    member: catRegistry.getOrThrow('codex').config,
    model: 'fixture-model',
    teammates: [],
    coCreator: { name: 'fixture-owner', mentionPatterns: ['@fixture-owner'] },
    installRoot: root,
    overlayRoot: root,
    governanceText: 'fixture-governance',
  };
}

function child(args, options = {}) {
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, CAT_TEMPLATE_PATH: 'Z:/no-live-catalog', CAT_CAFE_DATA_DIR: 'Z:/no-live-profile' },
    ...options,
  });
}

test(
  'home Work omits the whole capsule without reading any profile source and survives the frozen child',
  {
    skip: !hasWork,
  },
  async (t) => {
    const profileDir = mkdtempSync(join(tmpdir(), 'private-work-l0-'));
    t.after(() => rmSync(profileDir, { recursive: true, force: true }));
    writeFileSync(join(profileDir, 'capsule.md'), 'fixture-owner-capsule-canary');
    const options = captureOptions();
    const owner = captureFrozenL0Input({ ...options, projection: 'owner', profileDir });
    assert.match(renderFrozenL0Input(owner), /fixture-owner-capsule-canary/);
    const work = captureFrozenL0Input({
      ...options,
      projection: 'collective-work',
      member: {
        ...options.member,
        get relationshipKey() {
          throw new Error('Work read a relationship key');
        },
      },
      get profileDir() {
        throw new Error('Work read a profile path');
      },
    });
    assert.equal(work.projection, 'collective-work');
    assert.equal(work.variables.USER_CAPSULE, '');
    const expected = renderFrozenL0Input(owner).replace(owner.variables.USER_CAPSULE, '');
    assert.equal(renderFrozenL0Input(parseFrozenL0Input(work)), expected);
    assert.doesNotMatch(expected, /fixture-owner-capsule-canary|## 主人画像|cat-cafe-profile:\/\//);
    const rendered = child([script, '--frozen-input'], { input: JSON.stringify(work) });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.equal(rendered.stdout, expected);

    const { compileL0ViaSubprocess } = await import('../dist/domains/cats/services/agents/providers/l0-compiler.js');
    const actual = await compileL0ViaSubprocess({ catId: 'codex', frozenInput: work, requireFrozenInput: true });
    assert.equal(actual, expected);
    const publicFrozen = child(['--import', publicPreload, script, '--frozen-input'], { input: JSON.stringify(work) });
    assert.notEqual(publicFrozen.status, 0);
    assert.equal(publicFrozen.stdout, '');
    assert.match(publicFrozen.stderr, /unsupported (?:L0 )?projection.*collective-work/i);
  },
);

test('unrecognized shared capture projections cannot fall through to owner capture', () => {
  assert.throws(
    () => captureFrozenL0Input({ catId: 'codex', installRoot: root, projection: 'unknown' }),
    /unsupported (?:L0 )?projection/i,
  );
});

test('ordinary native admission still rejects diagnostic-only Work before reading owner sources', async () => {
  const { captureInvocationL0Input } = await import(
    '../dist/domains/cats/services/agents/providers/l0-input-capture.js'
  );
  assert.throws(
    () =>
      captureInvocationL0Input({
        catId: 'codex',
        catConfig: catRegistry.getOrThrow('codex').config,
        userId: 'isolated',
        projection: 'collective-work',
        profileRepository: {
          profileDir() {
            throw new Error('native capture read owner sources');
          },
        },
      }),
    /unsupported (?:L0 )?projection/i,
  );
  const { compileL0ViaSubprocess } = await import('../dist/domains/cats/services/agents/providers/l0-compiler.js');
  await assert.rejects(
    compileL0ViaSubprocess({ catId: 'codex', projection: 'collective-work' }),
    /unsupported.*projection/i,
  );
});

test('public deployment policy rejects Work before live diagnostics or shared capture', () => {
  const diagnostic = child(['--import', publicPreload, script, '--cat', 'codex', '--projection', 'collective-work']);
  assert.notEqual(diagnostic.status, 0);
  assert.equal(diagnostic.stdout, '');
  assert.match(diagnostic.stderr, /unsupported (?:L0 )?projection.*collective-work/i);
  const direct = child([
    '--import',
    publicPreload,
    '--input-type=module',
    '-e',
    `
    import { captureFrozenL0Input } from '@cat-cafe/shared/l0-input-capture';
    captureFrozenL0Input({ catId: 'codex', projection: 'collective-work', installRoot: 'missing' });
  `,
  ]);
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /unsupported (?:L0 )?projection.*collective-work/i);
});
