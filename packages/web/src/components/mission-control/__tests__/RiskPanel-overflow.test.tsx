import type { IntentCard } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RiskPanel } from '../RiskPanel';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  apiFetch.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('RiskPanel overflow recovery', () => {
  it('keeps a detected long goal recoverable after running detection', async () => {
    const goal = '包含具体范围和边界的长目标。'.repeat(40);
    const card: IntentCard = {
      id: 'intent-1',
      projectId: 'project-1',
      goal,
      actor: 'owner',
      contextTrigger: '',
      objectState: '',
      successSignal: '',
      nonGoal: '',
      sourceTag: 'Q',
      sourceDetail: '',
      decisionOwner: 'owner',
      confidence: 1,
      dependencyTags: [],
      riskSignals: ['scope_creep'],
      triage: null,
      originalText: goal,
      createdAt: 1,
      updatedAt: 1,
    };
    apiFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/detect-risks')) return Response.json({});
      if (url.endsWith('/risk-summary'))
        return Response.json({ signals: { scope_creep: 1 }, totalCards: 1, cardsWithRisks: 1 });
      if (url.endsWith('/intent-cards')) return Response.json({ cards: [card] });
      throw new Error(`Unexpected request: ${url}`);
    });
    await act(async () => root.render(<RiskPanel projectId="project-1" cards={[card]} />));
    const run = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Run Detection');
    expect(run).toBeDefined();
    await act(async () => run?.click());
    expect(apiFetch).toHaveBeenCalledWith('/api/external-projects/project-1/intent-cards/intent-1/detect-risks', {
      method: 'POST',
    });
    const blocks = [...host.querySelectorAll('[data-overflow-measure="block"]')];
    expect(blocks.map((node) => node.textContent)).toContain(goal);
  });
});
