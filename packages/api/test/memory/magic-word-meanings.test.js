import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseMagicWordMeanings } from '../../dist/domains/memory/magic-word-meanings.js';

/**
 * F227 PR-2 Task 8 (AC-A5) — meanings parsed from injected governance, not redefined.
 */
describe('F227 PR-2: parseMagicWordMeanings', () => {
  it('parses -「word」= meaning → action lines from injected governance', () => {
    const content = [
      '## 3. 家规',
      '-「脚手架」= 你在偷懒写临时方案 → 停，审视产物是否终态，不是→重写',
      '-「补锅匠」= 你在逐点修补不审视同类 → 停，做 failure-mode audit',
      'some unrelated line',
    ].join('\n');
    const r = parseMagicWordMeanings(content);
    assert.equal(r.length, 2);
    assert.deepEqual(r[0], {
      word: '脚手架',
      meaning: '你在偷懒写临时方案',
      action: '停，审视产物是否终态，不是→重写',
    });
    assert.equal(r[1].word, '补锅匠');
  });

  it('keeps an inner → in the action (splits on the first arrow only)', () => {
    const r = parseMagicWordMeanings('-「下次一定」= 你在把未做包装成已规划 → 停，能做的现在做，不是→拖延');
    assert.equal(r.length, 1);
    assert.equal(r[0].meaning, '你在把未做包装成已规划');
    assert.equal(r[0].action, '停，能做的现在做，不是→拖延');
  });

  it('returns [] when no meaning lines are present', () => {
    assert.deepEqual(parseMagicWordMeanings('no magic words here\njust text'), []);
  });

  it('gives each alias the same meaning and action from one injected definition', () => {
    const parsed = parseMagicWordMeanings(
      '-「四象限／unknown-first」= 在已知内过早收敛 → 验证关键未知\n' +
        '-「钛合金裤衩子／钛合金内裤」= 防御或 blocker 妨碍交付 → 沿可用路径推进',
    );
    assert.deepEqual(
      parsed.map(({ word }) => word),
      ['四象限', 'unknown-first', '钛合金裤衩子', '钛合金内裤'],
    );
    assert.equal(parsed[0].meaning, parsed[1].meaning);
    assert.equal(parsed[2].action, parsed[3].action);
  });
});
