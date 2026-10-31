import type { FeatureStoryRenderingDTO } from '@cat-cafe/shared';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BirdseyeView } from '../BirdseyeView';

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
});

function makeData(overrides: Partial<FeatureStoryRenderingDTO> = {}): FeatureStoryRenderingDTO {
  return {
    storyId: 'feat:F255',
    featId: 'F255',
    title: 'F255: Feature Story',
    timeRange: { start: 0, end: 120_000_000 },
    lanes: [
      { threadId: 'thread-a', threadName: 'Thread A', participants: ['opus'], markers: [] },
      { threadId: 'thread-b', threadName: 'Thread B', participants: ['codex'], markers: [] },
    ],
    edges: [],
    milestones: [],
    ...overrides,
  };
}

function attrValues(html: string, attr: string): string[] {
  return [...html.matchAll(new RegExp(`${attr}=(?:"|&quot;)([^"&]+)(?:"|&quot;)`, 'g'))].map((match) => match[1]);
}

describe('BirdseyeView causal edges', () => {
  it('sizes the edge overlay to the full timeline width', () => {
    const html = renderToStaticMarkup(<BirdseyeView data={makeData()} />);

    expect(html).toContain('<svg');
    expect(html).toContain('width="1400"');
    expect(html).not.toContain('width:100%');
  });

  it('separates overlapping bidirectional cross-thread edges', () => {
    const html = renderToStaticMarkup(
      <BirdseyeView
        data={makeData({
          edges: [
            {
              id: 'edge-a-to-b',
              kind: 'thread_merge',
              from: { threadId: 'thread-a', time: 60_000_000 },
              to: { threadId: 'thread-b', time: 60_000_000 },
              label: 'Cross-post by opus',
              confidence: 'high',
            },
            {
              id: 'edge-b-to-a',
              kind: 'thread_merge',
              from: { threadId: 'thread-b', time: 60_000_000 },
              to: { threadId: 'thread-a', time: 60_000_000 },
              label: 'Cross-post by codex',
              confidence: 'high',
            },
          ],
        })}
      />,
    );

    const lineX1Values = attrValues(html, 'x1');
    expect(new Set(lineX1Values).size).toBeGreaterThan(1);

    const textYValues = attrValues(html, 'y');
    expect(new Set(textYValues).size).toBeGreaterThan(1);
  });
});
