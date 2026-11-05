import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import {
  artifactObjectId,
  legacyArtifactObjectId,
  parseArtifactObjectId,
  sameWidgetCoordinate,
  widgetArtifactObjectId,
} from '../artifact-object-key';

function widget(blockId: string | undefined, name = '同名'): ThreadArtifactDTO {
  return {
    type: 'widget',
    name,
    catId: 'opus-48',
    createdAt: 1_700_000_000_000,
    sourceMessageId: 'msg-1',
    ...(blockId === undefined ? {} : { widgetBlockId: blockId }),
  };
}

describe('F232 PR-A widget coordinates', () => {
  it('two same-name widgets in one message get different identities', () => {
    const first = widget('block-a');
    const second = widget('block-b');
    expect(artifactObjectId(first)).not.toBe(artifactObjectId(second));
    expect(widgetArtifactObjectId(first)).not.toBeNull();
  });

  it('identity does not depend on createdAt or name drift', () => {
    const original = widget('block-a');
    const renamed = { ...original, name: '改名了', createdAt: original.createdAt + 21_000 };
    expect(artifactObjectId(renamed)).toBe(artifactObjectId(original));
  });

  it('round-trips the coordinate form and keeps the block id', () => {
    const id = artifactObjectId(widget('block-b'));
    const parsed = parseArtifactObjectId(id);
    expect(parsed?.type).toBe('widget');
    expect(parsed?.sourceMessageId).toBe('msg-1');
    expect(parsed?.widgetBlockId).toBe('block-b');
  });

  it('still parses the legacy tuple and keeps it distinct from the coordinate form', () => {
    const legacy = widget(undefined);
    const legacyId = artifactObjectId(legacy);
    const parsed = parseArtifactObjectId(legacyId);
    expect(parsed?.type).toBe('widget');
    expect(parsed?.widgetBlockId).toBeUndefined();
    // 旧坐标与新坐标不是同一个 key：旧入口必须走唯一匹配回落，不能直接混用。
    expect(legacyId).not.toBe(artifactObjectId(widget('block-a')));
  });

  it('legacy id for two same-name widgets is shared, which is exactly why the coordinate exists', () => {
    expect(legacyArtifactObjectId(widget('block-a'))).toBe(legacyArtifactObjectId(widget('block-b')));
  });

  it('matches only the exact message + block pair', () => {
    expect(sameWidgetCoordinate(widget('block-a'), { sourceMessageId: 'msg-1', blockId: 'block-a' })).toBe(true);
    expect(sameWidgetCoordinate(widget('block-a'), { sourceMessageId: 'msg-1', blockId: 'block-b' })).toBe(false);
    expect(sameWidgetCoordinate(widget('block-a'), { sourceMessageId: 'msg-2', blockId: 'block-a' })).toBe(false);
  });

  it('does not treat an interactive widget (no coordinate) as a coordinate target', () => {
    expect(widgetArtifactObjectId(widget(undefined))).toBeNull();
    expect(parseArtifactObjectId(artifactObjectId(widget(undefined)))?.widgetBlockId).toBeUndefined();
  });
});
