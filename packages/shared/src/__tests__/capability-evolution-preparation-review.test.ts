import { describe, expect, it } from 'vitest';
import { evolutionAssetReviewV1Schema } from '../types/capability-evolution-asset-review.js';
import { evolutionPreparationReviewV1Schema } from '../types/capability-evolution-preparation-review.js';

const owner = (name: string) => ({ ownerFeatureId: 'test-owner', ownerStateRef: `source:${name}` });
const envelope = {
  schemaVersion: 1,
  programRef: { ownerFeatureId: 'F311', ownerStateRef: 'evolution-program:test' },
  objectRef: owner('object'),
};
const source = {
  sourceRef: owner('catalog'),
  readAt: '2026-09-07T00:00:00.000Z',
  updatedAt: '2026-09-06T23:59:00.000Z',
};
const blocker = { code: 'not_published', ownerRef: owner('missing') };
const material = {
  materialRef: owner('material'),
  title: '已有材料',
  summary: 'owner 发布的摘要',
  status: 'available',
  resources: [],
};
const published = (items: unknown[] = [structuredClone(material)]) => ({
  ...envelope,
  ...source,
  status: 'resolved',
  groups: [{ groupRef: owner('group'), title: 'owner 的任意分组', items }],
  blockers: [],
});

describe('owner preparation publication', () => {
  it('represents unknown, unpublished, failed, truly empty and partial independently', () => {
    const values = [
      { ...envelope, status: 'unknown', blockers: [blocker] },
      { ...envelope, ...source, status: 'unpublished', blockers: [] },
      { ...envelope, status: 'unavailable', blockers: [blocker] },
      { ...published(), groups: [] },
      { ...published(), blockers: [blocker] },
    ];
    for (const value of values) expect(evolutionPreparationReviewV1Schema.safeParse(value).success).toBe(true);
    expect(evolutionPreparationReviewV1Schema.safeParse({ ...envelope, status: 'unknown', blockers: [] }).success).toBe(
      false,
    );
  });

  it('keeps owner-named facts and exact candidate bindings without encoding a global checklist', () => {
    const value = published([
      {
        ...material,
        facts: [
          { label: '由谁负责', value: '实验 owner' },
          { label: '缺什么', value: '后续独立验证' },
        ],
        candidateVersionRef: {
          ...owner('candidate'),
          assetKind: 'control-package',
          assetId: 'candidate',
          version: 'v1',
        },
      },
    ]);
    const result = evolutionPreparationReviewV1Schema.parse(value);
    expect(result.status === 'resolved' && result.groups[0]?.items[0]?.candidateVersionRef?.assetKind).toBe(
      'control-package',
    );
  });

  it.each([
    'running',
    'completed',
    'awaiting_publication',
    'failed',
  ] as const)('carries owner activity state %s, its real update time and exact video identity', (state) => {
    const mediaRef = {
      ...owner('video:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      version: 'a'.repeat(64),
    };
    const value = published([
      {
        ...material,
        activity: { state, updatedAt: '2026-09-06T23:59:00.000Z', detail: 'owner 公开的活动说明' },
        resources: [
          {
            label: '真实回放',
            sourceRef: mediaRef,
            ownerHref: 'https://example.test/immutable/video.mp4',
            media: { mediaRef, contentType: 'video/mp4', durationSeconds: 20.1 },
          },
        ],
      },
    ]);
    const result = evolutionPreparationReviewV1Schema.parse(value);
    expect(result.status === 'resolved' && result.updatedAt).toBe(source.updatedAt);
    expect(result.status === 'resolved' && result.groups[0]?.items[0]?.activity?.state).toBe(state);
  });

  it('rejects fake media types, non-positive duration and media/source identity drift', () => {
    const hash = 'a'.repeat(64);
    const mediaRef = { ...owner(`video:sha256:${hash}`), version: hash };
    const resource = {
      label: '真实回放',
      sourceRef: mediaRef,
      media: { mediaRef, contentType: 'video/mp4', durationSeconds: 20.1 },
    };
    for (const media of [
      { ...resource.media, contentType: 'text/html' },
      { ...resource.media, durationSeconds: 0 },
      { ...resource.media, mediaRef: { ...mediaRef, version: 'b'.repeat(64) } },
    ]) {
      expect(
        evolutionPreparationReviewV1Schema.safeParse(published([{ ...material, resources: [{ ...resource, media }] }]))
          .success,
      ).toBe(false);
    }
  });

  it('rejects duplicate refs, invalid links and execution claims in read payloads', () => {
    const value = published();
    expect(evolutionPreparationReviewV1Schema.safeParse({ ...value, adopted: true }).success).toBe(false);
    expect(
      evolutionPreparationReviewV1Schema.safeParse({ ...value, groups: [...value.groups, ...value.groups] }).success,
    ).toBe(false);
    expect(evolutionPreparationReviewV1Schema.safeParse(published([material, material])).success).toBe(false);
    for (const ownerHref of ['javascript:alert(1)', '//outside.invalid', '/\\outside.invalid', '/source\nmalformed']) {
      const unsafe = published([
        {
          ...material,
          resources: [{ label: '原文', sourceRef: owner('raw'), ownerHref }],
        },
      ]);
      expect(evolutionPreparationReviewV1Schema.safeParse(unsafe).success).toBe(false);
    }
  });

  it('existing version catalog can expose distinct public package assets without inventing adoption or parent edges', () => {
    const policy = { ...owner('policy'), assetKind: 'onnx-policy', assetId: 'walking', version: 'official' };
    const candidate = {
      ...owner('package'),
      assetKind: 'control-package',
      assetId: 'action-scale-110',
      version: 'sha256-candidate',
    };
    const value = {
      ...envelope,
      sourceRef: source.sourceRef,
      readAt: source.readAt,
      status: 'resolved',
      currentVersionRefs: [policy],
      currentProofRef: owner('official-current'),
      versions: [
        { versionRef: policy, parentEdges: [] },
        { versionRef: candidate, parentEdges: [] },
      ],
      selected: { versionRef: candidate, diff: { status: 'unavailable', blocker }, evidence: [], uses: [] },
      blockers: [blocker],
    };
    expect(evolutionAssetReviewV1Schema.safeParse(value).success).toBe(true);
    const falseComparison = {
      ...value,
      selected: {
        ...value.selected,
        diff: {
          status: 'available',
          comparedToVersionRef: policy,
          summary: '错误的跨资产对比',
          rawDiffRef: owner('diff'),
        },
      },
    };
    expect(evolutionAssetReviewV1Schema.safeParse(falseComparison).success).toBe(false);
  });
});
