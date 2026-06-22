/**
 * F233 Phase C C3 — TrajectoryCard 渲染 test。
 * 核心：提包球警示 banner + 边界（猫还在聊则不是提包球）+ kind/source 标签渲染。
 */

import type { FeatTrajectoryEntry, GitRefSnapshot } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { TrajectoryCard } from '../TrajectoryCard';

const containers: HTMLElement[] = [];
function renderCard(entry: FeatTrajectoryEntry): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  act(() => {
    root.render(<TrajectoryCard entry={entry} />);
  });
  return container;
}
afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
});

const baseSnapshot: GitRefSnapshot = {
  branchName: 'fix/f188-phase-k',
  headCommitSha: 'abc1234def',
  headCommitAt: 2000,
  prNumber: null,
  prState: null,
  mergedToMain: null,
  prOpenedAt: null,
  prMergedAt: null,
  authorIdentity: 'opus-47',
  featureCandidates: ['F188'],
  associatedThreadIds: ['thread_x'],
  lastThreadMessageAt: 1000, // < headCommitAt → 提包球
  lastThreadActivityAt: 1000,
  joinProvenance: { confidence: 'high', joinedVia: ['branch_name_F#'] },
  collectedAt: 9000,
};

function makeEntry(over: Partial<FeatTrajectoryEntry>): FeatTrajectoryEntry {
  return {
    entryId: 'e1',
    subjectKey: 'feat:F188',
    featId: 'F188',
    at: 5000,
    kind: 'launched',
    source: 'event-stream',
    payload: {},
    ...over,
  };
}

describe('TrajectoryCard 渲染', () => {
  it('提包球 entry → 警示 banner + bucket + data-stale=true', () => {
    const c = renderCard(
      makeEntry({
        kind: 'branch_stale_unmerged',
        source: 'git-ref-snapshot',
        at: 9000,
        payload: { staleBucket: '7d', snapshot: baseSnapshot },
      }),
    );
    expect(c.textContent).toContain('猫咪已提包离线');
    expect(c.textContent).toContain('7d');
    expect(c.querySelector('[data-stale="true"]')).toBeTruthy();
  });

  it('branch_stale 但猫还在聊（lastThreadMessageAt > headCommitAt）→ 无提包球 banner', () => {
    const c = renderCard(
      makeEntry({
        kind: 'branch_stale_unmerged',
        source: 'git-ref-snapshot',
        at: 9000,
        payload: { staleBucket: '7d', snapshot: { ...baseSnapshot, lastThreadMessageAt: 3000 } },
      }),
    );
    expect(c.textContent).not.toContain('猫咪已提包离线');
    expect(c.querySelector('[data-stale="false"]')).toBeTruthy();
  });

  it('event-stream launched → 启动 label + event-stream 源 + author', () => {
    const c = renderCard(makeEntry({ kind: 'launched', source: 'event-stream', payload: { author: 'opus-47' } }));
    expect(c.textContent).toContain('启动');
    expect(c.textContent).toContain('event-stream');
    expect(c.textContent).toContain('opus-47');
  });

  it('historical_stitched → stitched 源标签 + data-kind', () => {
    const c = renderCard(
      makeEntry({
        kind: 'historical_stitched',
        source: 'historical-stitched',
        payload: { stitchType: 'verdict_backfill' },
      }),
    );
    expect(c.textContent).toContain('stitched');
    expect(c.querySelector('[data-kind="historical_stitched"]')).toBeTruthy();
  });

  it('git-ref branch_pushed → 分支推送 summary 含 branch name', () => {
    const c = renderCard(
      makeEntry({
        kind: 'branch_pushed',
        source: 'git-ref-snapshot',
        at: 2000,
        payload: { snapshot: baseSnapshot },
      }),
    );
    expect(c.textContent).toContain('分支已推送');
    expect(c.textContent).toContain('fix/f188-phase-k');
  });
});
