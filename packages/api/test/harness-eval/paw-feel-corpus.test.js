import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractPawFeelMarkers } from '../../dist/infrastructure/harness-eval/friction/paw-feel-marker.js';
import { PAW_FEEL_CORPUS } from './__fixtures__/paw-feel-corpus.js';

// F245 Phase A Task4 — AC-A2 precision/recall gate（验收 Task2 已实现的 extractPawFeelMarkers）。
// 行为已由 Task2 红→绿驱动；本 gate 是系统化语料验收 + Phase B 回归守门。

describe('PawFeel corpus — AC-A2 precision/recall gate', () => {
  it('recall: 每条语料的已知 marker 全部正确提取（tool + symptom）', () => {
    for (const { text, markers } of PAW_FEEL_CORPUS) {
      const got = extractPawFeelMarkers(text);
      assert.equal(got.length, markers.length, `marker 数量不符 @ "${text}"`);
      markers.forEach((exp, i) => {
        assert.equal(got[i].tool, exp.tool, `tool 不符 @ "${text}"`);
        assert.equal(got[i].symptom, exp.symptom, `symptom 不符 @ "${text}"`);
      });
    }
  });

  it('precision: 干扰项零误抓', () => {
    const distractors = PAW_FEEL_CORPUS.filter((c) => c.markers.length === 0);
    assert.ok(distractors.length >= 5, '语料应含足够干扰项');
    for (const { text } of distractors) {
      assert.deepEqual(extractPawFeelMarkers(text), [], `误抓干扰项 @ "${text}"`);
    }
  });

  it('聚合度量: 总提取数 == 已知真 marker 总数（recall=precision=100%）', () => {
    const expected = PAW_FEEL_CORPUS.reduce((sum, c) => sum + c.markers.length, 0);
    const got = PAW_FEEL_CORPUS.reduce((sum, c) => sum + extractPawFeelMarkers(c.text).length, 0);
    assert.ok(expected >= 8, '真 marker 样本应足够多');
    assert.equal(got, expected);
  });
});
