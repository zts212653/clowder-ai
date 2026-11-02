import assert from 'node:assert/strict';
import path from 'node:path';

/** Measure the approved result itself, including the long English profile line requested by the designer. */
export async function captureOriginalResultDesign({ card, record, language, width, verb, evidence }) {
  const result = await card.getByTestId('decision-result-label').evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return {
      text: element.textContent,
      lines: [
        ...new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top))),
      ],
      rects: [...range.getClientRects()].map((rect) => rect.toJSON()),
    };
  });
  if (verb === 'approve') {
    assert.equal(
      result.text,
      record.kind === 'F225'
        ? language === 'en'
          ? 'Approved · handoff started'
          : '已同意 · 接力已发起'
        : language === 'en'
          ? 'Approved · written to your profile'
          : '已同意 · 已写入档案',
    );
    if (language === 'en' && width === 390 && record.kind === 'F231')
      assert.ok(result.lines.length >= 2, 'The long approved profile result actually wraps in the narrow Chat column');
  }
  await card.screenshot({
    path: path.join(evidence, `chat-${record.kind}-${verb}-result.png`),
    animations: 'disabled',
  });
  return result;
}
