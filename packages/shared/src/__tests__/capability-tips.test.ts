import { describe, expect, it } from 'vitest';
import {
  buildConciergeDraftPrompt,
  type CapabilityTip,
  CapabilityTipUsageEventSchema,
  type CapabilityTipValidationResult,
  selectCapabilityTip,
  validateCapabilityTip,
  validateCapabilityTipInventory,
} from '../capability-tips.js';

const baseTip: CapabilityTip = {
  id: 'capability-browser-preview',
  kind: 'capability',
  sourceRef: {
    path: 'cat-cafe-skills/browser-preview/SKILL.md',
    anchor: 'browser-preview',
  },
  structureSource: {
    path: 'packages/api/src/infrastructure/harness-eval/capability-wakeup/capability-wakeup-rules.ts',
    anchor: 'browser-preview',
  },
  bodySource: {
    path: 'cat-cafe-skills/refs/capability-wakeup-index.md',
    anchor: '`browser-preview`',
  },
  contexts: ['thinking', 'long_running'],
  audience: ['all'],
  body: '改完前端想看效果时，猫可以把本地页面打开到 Hub Browser 预览。',
  action: {
    type: 'open_concierge_draft',
    label: '了解更多',
  },
  owner: 'codex',
};

function expectErrors(result: CapabilityTipValidationResult): string {
  if (result.success) throw new Error('expected validation to fail');
  return result.errors.join('\n');
}

describe('F244 CapabilityTip contract', () => {
  it('accepts a final-shaped capability tip', () => {
    expect(validateCapabilityTip(baseTip).success).toBe(true);
  });

  it('rejects action-required tips without an action', () => {
    const { action: _action, ...withoutAction } = baseTip;
    const result = validateCapabilityTip(withoutAction);
    expect(result.success).toBe(false);
    expect(expectErrors(result)).toContain('requires an action');
  });

  it('rejects fake progress promises in tip body', () => {
    const result = validateCapabilityTip({
      ...baseTip,
      body: '就快好了，马上完成这一步，请继续等一下。',
    });
    expect(result.success).toBe(false);
    expect(expectErrors(result)).toContain('fake progress');
  });

  it('rejects duplicate tip ids in inventory', () => {
    const result = validateCapabilityTipInventory([baseTip, { ...baseTip }]);
    expect(result.success).toBe(false);
    expect(expectErrors(result)).toContain('duplicate tip id');
  });

  it('selects a matching context before generic tips', () => {
    const genericTip: CapabilityTip = {
      ...baseTip,
      id: 'magic-word-scaffold',
      kind: 'magic_word',
      contexts: ['thinking'],
      action: undefined,
      body: '“脚手架”用于发现临时方案时拉回终态设计。',
    };
    const reviewTip: CapabilityTip = {
      ...baseTip,
      id: 'workflow-merge-gate',
      kind: 'workflow',
      contexts: ['merge_gate'],
      body: '准备合入时先走 merge-gate，门禁、PR、云端 review、merge 连成一条链。',
    };

    expect(selectCapabilityTip([genericTip, reviewTip], { contexts: ['merge_gate'] })?.id).toBe('workflow-merge-gate');
  });

  it('does not filter by audience when no audience is provided', () => {
    const developerTip: CapabilityTip = {
      ...baseTip,
      id: 'developer-only-review-tip',
      contexts: ['review'],
      audience: ['developer'],
      body: 'review 阶段可以展示只面向开发者的流程提示。',
    };

    expect(selectCapabilityTip([developerTip], { contexts: ['review'] })?.id).toBe('developer-only-review-tip');
    expect(selectCapabilityTip([developerTip], { contexts: ['review'], audience: 'cvo' })).toBeNull();
  });

  it('builds a concierge draft prompt without auto-send semantics', () => {
    const prompt = buildConciergeDraftPrompt(baseTip);
    expect(prompt).toContain('capability-browser-preview');
    expect(prompt).toContain('cat-cafe-skills/browser-preview/SKILL.md');
    expect(prompt).not.toContain('发送');
  });

  it('usage event shape is privacy-minimal and strict', () => {
    const valid = CapabilityTipUsageEventSchema.safeParse({
      event: 'capability_tip_action',
      tipId: 'capability-browser-preview',
      context: 'thinking',
      surface: 'assistant_stream_bubble',
      actionType: 'open_concierge_draft',
      outcome: 'opened',
      timestamp: 1,
    });
    expect(valid.success).toBe(true);

    const withPrivateText = CapabilityTipUsageEventSchema.safeParse({
      event: 'capability_tip_action',
      tipId: 'capability-browser-preview',
      context: 'thinking',
      surface: 'assistant_stream_bubble',
      actionType: 'open_concierge_draft',
      outcome: 'opened',
      timestamp: 1,
      promptText: 'private user text must not be stored',
    });
    expect(withPrivateText.success).toBe(false);
  });
});
