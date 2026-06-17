/**
 * F232 Phase B: Cat filter logic — extract unique cats from artifacts
 * and filter by catId. Pure functions, no React dependency.
 */
import type { GlobalArtifactDTO } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { extractCatChips, filterByCat } from '../artifacts/artifact-filters';

function makeArtifact(overrides: Partial<GlobalArtifactDTO> & { name: string }): GlobalArtifactDTO {
  return {
    type: 'file',
    catId: 'opus',
    createdAt: Date.now(),
    sourceMessageId: 'msg-1',
    threadId: 'T-1',
    threadTitle: 'Thread One',
    ...overrides,
  } as GlobalArtifactDTO;
}

const ARTIFACTS: GlobalArtifactDTO[] = [
  makeArtifact({ name: 'a.png', type: 'image', catId: 'opus' }),
  makeArtifact({ name: 'b.md', catId: 'opus' }),
  makeArtifact({ name: 'c.pdf', catId: 'codex' }),
  makeArtifact({ name: 'd.ts', catId: 'codex' }),
  makeArtifact({ name: 'e.mp3', type: 'audio', catId: 'sonnet' }),
];

/** Fixtures including null catId (system/unknown origin — ThreadArtifactDTO allows it) */
const ARTIFACTS_WITH_NULL: GlobalArtifactDTO[] = [
  ...ARTIFACTS,
  makeArtifact({ name: 'system.log', catId: null }),
  makeArtifact({ name: 'auto-gen.txt', catId: null }),
];

describe('F232 cat filter', () => {
  describe('extractCatChips', () => {
    const resolve = (id: string) => ({ opus: '宪宪', codex: '砚砚', sonnet: '布偶猫 Sonnet' })[id];

    it('returns unique cats sorted by count descending', () => {
      const chips = extractCatChips(ARTIFACTS, resolve);
      expect(chips.length).toBe(3);
      // opus: 2, codex: 2, sonnet: 1
      expect(chips[0].count).toBeGreaterThanOrEqual(chips[1].count);
      expect(chips[1].count).toBeGreaterThanOrEqual(chips[2].count);
    });

    it('uses nickname as label, catId as key', () => {
      const chips = extractCatChips(ARTIFACTS, resolve);
      const opusChip = chips.find((c) => c.catId === 'opus');
      expect(opusChip?.label).toBe('宪宪');
    });

    it('falls back to catId when nickname not found', () => {
      const chips = extractCatChips(ARTIFACTS, () => undefined);
      expect(chips.some((c) => c.label === 'opus')).toBe(true);
    });

    it('returns empty array for empty artifacts', () => {
      expect(extractCatChips([], resolve)).toEqual([]);
    });

    it('counts correctly', () => {
      const chips = extractCatChips(ARTIFACTS, resolve);
      const opusChip = chips.find((c) => c.catId === 'opus');
      expect(opusChip?.count).toBe(2);
      const sonnetChip = chips.find((c) => c.catId === 'sonnet');
      expect(sonnetChip?.count).toBe(1);
    });

    it('normalizes null catId to "—" chip', () => {
      const chips = extractCatChips(ARTIFACTS_WITH_NULL, resolve);
      const unknownChip = chips.find((c) => c.catId === '—');
      expect(unknownChip).toBeDefined();
      expect(unknownChip?.count).toBe(2);
      expect(unknownChip?.label).toBe('—'); // no nickname resolver for '—'
    });
  });

  describe('filterByCat', () => {
    it('returns all when catId is null', () => {
      expect(filterByCat(ARTIFACTS, null)).toEqual(ARTIFACTS);
    });

    it('filters to matching catId', () => {
      const result = filterByCat(ARTIFACTS, 'opus');
      expect(result.length).toBe(2);
      expect(result.every((a) => a.catId === 'opus')).toBe(true);
    });

    it('returns empty for nonexistent catId', () => {
      expect(filterByCat(ARTIFACTS, 'nonexistent')).toEqual([]);
    });

    it('filters null-catId artifacts when sentinel "—" is selected', () => {
      const result = filterByCat(ARTIFACTS_WITH_NULL, '—');
      expect(result.length).toBe(2);
      expect(result.every((a) => a.catId === null)).toBe(true);
    });

    it('still filters named cats correctly with null-catId artifacts present', () => {
      const result = filterByCat(ARTIFACTS_WITH_NULL, 'opus');
      expect(result.length).toBe(2);
      expect(result.every((a) => a.catId === 'opus')).toBe(true);
    });
  });
});
