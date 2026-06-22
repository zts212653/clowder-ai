/**
 * F235 Phase B: CommunityIssueDraftCard — routing + render tests.
 *
 * Uses SSR (renderToStaticMarkup) to test initial render state without
 * browser environment. API calls (useEffect-driven) don't fire in SSR,
 * so we test the static "editing" state only. Integration tests for the
 * full create → publish flow happen at the API layer (Task 2 + Task 5).
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CommunityIssueDraftCard, isCommunityIssueDraftBlock } from '../CommunityIssueDraftCard';
import { RichBlocks } from '../RichBlocks';

Object.assign(globalThis as Record<string, unknown>, { React });

const draftBlock = {
  id: 'b_draft_1',
  kind: 'card' as const,
  v: 1 as const,
  title: 'Publish to Community',
  bodyMarkdown: 'Cat suggests publishing this issue.',
  tone: 'info' as const,
  meta: {
    kind: 'community_issue_draft',
    proposedTitle: 'Bug: tool calls fail silently',
    proposedBody: '## Problem\n\nTool calls return empty response.',
    proposedRepo: 'clowder-ai/cat-cafe',
    proposedLabels: ['bug', 'ux'],
  },
};

describe('isCommunityIssueDraftBlock', () => {
  it('returns true for community_issue_draft meta.kind', () => {
    expect(isCommunityIssueDraftBlock(draftBlock)).toBe(true);
  });

  it('returns false for other meta.kind', () => {
    expect(
      isCommunityIssueDraftBlock({
        ...draftBlock,
        meta: { kind: 'callback_auth_failure' },
      }),
    ).toBe(false);
  });

  it('returns false when meta is undefined', () => {
    expect(isCommunityIssueDraftBlock({ ...draftBlock, meta: undefined })).toBe(false);
  });

  it('does NOT require connector provenance (cat messages are inherently trusted)', () => {
    // Phase A preview cards require messageSource.connector === 'community-publisher'.
    // Phase B draft cards come from cats — no connector check needed (OQ-2).
    expect(isCommunityIssueDraftBlock(draftBlock)).toBe(true);
  });
});

describe('CommunityIssueDraftCard', () => {
  it('renders editable title from meta', () => {
    const html = renderToStaticMarkup(<CommunityIssueDraftCard block={draftBlock} />);
    expect(html).toContain('Bug: tool calls fail silently'); // proposedTitle in input value
    expect(html).toContain('Publish to Community'); // header
    expect(html).toContain('draft'); // badge
  });

  it('renders editable body from meta', () => {
    const html = renderToStaticMarkup(<CommunityIssueDraftCard block={draftBlock} />);
    expect(html).toContain('Tool calls return empty response');
  });

  it('renders proposed labels', () => {
    const html = renderToStaticMarkup(<CommunityIssueDraftCard block={draftBlock} />);
    expect(html).toContain('bug, ux');
  });

  it('renders submit and cancel buttons', () => {
    const html = renderToStaticMarkup(<CommunityIssueDraftCard block={draftBlock} />);
    expect(html).toContain('Submit to GitHub');
    expect(html).toContain('Cancel');
  });

  it('renders repo input (fallback when config not yet loaded)', () => {
    const html = renderToStaticMarkup(<CommunityIssueDraftCard block={draftBlock} />);
    // On SSR, repos array is empty → renders text input with proposedRepo value
    expect(html).toContain('clowder-ai/cat-cafe');
    expect(html).toContain('Target Repository');
  });
});

describe('RichBlocks routing to CommunityIssueDraftCard', () => {
  it('routes community_issue_draft card to CommunityIssueDraftCard', () => {
    const html = renderToStaticMarkup(<RichBlocks blocks={[draftBlock]} />);
    // CommunityIssueDraftCard renders "Submit to GitHub" button — default CardBlock doesn't
    expect(html).toContain('Submit to GitHub');
    expect(html).toContain('draft'); // badge
  });

  it('does NOT route regular card blocks to CommunityIssueDraftCard', () => {
    const regularCard = {
      id: 'b_regular',
      kind: 'card' as const,
      v: 1 as const,
      title: 'Just a card',
      bodyMarkdown: 'Nothing special',
    };
    const html = renderToStaticMarkup(<RichBlocks blocks={[regularCard]} />);
    expect(html).not.toContain('Submit to GitHub');
    expect(html).toContain('Just a card');
  });
});
