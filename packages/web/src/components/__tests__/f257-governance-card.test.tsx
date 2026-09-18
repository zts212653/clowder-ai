import type { ApprovalHubItem, HarnessGovernanceProposalChange } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';
import { comparisonBlocks, fullContentDiff } from '../F257GovernanceChanges';
import { GenericApprovalRecommendation } from '../GenericApprovalRecommendation';
import { HarnessGovernanceDecisionActions } from '../HarnessGovernanceDecisionActions';
import { parseUnifiedDiff } from '../workspace/DiffViewer';

const ITEM: ApprovalHubItem = {
  proposalId: 'HGP-1',
  sourceFeatureId: 'F257',
  requesterCatId: 'system',
  ownerUserId: 'owner-1',
  resolution: 'open',
  materialization: { state: 'not_started' },
  summary: 'Harness 治理：演进 D1',
  navigation: anchoredApprovalNavigation('thread_eval_f257_obj'),
  inlineApprovable: true,
  decisionMode: 'approve-skip-reject',
  createdAt: 1,
  detail: {
    header: {
      objective: { id: 'obj', label: '规则正确性', statement: 'Keep the behavior sound.' },
      objectiveId: 'obj',
      currentVersion: 'v1',
      decision: 'evolve',
      windows: [{ start: 0, end: 1 }],
      triggeredBy: ['cumulative', 'counterexamples'],
      triggerCounts: {
        cumulative: { count: 203, threshold: 200 },
        counterexamples: { count: 4, threshold: 3 },
      },
    },
    conclusions: [
      {
        id: 'metric-a',
        conclusion: { kind: 'count', value: 3, howCounted: '逐条核对本周期反例后，共确认 3 次。' },
      },
    ],
    coverageAssessment: {
      status: 'gaps_found',
      rationale: '检测规则漏掉一个自标事件。',
      findings: [
        {
          kind: 'detector_gap',
          basis: 'mcp-marker',
          metricId: 'metric-a',
          rationale: '当前结构化规则没有覆盖 invocation-1。',
          evidenceRefs: ['invocation-1'],
        },
      ],
    },
    metricVisuals: [{ id: 'metric-a', currentValue: 3, previousValue: 5, delta: -2, lowerIsBetter: true }],
    hasComparisonBaseline: true,
    governanceReason: '反例显示内容需要收紧。',
    history: [{ cycleId: 'old-cycle', approval: { state: 'skipped' } }],
    rejectReasons: ['上一版没有解释边界。'],
    changes: [
      {
        unitId: 'D1',
        action: 'modify',
        reason: '去掉歧义',
        beforeContent: 'old content',
        proposedContent: 'new content',
      },
    ],
    evidenceRefs: ['invocation-1'],
    cardOrdinal: 2,
  },
};

describe('F257 governance card', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('combines metric values and changes, humanizes conclusions, and opens action diffs in a dialog', async () => {
    await act(async () => {
      root.render(
        <GenericApprovalRecommendation
          item={ITEM}
          f193TargetThreadId=""
          sourceThreadTitle="Harness Objective"
          targetThreadTitle={null}
          resolveCatName={(catId) => catId}
        />,
      );
    });

    for (const section of ['header', 'metrics', 'conclusions', 'changes', 'lineage']) {
      expect(container.querySelector(`[data-testid="f257-governance-${section}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[data-testid="f257-governance-deltas"]')).not.toBeNull();
    const text = container.textContent ?? '';
    expect(text).not.toContain('old content');
    expect(text).not.toContain('new content');
    expect(text).toContain('规则正确性');
    expect(text).toContain('203/200');
    expect(text).toContain('cumulative / counterexamples');
    expect(text).toContain('上一版没有解释边界。');
    expect(text).toContain('检测器缺口 · metric-a');
    expect(text).toContain('当前结构化规则没有覆盖 invocation-1。');
    expect(text).toContain('invocation-1');
    expect(container.querySelector('[data-testid="f257-governance-evidence-link"]')).not.toBeNull();
    expect(text).not.toContain('批准会原子接受整张卡的动作列表');
    expect(text).not.toContain('跳过会保留当前版本并进入下一周期');
    expect(text).not.toContain('拒绝必须填写理由');
    expect(text).toContain('上周期');
    expect(text).toContain('本周期');
    expect(text).toContain('-2');
    expect(container.querySelector('[data-testid="f257-governance-metric-bar-previous"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="f257-governance-metric-bar-current"]')).not.toBeNull();
    expect(text).toContain('3 次');
    expect(text).toContain('逐条核对本周期反例后，共确认 3 次。');
    expect(text).not.toContain('{"kind"');
    expect(text).toContain('提案轮次：2');

    const diffButton = container.querySelector<HTMLButtonElement>('[data-testid="f257-governance-open-diff"]');
    expect(diffButton?.textContent).toContain('查看差异');
    expect(text).not.toContain('查看左右差异');
    expect(text).not.toContain('修改段内容');
    expect(container.querySelector('[data-testid="f257-governance-change"]')?.className).not.toContain('sm:flex-row');
    await act(async () => diffButton?.click());
    const dialog = document.body.querySelector('[data-testid="f257-governance-diff-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('应用前');
    expect(dialog?.textContent).toContain('应用后');
    expect(dialog?.textContent).toContain('old content');
    expect(dialog?.textContent).toContain('new content');
    expect(dialog?.querySelector('button[aria-pressed="true"]')?.textContent).toContain('Side-by-side');
  });

  it('shows only the immediately previous rejection reason on the current card', async () => {
    const repeatedRejectionItem: ApprovalHubItem = {
      ...ITEM,
      detail: {
        ...ITEM.detail,
        cardOrdinal: 4,
        rejectReasons: ['第一轮拒绝理由', '第二轮拒绝理由', '第三轮拒绝理由'],
      },
    };
    await act(async () => {
      root.render(
        <GenericApprovalRecommendation
          item={repeatedRejectionItem}
          f193TargetThreadId=""
          sourceThreadTitle="Harness Objective"
          targetThreadTitle={null}
          resolveCatName={(catId) => catId}
        />,
      );
    });

    const text = container.textContent ?? '';
    expect(text).toContain('上一轮拒绝理由：第三轮拒绝理由');
    expect(text).not.toContain('第一轮拒绝理由');
    expect(text).not.toContain('第二轮拒绝理由');
  });

  it('shows an appended paragraph as context plus additions instead of deleting the whole current segment', () => {
    const diff = fullContentDiff(
      'D8.content',
      '<!-- D8 -->\n\n现有球权规则。\n',
      '<!-- D8 -->\n\n现有球权规则。\n\n新增终止门。',
    );
    const lines = parseUnifiedDiff(diff)[0].hunks[0].lines;

    expect(lines.filter((line) => line.type === 'remove')).toHaveLength(0);
    expect(lines.filter((line) => line.type === 'context').map((line) => line.content)).toEqual([
      '<!-- D8 -->',
      '',
      '现有球权规则。',
      '',
    ]);
    expect(lines.filter((line) => line.type === 'add').map((line) => line.content)).toEqual(['新增终止门。']);
  });

  it('keeps unchanged lines as context when content changes in multiple places', () => {
    const diff = fullContentDiff('D8.content', 'a\nb\nc\nd\ne', 'a\nX\nc\nY\ne');
    const lines = parseUnifiedDiff(diff)[0].hunks[0].lines;

    expect(lines.filter((line) => line.type === 'context').map((line) => line.content)).toEqual(['a', 'c', 'e']);
    expect(lines.filter((line) => line.type === 'remove').map((line) => line.content)).toEqual(['b', 'd']);
    expect(lines.filter((line) => line.type === 'add').map((line) => line.content)).toEqual(['X', 'Y']);
  });

  it('states that a first-cycle proposal has no comparison baseline', async () => {
    const firstCycle = {
      ...ITEM,
      detail: {
        ...ITEM.detail,
        history: [],
        metricVisuals: [{ id: 'metric-a', currentValue: 3, previousValue: null, delta: null, lowerIsBetter: true }],
        hasComparisonBaseline: false,
        isFirstCycle: true,
      },
    };
    await act(async () => {
      root.render(
        <GenericApprovalRecommendation
          item={firstCycle}
          f193TargetThreadId=""
          sourceThreadTitle="Harness Objective"
          targetThreadTitle={null}
          resolveCatName={(catId) => catId}
        />,
      );
    });
    expect(container.textContent).toContain('首轮评估，暂无可比较的历史基线');
    expect(container.querySelector('[data-testid="f257-governance-first-cycle"]')).not.toBeNull();
  });

  it('shows disable impact in the action list and compares the full before state in the dialog', async () => {
    const disableItem: ApprovalHubItem = {
      ...ITEM,
      detail: {
        ...ITEM.detail,
        changes: [
          {
            unitId: 'D2',
            action: 'disable',
            reason: '消融验证该段是否仍有必要。',
            beforeEnabled: true,
            beforeContent: 'current hook content',
            objectiveImpact: { objectiveId: 'obj', remainingMemberCount: 2 },
          },
        ],
      },
    };
    await act(async () => {
      root.render(
        <GenericApprovalRecommendation
          item={disableItem}
          f193TargetThreadId=""
          sourceThreadTitle="Harness Objective"
          targetThreadTitle={null}
          resolveCatName={(catId) => catId}
        />,
      );
    });

    expect(container.textContent).toContain('动作后剩余成员段 2 个');
    expect(container.textContent).not.toContain('current hook content');
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="f257-governance-open-diff"]')?.click(),
    );
    const dialog = document.body.querySelector('[data-testid="f257-governance-diff-dialog"]');
    // operator 2026-09-10: disabling stops injection; it does not delete the body,
    // so the body must appear unchanged on both sides rather than struck through.
    expect(dialog?.textContent).toContain('current hook content');
    expect(dialog?.textContent).toContain('已停用，不注入');
    expect(dialog?.textContent).toContain('启用中，会注入');
  });

  it('offers approve/skip/reject and keeps reject disabled until a reason exists', async () => {
    const decide = vi.fn();
    await act(async () => {
      root.render(<HarnessGovernanceDecisionActions onDecide={decide} />);
    });
    const reject = container.querySelector<HTMLButtonElement>('[data-testid="reject-btn"]');
    expect(reject?.disabled).toBe(true);
    expect(reject?.className).toContain('disabled:bg-[var(--cafe-border)]');
    expect(reject?.className).toContain('disabled:border-cafe');
    expect(reject?.className).toContain('disabled:text-cafe-secondary');
    expect(reject?.className).not.toContain('disabled:bg-cafe-surface');
    expect(reject?.className).not.toContain('disabled:bg-semantic-critical-surface');
    expect(reject?.className).not.toContain('disabled:opacity-50');
    expect(container.querySelector('[data-testid="skip-btn"]')).not.toBeNull();

    const note = container.querySelector<HTMLTextAreaElement>('[data-testid="f257-governance-note"]');
    await act(async () => {
      if (!note) throw new Error('missing note');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(note, '评估漏掉了关键反例');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(reject?.disabled).toBe(false);
    await act(async () => reject?.click());
    expect(decide).toHaveBeenCalledWith('reject', '评估漏掉了关键反例');
  });

  async function openDiffDialog(changes: Array<Record<string, unknown>>) {
    const item = { ...ITEM, detail: { ...ITEM.detail, changes } } as ApprovalHubItem;
    await act(async () => {
      root.render(
        <GenericApprovalRecommendation
          item={item}
          f193TargetThreadId=""
          sourceThreadTitle="Harness Objective"
          targetThreadTitle={null}
          resolveCatName={(catId) => catId}
        />,
      );
    });
    const openButton = container.querySelector<HTMLButtonElement>('[data-testid="f257-governance-open-diff"]');
    await act(async () => openButton?.click());
    return document.body.querySelector('[data-testid="f257-governance-diff-dialog"]');
  }

  it('calls every action entry a diff entry regardless of action kind', async () => {
    await openDiffDialog([FULL_ADD_CHANGE]);
    const openButton = container.querySelector<HTMLButtonElement>('[data-testid="f257-governance-open-diff"]');
    expect(openButton?.textContent).toContain('查看差异');
    expect(openButton?.textContent).not.toContain('查看新增段内容');
  });

  it('gives an add action one comparison block per produced artifact', () => {
    expect(comparisonBlocks(FULL_ADD_CHANGE).map((block) => block.label)).toEqual([
      '段正文',
      'Hook 清单',
      '评估单元注册表',
    ]);
  });

  it('does not present a disable action as deleting the segment body', () => {
    const blocks = comparisonBlocks({ unitId: 'L4', action: 'disable', beforeContent: '保留的正文' });
    expect(blocks.map((block) => block.label)).toEqual(['启用状态', '段正文']);
    const body = blocks.find((block) => block.id === 'content');
    expect(body?.before).toBe('保留的正文');
    expect(body?.after).toBe('保留的正文');
  });

  it('puts the before/after headings inside the split diff instead of a detached row', async () => {
    const dialog = await openDiffDialog([FULL_ADD_CHANGE]);
    expect(dialog?.querySelector('[data-testid="f257-governance-before-heading"]')).toBeNull();
    expect(dialog?.querySelector('[data-testid="diff-split-header-before"]')?.textContent).toContain('应用前');
    expect(dialog?.querySelector('[data-testid="diff-split-header-after"]')?.textContent).toContain('应用后');
  });

  it('wraps long diff lines instead of forcing horizontal scrolling', async () => {
    const dialog = await openDiffDialog([FULL_ADD_CHANGE]);
    const cell = dialog?.querySelector('[data-diff-line]');
    expect(cell?.className).toContain('whitespace-pre-wrap');
    expect(cell?.className).not.toContain('overflow-x-auto');
  });

  // HarnessGovernanceExecutor.hydrateAdd sets hookId = unitId (not the slug).
  const FULL_ADD_CHANGE = {
    unitId: 'D22',
    action: 'add',
    hookId: 'D22',
    assetSlug: 'd22-termination-gate',
    reason: '补入终止门',
    content: '新段正文',
    manifest: {
      id: 'D22',
      name: '终止门',
      stage: 'per-turn',
      order: 2200,
      version: 1,
      enabled: true,
      template: 'content.md',
      inputs: ['threadId'],
      // HookVariableDef is { name, description?, placeholder? } — `source` is not a field.
      variables: [{ name: 'catId', description: '第一行\n第二行: 这不是新键' }],
      disableable: true,
      safetyTier: 'editable',
      transparencyTier: 'visible-by-default',
      governanceTier: 'human-gated',
    },
    // HarnessUnitDirectoryWriter.validate rejects clauseId on add.
    objectives: [{ objectiveId: 'tool-access' }],
  } satisfies HarnessGovernanceProposalChange;

  // P2-C (sol @ ccd01dabf): the dialog must name the files the executor really
  // writes, and must not silently drop object/array manifest fields.
  it('projects an add onto the artifacts the executor actually writes', () => {
    const blocks = comparisonBlocks(FULL_ADD_CHANGE);
    expect(blocks.map((block) => block.path)).toEqual([
      'assets/prompt-hooks/d22-termination-gate/content.md',
      'assets/prompt-hooks/d22-termination-gate/hook.yaml',
      'docs/harness-feedback/objectives/unit-evaluation-manifest.yaml',
    ]);
    const manifestBlock = blocks.find((block) => block.id === 'manifest');
    expect(manifestBlock?.after).toContain('inputs:');
    expect(manifestBlock?.after).toContain('threadId');
    expect(manifestBlock?.after).toContain('variables:');
    expect(manifestBlock?.after).toContain('catId');
    const registryBlock = blocks.find((block) => block.id === 'registry');
    expect(registryBlock?.after).toContain('d22-termination-gate');
    expect(registryBlock?.after).toContain('tool-access');
  });

  // P2-B (sol @ ccd01dabf): beforeEnabled is authoritative; the card must not
  // invent a before-state, and a no-op must read as a no-op.
  it('derives the enablement before-state from beforeEnabled, including no-ops', () => {
    const noop = comparisonBlocks({
      unitId: 'L4',
      action: 'enable',
      hookId: 'l4',
      beforeEnabled: true,
      beforeContent: 'body',
    });
    const noopState = noop.find((block) => block.id === 'state');
    expect(noopState?.before).toBe(noopState?.after);

    const real = comparisonBlocks({
      unitId: 'L4',
      action: 'disable',
      hookId: 'l4',
      beforeEnabled: true,
      beforeContent: 'body',
    });
    const realState = real.find((block) => block.id === 'state');
    expect(realState?.before).toContain('启用');
    expect(realState?.after).toContain('停用');

    const unknown = comparisonBlocks({ unitId: 'L4', action: 'disable', hookId: 'l4', beforeContent: 'body' });
    expect(unknown.find((block) => block.id === 'state')?.before).toContain('未声明');
  });

  // sol delta @91aa4b428 (P2): change.hookId is manifest.id (e.g. "L4"), the
  // registry says "l4-iron-laws" and the real directory is "l4-五条铁律" —
  // three different values. An existing segment's path is not derivable, so
  // the card must not print one.
  it('refuses to print a path for segments whose directory is not derivable', () => {
    for (const action of ['modify', 'disable', 'enable', 'rollback']) {
      const blocks = comparisonBlocks({
        unitId: 'L4',
        hookId: 'L4',
        action,
        beforeEnabled: true,
        beforeContent: 'body',
        proposedContent: 'next',
        targetContent: 'next',
      });
      for (const block of blocks) {
        expect(block.path).toBeNull();
        expect(JSON.stringify(block)).not.toContain('assets/prompt-hooks/L4');
      }
    }
  });

  it('still uses the authoritative assetSlug path for an add', () => {
    expect(comparisonBlocks(FULL_ADD_CHANGE).map((block) => block.path)).toEqual([
      'assets/prompt-hooks/d22-termination-gate/content.md',
      'assets/prompt-hooks/d22-termination-gate/hook.yaml',
      'docs/harness-feedback/objectives/unit-evaluation-manifest.yaml',
    ]);
  });

  // sol delta @91aa4b428 (P2): every scalar went through String(), so a value
  // containing a newline or ": " silently became a new top-level key.
  it('encodes ambiguous scalars reversibly instead of merging them into keys', () => {
    const manifestBlock = comparisonBlocks(FULL_ADD_CHANGE).find((block) => block.id === 'manifest');
    const after = manifestBlock?.after ?? '';

    expect(after).toContain(JSON.stringify('第一行\n第二行: 这不是新键'));
    expect(after).not.toContain('\n第二行: 这不是新键');
    expect(after.split('\n').filter((line) => /^\s*stage:/.test(line))).toHaveLength(1);
    // a boolean stays bare so it remains distinguishable from the string "true"
    expect(after).toMatch(/enabled: true(\n|$)/);
    expect(after).toContain('safetyTier: editable');
  });

  // sol delta @a525247dc (P2): enable/disable/modify/rollback write the runtime
  // override/version store — no file is touched — so the whole file framing is
  // false, not just the path.
  it('drops all file metadata for comparisons that touch no file', async () => {
    const dialog = await openDiffDialog([
      { unitId: 'L4', hookId: 'L4', action: 'disable', beforeEnabled: true, beforeContent: 'body' },
    ]);
    expect(dialog?.textContent).not.toContain('file changed');
    expect(dialog?.textContent).not.toContain('files changed');
    expect(dialog?.textContent).not.toContain('assets/prompt-hooks');
  });

  // sol delta @a525247dc (P2): the writer creates the body + hook.yaml but
  // APPENDS to the existing unit-evaluation-manifest.yaml. Rendering all three
  // as empty→full hides exactly the 新增/修改 distinction lang asked for.
  it('distinguishes newly created artifacts from an appended registry entry', () => {
    expect(comparisonBlocks(FULL_ADD_CHANGE).map((block) => block.operation)).toEqual(['create', 'create', 'append']);
  });

  it('keeps runtime-only changes labelled as runtime rather than file writes', () => {
    const blocks = comparisonBlocks({
      unitId: 'L4',
      hookId: 'L4',
      action: 'disable',
      beforeEnabled: true,
      beforeContent: 'b',
    });
    expect(blocks.every((block) => block.operation === 'runtime')).toBe(true);
  });
});
