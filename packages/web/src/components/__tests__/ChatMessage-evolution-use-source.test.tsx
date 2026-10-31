import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_READING, useEvolutionReading } from '@/components/capability-evolution/evolution-reading-state';
import { useChatStore } from '@/stores/chatStore';
import {
  installReplyLayersActEnvironment,
  ReplyLayersHarness,
  streamReply,
  uninstallReplyLayersActEnvironment,
} from './ChatMessage-reply-layers.harness';

const programId = 'evolution-program:ba0f4524e49cc879279164d5b272cf8c';
const assetVersionRef = {
  ownerFeatureId: 'F100',
  ownerStateRef: 'skill:cat-cafe-skills/request-review/SKILL.md',
  version: 'a'.repeat(64),
  assetKind: 'skill',
  assetId: 'cat-cafe-skills/request-review/SKILL.md',
};
const source = {
  schemaVersion: 1 as const,
  programId,
  assetVersionRef,
  receiptRef: { ownerFeatureId: 'F100', ownerStateRef: 'request-review-use:receipt-1' },
  use: 'applied' as const,
  recordedAt: '2026-10-14T17:00:00.000Z',
};

describe('ChatMessage F311 exact-use source', () => {
  let harness: ReplyLayersHarness;

  beforeAll(installReplyLayersActEnvironment);
  afterAll(uninstallReplyLayersActEnvironment);
  beforeEach(() => {
    window.localStorage.clear();
    useEvolutionReading.setState({ programs: {}, workspaceProgramIds: {} });
    harness = new ReplyLayersHarness();
  });
  afterEach(() => harness.dispose());

  it('shows applied truth and opens exact source or governed rollback without writing', () => {
    harness.render(streamReply({ origin: 'callback', extra: { evolutionUseSourceV1: source } }));

    expect(harness.container.textContent).toContain('已沿用上次确认的规则');
    const sourceLink = harness.container.querySelector<HTMLAnchorElement>('[data-testid="evolution-use-source-open"]');
    expect(sourceLink?.textContent).toContain('查看来源');
    expect(sourceLink?.href).toContain(`evolutionProgram=${encodeURIComponent(programId)}`);

    act(() => sourceLink?.click());
    expect(useChatStore.getState().workspaceOpenRequest?.target).toEqual({ kind: 'evolution-program', programId });
    expect(useEvolutionReading.getState().programs[programId]).toMatchObject({
      view: 'history',
      selectedVersionRef: assetVersionRef,
    });

    act(() =>
      harness.container.querySelector<HTMLButtonElement>('[data-testid="evolution-use-source-rollback"]')?.click(),
    );
    expect(useEvolutionReading.getState().programs[programId]).toMatchObject({
      view: 'judgment',
      selectedVersionRef: assetVersionRef,
    });
  });

  it('does not claim application when the receipt is unconfirmed', () => {
    harness.render(
      streamReply({
        origin: 'callback',
        extra: { evolutionUseSourceV1: { ...source, use: 'unconfirmed' } },
      }),
    );

    expect(harness.container.textContent).toContain('沿用情况待确认');
    expect(harness.container.textContent).not.toContain('已沿用上次确认的规则');
    expect(useEvolutionReading.getState().programs[programId] ?? DEFAULT_READING).toEqual(DEFAULT_READING);
  });
});
