import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const baseline = 'https://example.com/abCD 说明';
const expected = [
  ['tail-confirm', 'https://example.com/abCD中文 说明', 26],
  ['middle-confirm', 'https://example.com/ab中文CD 说明', 24],
  ['tail-cancel', baseline, 24],
  ['middle-cancel', baseline, 22],
  ['replace', '中文 说明', 2],
];
for (const file of process.argv.slice(2)) {
  const report = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(report.source, 'cb70a3ecf1e31cbaedab40bcb4611ea32e8b1ee6');
  assert.equal(report.error, undefined);
  assert.equal(report.results.length, 12);
  for (const classic of [false, true]) {
    for (const [name, value, caret] of expected) {
      const result = report.results.find((item) => item.classic === classic && item.name === name);
      assert.equal(result.pass, true);
      assert.equal(result.after.value, value);
      assert.equal(result.after.start, caret);
      assert.equal(result.after.end, caret);
      assert.ok(result.during.events.some((event) => event.type === 'compositionstart' && event.isTrusted));
      assert.ok(result.during.events.some((event) => event.type === 'compositionupdate' && event.data === 'zhongwen'));
      if (classic) {
        assert.equal(result.after.mirrorActive, null);
        assert.equal(result.after.ranges.length, 0);
      } else {
        assert.equal(result.during.mirrorActive, 'false');
        assert.notEqual(result.during.textColor, 'rgba(0, 0, 0, 0)');
        const linked = name !== 'replace';
        assert.equal(result.after.mirrorActive, String(linked));
        assert.deepEqual(
          result.after.ranges.map((range) => range.text),
          linked ? [value.split(' ')[0]] : [],
        );
      }
    }
    const { undo, redo, pass } = report.results.find((item) => item.classic === classic && item.name === 'undo-redo');
    assert.equal(pass, true);
    assert.deepEqual([undo.value, undo.start, undo.end], [baseline, 0, 8]);
    assert.deepEqual([redo.value, redo.start, redo.end], ['中文 说明', 2, 2]);
    if (!classic) {
      assert.equal(undo.mirrorActive, 'true');
      assert.equal(undo.ranges[0].text, baseline.split(' ')[0]);
      assert.equal(redo.mirrorActive, 'false');
      assert.equal(redo.ranges.length, 0);
    }
  }
  console.log(JSON.stringify({ file, cases: 12, valueCaretCompositionAndMirror: 'pass' }));
}
