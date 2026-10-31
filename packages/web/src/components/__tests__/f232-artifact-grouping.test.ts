/**
 * F232 Phase B: artifact grouping logic (pure functions).
 * Tests time/thread/cat grouping for global artifacts.
 */

import type { GlobalArtifactDTO } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { groupArtifacts, groupByCat, groupByThread, groupByTime } from '../artifacts/artifact-grouping';

// Fixed "now" for deterministic time grouping: 2026-06-14 12:00:00 UTC
const NOW = new Date('2026-06-14T12:00:00Z').getTime();
const TODAY = NOW - 3_600_000; // 1 hour ago
const YESTERDAY = NOW - 25 * 3_600_000; // 25 hours ago
const THIS_WEEK = NOW - 3 * 86_400_000; // 3 days ago
const OLDER = NOW - 14 * 86_400_000; // 2 weeks ago

function makeArtifact(overrides: Partial<GlobalArtifactDTO> & { name: string }): GlobalArtifactDTO {
  return {
    type: 'file',
    catId: 'opus',
    createdAt: TODAY,
    sourceMessageId: 'msg-1',
    threadId: 'T-1',
    threadTitle: 'Thread One',
    ...overrides,
  } as GlobalArtifactDTO;
}

const ARTIFACTS: GlobalArtifactDTO[] = [
  makeArtifact({
    name: 'today-1.png',
    type: 'image',
    createdAt: TODAY,
    catId: 'opus',
    threadId: 'T-1',
    threadTitle: 'F232 产物',
  }),
  makeArtifact({
    name: 'today-2.md',
    createdAt: TODAY - 1000,
    catId: 'codex',
    threadId: 'T-2',
    threadTitle: 'F229 审计',
  }),
  makeArtifact({
    name: 'yesterday.ts',
    type: 'code',
    createdAt: YESTERDAY,
    catId: 'opus',
    threadId: 'T-1',
    threadTitle: 'F232 产物',
  }),
  makeArtifact({
    name: 'this-week.md',
    createdAt: THIS_WEEK,
    catId: 'codex',
    threadId: 'T-2',
    threadTitle: 'F229 审计',
  }),
  makeArtifact({ name: 'old.pdf', createdAt: OLDER, catId: 'sonnet', threadId: 'T-3', threadTitle: '日常' }),
];

describe('F232 artifact grouping', () => {
  describe('groupByTime', () => {
    it('buckets into 今天/昨天/本周/更早', () => {
      const groups = groupByTime(ARTIFACTS, NOW);
      const labels = groups.map((g) => g.label);
      expect(labels).toEqual(['今天', '昨天', '本周', '更早']);
    });

    it('counts items per bucket correctly', () => {
      const groups = groupByTime(ARTIFACTS, NOW);
      expect(groups[0].count).toBe(2); // 今天: today-1, today-2
      expect(groups[1].count).toBe(1); // 昨天: yesterday
      expect(groups[2].count).toBe(1); // 本周: this-week
      expect(groups[3].count).toBe(1); // 更早: old
    });

    it('preserves original item order within a bucket', () => {
      const groups = groupByTime(ARTIFACTS, NOW);
      expect(groups[0].items.map((a) => a.name)).toEqual(['today-1.png', 'today-2.md']);
    });

    it('omits empty buckets', () => {
      const onlyToday = [ARTIFACTS[0]];
      const groups = groupByTime(onlyToday, NOW);
      expect(groups).toHaveLength(1);
      expect(groups[0].label).toBe('今天');
    });
  });

  describe('groupByThread', () => {
    it('groups by threadId with threadTitle as label', () => {
      const groups = groupByThread(ARTIFACTS);
      const labels = groups.map((g) => g.label);
      expect(labels).toContain('F232 产物');
      expect(labels).toContain('F229 审计');
      expect(labels).toContain('日常');
    });

    it('sorts by most recent first', () => {
      const groups = groupByThread(ARTIFACTS);
      // T-1 has today-1 (most recent), T-2 has today-2 (second most recent)
      expect(groups[0].label).toBe('F232 产物');
      expect(groups[1].label).toBe('F229 审计');
      expect(groups[2].label).toBe('日常');
    });

    it('counts items per thread', () => {
      const groups = groupByThread(ARTIFACTS);
      const f232 = groups.find((g) => g.label === 'F232 产物');
      expect(f232?.count).toBe(2); // today-1 + yesterday
      const f229 = groups.find((g) => g.label === 'F229 审计');
      expect(f229?.count).toBe(2); // today-2 + this-week
    });
  });

  describe('groupByCat', () => {
    const nicknames: Record<string, string> = { opus: '宪宪', codex: '砚砚', sonnet: '布偶猫 Sonnet' };
    const resolve = (id: string) => nicknames[id];

    it('groups by catId with nickname as label', () => {
      const groups = groupByCat(ARTIFACTS, resolve);
      const labels = groups.map((g) => g.label);
      expect(labels).toContain('宪宪');
      expect(labels).toContain('砚砚');
      expect(labels).toContain('布偶猫 Sonnet');
    });

    it('sorts by count descending (most prolific cat first)', () => {
      const groups = groupByCat(ARTIFACTS, resolve);
      // opus: 2, codex: 2, sonnet: 1 — tie-break by insertion order
      expect(groups[0].count).toBeGreaterThanOrEqual(groups[1].count);
      expect(groups[1].count).toBeGreaterThanOrEqual(groups[2].count);
    });

    it('falls back to catId when nickname not found', () => {
      const groups = groupByCat(ARTIFACTS, () => undefined);
      expect(groups.map((g) => g.label)).toContain('opus');
    });
  });

  describe('P1 fix: stable group id (gpt52 review — duplicate labels)', () => {
    it('thread groups with same title get distinct ids', () => {
      const dupes: GlobalArtifactDTO[] = [
        makeArtifact({ name: 'a.md', threadId: 'T-A', threadTitle: '日常', createdAt: TODAY }),
        makeArtifact({ name: 'b.md', threadId: 'T-B', threadTitle: '日常', createdAt: YESTERDAY }),
      ];
      const groups = groupByThread(dupes);
      expect(groups).toHaveLength(2);
      // Labels are the same (both "日常") but ids must be distinct
      expect(groups[0].label).toBe('日常');
      expect(groups[1].label).toBe('日常');
      expect(groups[0].id).not.toBe(groups[1].id);
    });

    it('cat groups with same nickname get distinct ids', () => {
      // Two different catIds resolving to the same display name
      const dupes: GlobalArtifactDTO[] = [
        makeArtifact({ name: 'a.md', catId: 'opus-46', createdAt: TODAY }),
        makeArtifact({ name: 'b.md', catId: 'opus-47', createdAt: YESTERDAY }),
      ];
      const groups = groupByCat(dupes, () => '宪宪'); // both resolve to same name
      expect(groups).toHaveLength(2);
      expect(groups[0].label).toBe('宪宪');
      expect(groups[1].label).toBe('宪宪');
      expect(groups[0].id).not.toBe(groups[1].id);
    });

    it('time groups have stable ids matching labels', () => {
      const groups = groupByTime(ARTIFACTS, NOW);
      for (const g of groups) {
        expect(g.id).toBe(g.label); // time labels are inherently unique
      }
    });

    it('mode=none group has stable id', () => {
      const groups = groupArtifacts(ARTIFACTS, 'none', () => undefined);
      expect(groups[0].id).toBe('__flat');
    });
  });

  describe('groupArtifacts dispatcher', () => {
    const resolve = (id: string) => (id === 'opus' ? '宪宪' : undefined);

    it('mode=none returns single group with all items', () => {
      const groups = groupArtifacts(ARTIFACTS, 'none', resolve);
      expect(groups).toHaveLength(1);
      expect(groups[0].count).toBe(5);
    });

    it('mode=time delegates to groupByTime', () => {
      const groups = groupArtifacts(ARTIFACTS, 'time', resolve, NOW);
      expect(groups.map((g) => g.label)).toEqual(['今天', '昨天', '本周', '更早']);
    });

    it('mode=thread delegates to groupByThread', () => {
      const groups = groupArtifacts(ARTIFACTS, 'thread', resolve);
      expect(groups.length).toBe(3);
    });

    it('mode=cat delegates to groupByCat', () => {
      const groups = groupArtifacts(ARTIFACTS, 'cat', resolve);
      expect(groups.some((g) => g.label === '宪宪')).toBe(true);
    });
  });
});
