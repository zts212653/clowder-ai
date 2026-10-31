import { describe, expect, it } from 'vitest';
import { encodeVideoProjectCheckPageDefinition } from '../types/video-project-check-definition.js';
import type { VideoProjectCheckPage } from '../types/video-project-settings.js';

const page: VideoProjectCheckPage = {
  id: 'face',
  name: '脸部 🐾',
  criteria: '看 "眼神"\\原样\n下一行\u2028é',
  references: ['图2', '图1'],
  scope: { kind: 'allScenes' },
  assignee: null,
  origin: { kind: 'imported', actor: null, at: '2026-10-08T00:00:00.000Z', refs: ['原稿'] },
};

describe('check-page definition canonical encoding v1', () => {
  it('matches Python ensure_ascii=False sorted-key compact JSON for unchanged Unicode and escaped text', () => {
    // Captured with Python json.dumps(..., ensure_ascii=False, sort_keys=True, separators=(',', ':')).
    const expected =
      '{"assignee":null,"criteria":"看 \\"眼神\\"\\\\原样\\n下一行\u2028é","id":"face","name":"脸部 🐾","origin":{"actor":null,"at":"2026-10-08T00:00:00.000Z","kind":"imported","refs":["原稿"]},"references":["图2","图1"],"scope":{"kind":"allScenes"}}';
    expect(encodeVideoProjectCheckPageDefinition(page)).toBe(expected);
  });

  it('ignores object insertion order and omitted undefined fields while preserving array order', () => {
    const reordered: VideoProjectCheckPage = {
      ...(Object.fromEntries(Object.entries(page).reverse()) as VideoProjectCheckPage),
      origin: { refs: ['原稿'], at: page.origin.at, actor: null, kind: 'imported', converter: undefined },
      archivedAt: undefined,
    };
    expect(encodeVideoProjectCheckPageDefinition(reordered)).toBe(encodeVideoProjectCheckPageDefinition(page));
    expect(encodeVideoProjectCheckPageDefinition({ ...page, references: ['图1', '图2'] })).not.toBe(
      encodeVideoProjectCheckPageDefinition(page),
    );
    expect(
      encodeVideoProjectCheckPageDefinition({ ...page, criteria: page.criteria.replace('é', 'e\u0301') }),
    ).not.toBe(encodeVideoProjectCheckPageDefinition(page));
  });

  it('rejects unpaired surrogates that Python cannot encode as UTF-8', () => {
    for (const criteria of ['bad\ud800', 'bad\udc00', '\udc00\ud800'])
      expect(() => encodeVideoProjectCheckPageDefinition({ ...page, criteria })).toThrow(/Unicode scalar/);
  });
});
