import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  _resetCachedConfig,
  getCoCreatorConfig,
  loadCatConfig,
  loadResolvedCatConfig,
} from '../src/config/cat-config-loader.js';
import { getSenderName } from '../src/domains/cats/services/context/ContextAssembler.js';
import { parseIntent } from '../src/domains/cats/services/context/IntentParser.js';
import { formatPromptTime } from '../src/domains/cats/services/format-time.js';
import {
  synthesizeEvalHubNextCheck,
  synthesizeEvalHubOperatorNarrative,
} from '../src/infrastructure/harness-eval/hub/eval-hub-operator-narrative.js';

afterEach(() => _resetCachedConfig());

test('reported development instructions use configured names and aliases literally', () => {
  const config = loadCatConfig(new URL('../../../cat-template.json', import.meta.url).pathname);
  getCoCreatorConfig({
    ...config,
    version: 2,
    coCreator: {
      name: 'Mina',
      aliases: ['M.(a+b)'],
      mentionPatterns: ['@mina'],
    },
  });
  for (const name of ['Mina', 'M.(a+b)']) {
    assert.deepEqual(parseIntent(`${name}说过，开始开发 F330`, 1).promptTags, []);
  }
  assert.deepEqual(parseIntent('开始开发 F330', 1).promptTags, ['skill:custody-recognition']);
});

test('Eval Hub sunset copy follows the configured person, including changes in the same process', () => {
  const config = loadCatConfig(new URL('../../../cat-template.json', import.meta.url).pathname);
  for (const name of ['Mina', '小明']) {
    getCoCreatorConfig({ ...config, version: 2, coCreator: { name, aliases: [], mentionPatterns: ['@mina'] } });
    const result = synthesizeEvalHubOperatorNarrative({
      verdict: 'delete_sunset',
      domainDescription: '能力检查',
      featureId: 'F001',
      snapshot: { window: { durationHours: 24 }, components: [] },
      attribution: { findings: [] },
      stale: false,
    });
    assert.equal(result.action, `需要 ${name} 决定是否停用这项评估。`);
    assert.equal(result.nextCheck, `${name} 拍板后，再决定停用或继续保留。`);
    assert.equal(synthesizeEvalHubNextCheck('delete_sunset', false, 'usable'), result.nextCheck);
  }
});

test('configured familiar address reaches history labels and timestamps without changing message identity', () => {
  const config = loadCatConfig(new URL('../../../cat-template.json', import.meta.url).pathname);
  getCoCreatorConfig({
    ...config,
    version: 2,
    coCreator: {
      name: 'Mina',
      nickname: '小明',
      aliases: [],
      mentionPatterns: ['@mina'],
    },
  });
  assert.equal(getSenderName(null), '小明');
  assert.match(formatPromptTime(Date.UTC(2026, 9, 20), { timeZone: 'UTC' }), /^小明本地 /);
});

test('an existing owner without nickname does not acquire the install template nickname', () => {
  const root = mkdtempSync(join(tmpdir(), 'co-creator-address-'));
  try {
    const template = join(root, 'cat-template.json');
    copyFileSync(new URL('../../../cat-template.json', import.meta.url), template);
    mkdirSync(join(root, '.cat-cafe'));
    for (const nickname of [undefined, '小明']) {
      writeFileSync(
        join(root, '.cat-cafe/cat-catalog.json'),
        JSON.stringify({
          version: 2,
          breeds: [],
          roster: {},
          coCreator: {
            name: 'Mina',
            aliases: [],
            mentionPatterns: ['@mina'],
            ...(nickname ? { nickname } : {}),
          },
        }),
      );
      const resolved = loadResolvedCatConfig(template);
      assert.equal(resolved.version === 2 ? resolved.coCreator?.nickname : null, nickname);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
