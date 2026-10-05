import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { readWorkDetail } from '../work-detail';

type Linked = UnifiedAttentionItemV1['linkedNeedsMe'][number];

const linked = (receipt: Record<string, unknown>, ownerRead: Record<string, unknown> = {}): Linked =>
  ({
    ownerRead: {
      envelope: { subjectRef: 'task:1', revision: 1, visibility: { ownerUserId: 'owner-1' } },
      ...ownerRead,
    },
    receipt: { eligible: true, producer: { producerId: 'p', subjectRef: 's', revision: 1 }, ...receipt },
  }) as unknown as Linked;

const item = (kind: 'judgment' | 'repair', entries: Linked[]): UnifiedAttentionItemV1 => ({
  decisionRef: 'd:1',
  kind,
  summary: '受托工作',
  linkedNeedsMe: entries,
});

const artifact = {
  artifactRef: 'a',
  artifactRevision: '1',
  completenessRef: 'c',
  previewRef: 'p',
  openInWorkspaceRef: 'w',
};

describe('what an expanded 等你判断 / 需要修复 row may say, read only from the contract', () => {
  it('takes the recommendation, the known goal and whether prepared work exists from the eligible receipt', () => {
    const detail = readWorkDetail(
      item('judgment', [
        linked(
          { kind: 'judgment', recommendation: '用 v3' },
          {
            brief: { outcome: { state: 'known', value: '下周会议封面' } },
            work: { title: '会议封面', ownerCatId: 'gemini' },
            preparedArtifact: artifact,
          },
        ),
      ]),
    );
    expect(detail).toEqual({
      recommendation: '用 v3',
      goal: '下周会议封面',
      workTitle: '会议封面',
      ownerCatId: 'gemini',
      preparedWork: '准备好的作品',
    });
  });

  it('says nothing it was not given: no linked entry, no fields', () => {
    expect(readWorkDetail(item('repair', []))).toEqual({
      recommendation: null,
      goal: null,
      workTitle: null,
      ownerCatId: null,
      preparedWork: null,
    });
  });

  it('ignores an ineligible receipt even when it carries text', () => {
    const detail = readWorkDetail(
      item('judgment', [linked({ eligible: false, kind: 'judgment', recommendation: '不该出现' })]),
    );
    expect(detail.recommendation).toBeNull();
  });

  it('ignores a receipt of the other kind: a repair never borrows a judgment’s advice', () => {
    const detail = readWorkDetail(item('repair', [linked({ kind: 'judgment', recommendation: '判断建议' })]));
    expect(detail.recommendation).toBeNull();
  });

  it('uses the first matching entry when several are linked', () => {
    const detail = readWorkDetail(
      item('judgment', [
        linked({ kind: 'repair', recommendation: '修复建议' }),
        linked({ kind: 'judgment', recommendation: '第一条判断' }),
        linked({ kind: 'judgment', recommendation: '第二条判断' }),
      ]),
    );
    expect(detail.recommendation).toBe('第一条判断');
  });

  it('treats a goal that is not known as absent, not as an empty string or the word unknown', () => {
    for (const outcome of [{ state: 'unknown' }, { state: 'known' }, { state: 'known', value: '   ' }, 'text', null]) {
      const detail = readWorkDetail(item('judgment', [linked({ kind: 'judgment' }, { brief: { outcome } })]));
      expect(detail.goal).toBeNull();
    }
  });

  it('treats blank advice as absent', () => {
    expect(readWorkDetail(item('judgment', [linked({ kind: 'judgment', recommendation: '  ' })])).recommendation).toBe(
      null,
    );
    expect(readWorkDetail(item('judgment', [linked({ kind: 'judgment', recommendation: 3 })])).recommendation).toBe(
      null,
    );
  });

  it('names prepared work as the original panel does: neutral, with the round only for a cat-prepared review', () => {
    const label = (preparedArtifact: unknown) =>
      readWorkDetail(item('judgment', [linked({ kind: 'judgment' }, { preparedArtifact })])).preparedWork;
    expect(label(artifact)).toBe('准备好的作品');
    const review = {
      ...artifact,
      artifactRevision: '3',
      previewRef: `content-review:review-${'a'.repeat(64)}:round:3`,
    };
    expect(label(review)).toBe('准备好的作品 · 第 3 版');
    // A ref is never a name.
    expect(label(artifact)).not.toContain(artifact.artifactRef + artifact.previewRef);
  });

  it('counts prepared work only when its coordinate is whole', () => {
    const label = (preparedArtifact: unknown) =>
      readWorkDetail(item('judgment', [linked({ kind: 'judgment' }, { preparedArtifact })])).preparedWork;
    expect(label({ ...artifact, openInWorkspaceRef: '' })).toBeNull();
    expect(label('x')).toBeNull();
    expect(label(undefined)).toBeNull();
  });

  it('reads the entrusted work title only when it is present text', () => {
    const title = (work: unknown) =>
      readWorkDetail(item('judgment', [linked({ kind: 'judgment' }, { work })])).workTitle;
    expect(title({ title: '下周会议封面' })).toBe('下周会议封面');
    for (const odd of [undefined, null, 'x', {}, { title: '  ' }, { title: 3 }]) expect(title(odd)).toBeNull();
  });

  it('reads the owning cat only when it is present text', () => {
    const owner = (work: unknown) =>
      readWorkDetail(item('judgment', [linked({ kind: 'judgment' }, { work })])).ownerCatId;
    expect(owner({ ownerCatId: 'gemini' })).toBe('gemini');
    for (const odd of [undefined, null, 'x', {}, { ownerCatId: ' ' }, { ownerCatId: 4 }]) expect(owner(odd)).toBeNull();
  });

  it('never throws on a shape from a newer producer', () => {
    const odd = {
      decisionRef: 'd',
      kind: 'judgment',
      summary: 's',
      linkedNeedsMe: [null, 7, { ownerRead: null, receipt: null }, { ownerRead: {}, receipt: {} }],
    } as unknown as UnifiedAttentionItemV1;
    expect(readWorkDetail(odd)).toEqual({
      recommendation: null,
      goal: null,
      workTitle: null,
      ownerCatId: null,
      preparedWork: null,
    });
  });

  it('has no field for “what choosing it will cause”: the contract does not carry one, so none is invented', () => {
    const detail = readWorkDetail(
      item('judgment', [linked({ kind: 'judgment', recommendation: 'x', consequence: '会发生 Y' })]),
    );
    expect(Object.keys(detail).sort()).toEqual(['goal', 'ownerCatId', 'preparedWork', 'recommendation', 'workTitle']);
  });
});
