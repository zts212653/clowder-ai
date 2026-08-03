// @ts-check
/**
 * F221 Phase B Task 8: Signal routing guard tests.
 *
 * When propose_profile_update receives content with taste signal keywords,
 * the response should include a routing_advisory suggesting propose_taste.
 * The advisory is informational — it does NOT block proposal creation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectTasteSignal } from '../src/domains/taste/services/taste-routing-guard.ts';

describe('taste-routing-guard', () => {
  it('detects taste signal keyword in rationale', () => {
    const result = detectTasteSignal({ rationale: 'co-creator说太客服了，需要记下来' });
    assert.ok(result);
    assert.equal(result.suggestedTool, 'cat_cafe_propose_taste');
    assert.ok(result.reason.length > 0);
  });

  it('detects taste signal keyword in afterContent', () => {
    const result = detectTasteSignal({ afterContent: '要保持活人感，不要 AI slop' });
    assert.ok(result);
  });

  it('detects Chinese taste keywords: 品味, 审美, 不美', () => {
    assert.ok(detectTasteSignal({ rationale: '这个设计的品味不对' }));
    assert.ok(detectTasteSignal({ rationale: '审美上有问题' }));
    assert.ok(detectTasteSignal({ afterContent: '这个 UI 不美' }));
  });

  it('detects magic word keywords: 脚手架, 第一性原理, 数学之美', () => {
    assert.ok(detectTasteSignal({ rationale: '不要脚手架方案' }));
    assert.ok(detectTasteSignal({ rationale: '回到第一性原理' }));
    assert.ok(detectTasteSignal({ afterContent: '数学之美才是对的' }));
  });

  it('detects positive taste signals: aha, 这就是我要的', () => {
    assert.ok(detectTasteSignal({ rationale: '这就是我要的感觉' }));
    assert.ok(detectTasteSignal({ rationale: 'aha moment' }));
  });

  it('returns null for normal primer content', () => {
    const result = detectTasteSignal({
      rationale: 'operator prefers concise commit messages',
      afterContent: '## Communication\n- Keep commit messages under 72 chars',
    });
    assert.equal(result, null);
  });

  it('returns null for empty input', () => {
    assert.equal(detectTasteSignal({}), null);
    assert.equal(detectTasteSignal({ rationale: '' }), null);
  });

  it('is case-insensitive for English keywords', () => {
    assert.ok(detectTasteSignal({ rationale: 'This is AI Slop' }));
    assert.ok(detectTasteSignal({ rationale: 'AHA this is it' }));
  });
});
