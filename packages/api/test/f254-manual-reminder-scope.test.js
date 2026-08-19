import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OPTIONAL_MARKER = '<!-- F254_MANUAL_REMINDER_SCOPE: optional-nonblocking -->';

describe('F254 manual reminder scope contract', () => {
  test('keeps the manual endpoint/button optional and distinct from automatic freshness notice', async () => {
    const [clarification, feature] = await Promise.all([
      readFile(resolve(repoRoot, 'docs/discussions/2026-07-12-f254-queue-ack-steer-cvo-clarification.md'), 'utf8'),
      readFile(resolve(repoRoot, 'docs/features/F254-side-effect-freshness-gate.md'), 'utf8'),
    ]);

    for (const [name, document] of [
      ['operator clarification', clarification],
      ['F254 feature', feature],
    ]) {
      assert.ok(document.includes(OPTIONAL_MARKER), `${name} must carry the canonical optional-scope marker`);
      assert.match(document, /人工[“"]提醒猫[”"]按钮.*不属于 F254.*阻塞/i);
      assert.match(document, /自动 freshness notice.*不(?:是|等于).*人工[“"]提醒猫[”"]/i);
    }

    assert.match(clarification, /可选后续验收（不阻塞 F254）/);
    assert.doesNotMatch(clarification, /人工“提醒猫”及其 request\/delivered\/seen\/missed 状态 \| \*\*缺口\*\* \|/);
  });
});
