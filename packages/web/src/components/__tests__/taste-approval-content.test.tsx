import type { ApprovalHubItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';
import { TasteApprovalContent } from '../rich/DomainApprovalContent';

vi.mock('@/hooks/useThreadDisplayInfo', () => ({ useThreadDisplayInfo: () => ({}) }));

it('shows every house-public field as literal text without collapsed quotes or remote images', async () => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  const quote = '![private words](https://example.invalid/private.png)';
  const scene = `${'Long scene. '.repeat(50)}last sentence`;
  const item: ApprovalHubItem = {
    sourceFeatureId: 'F221',
    proposalId: 'taste-test',
    ownerUserId: 'owner',
    requesterCatId: 'codex-astra',
    resolution: 'open',
    materialization: { state: 'not_started' },
    createdAt: Date.now(),
    summary: 'Full candidate',
    inlineApprovable: true,
    navigation: anchoredApprovalNavigation('source'),
    detail: {
      privacy: 'public',
      scene,
      quote,
      quotes: [quote, 'Second original quote'],
      takeaway: '<!-- must stay visible -->',
      tags: ['full-tag'],
      dimension: 'creative-craft',
    },
  };
  try {
    await act(async () => root.render(<TasteApprovalContent item={item} />));
    expect(container.textContent).toContain(scene);
    expect(container.textContent).toContain(quote);
    expect(container.textContent).toContain('Second original quote');
    expect(container.textContent).toContain('<!-- must stay visible -->');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('details:not([open])')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
