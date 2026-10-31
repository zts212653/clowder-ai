import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { RightStatusPanelProps } from '@/components/RightStatusPanel';
import { StatusPresentation } from '../StatusPresentation';

const state = vi.hoisted(() => ({ presentation: 'classic' }));
vi.mock('@/components/shell/shell-presentation', () => ({ useShellPresentation: () => state.presentation }));
vi.mock('@/components/RightStatusPanel', () => ({ RightStatusPanel: () => <div>original classic</div> }));
vi.mock('../WorkspaceStatusPanelV2', () => ({ WorkspaceStatusPanelV2: () => <div>approved v2</div> }));
const props: RightStatusPanelProps = {
  threadId: 'test',
  targetCats: [],
  intentMode: null,
  catStatuses: {},
  catInvocations: {},
  messageSummary: { total: 0, assistant: 0, system: 0, evidence: 0, followup: 0 },
};
it('uses the original page by default and the new page only for explicit v2', () => {
  expect(renderToStaticMarkup(<StatusPresentation {...props} />)).toBe('<div>original classic</div>');
  state.presentation = 'v2';
  expect(renderToStaticMarkup(<StatusPresentation {...props} />)).toBe('<div>approved v2</div>');
  state.presentation = 'classic';
  expect(renderToStaticMarkup(<StatusPresentation {...props} />)).toBe('<div>original classic</div>');
});
