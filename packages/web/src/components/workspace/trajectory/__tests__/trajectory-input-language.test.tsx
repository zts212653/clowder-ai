import type { RequestGenerationProjectionV1, RequestGenerationTerminalEvent } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { RequestGenerationSection } from '../request-generation-card';

const mocks = vi.hoisted(() => ({ shell: 'v2' }));
vi.mock('@/components/shell/shell-presentation', () => ({ useShellPresentation: () => mocks.shell }));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.shell = 'v2';
  writeShellLanguage('en');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});
function projection(outcome: RequestGenerationTerminalEvent['outcome']): RequestGenerationProjectionV1 {
  const requestGenerationId = '00000000-0000-4000-8000-000000000001';
  return {
    envelope: {
      v: 1,
      invocationId: 'inv-language',
      sessionId: 'session-language',
      generationOrdinal: 1,
      requestGenerationId,
      promptGenerationId: `hmac-sha256:${'b'.repeat(64)}`,
      assembledAt: 1000,
      continuity: { capability: 'unknown', mode: 'cold', contextEpoch: 3, compactionRefs: ['first', 'second'] },
      channels: [
        {
          channel: 'message',
          accuracy: 'exact',
          sourceRefs: [],
          state: 'available',
          body: '原文不能被翻译',
          byteLength: 21,
        },
      ],
      presentations: [],
      runtime: {
        requested: { provider: 'openai', carrier: 'app_server', model: 'native-model' },
        providerNativeVisibility: 'unknown',
      },
      tools: { finalSurface: 'unknown' },
      retryBoundary: { attempt: 1 },
    },
    terminal: {
      type: 'request_generation_terminal',
      requestGenerationId,
      generationOrdinal: 1,
      terminalAt: 2000,
      outcome,
    },
  };
}
const outcomes = [
  ['accepted', 'Accepted', '已接纳'],
  ['replaced', 'Replaced', '已替换'],
  ['rejected', 'Rejected', '已拒绝'],
  ['error', 'Failed', '失败'],
  ['cancelled', 'Cancelled', '已取消'],
  ['unknown', 'Unknown', '未知'],
] as const;
it.each(
  outcomes,
)('localizes terminal %s while keeping provider/model/body and ordinal evidence', async (outcome, english, chinese) => {
  const generation = projection(outcome);
  await act(async () =>
    root.render(
      <RequestGenerationSection
        generations={[generation]}
        gaps={[{ kind: 'evidence_gap', fromOrdinal: 2, toOrdinal: 4, state: 'unknown', reason: 'ordinal_gap' }]}
        loading={false}
        error={false}
        revealing={false}
        onReveal={() => {}}
      />,
    ),
  );
  const badge = container.querySelector('[data-generation-ordinal] > div > span');
  expect(badge?.textContent).toBe(english);
  expect(container.textContent).toContain('Compactions: 2 · Input materials: 0 admitted / 0 omitted');
  expect(container.textContent).toContain('Submission record gap #2–4');
  expect(container.textContent).toContain('native-model');
  expect(container.querySelector('pre')?.textContent).toBe('原文不能被翻译');
  await act(async () => writeShellLanguage('zh'));
  expect(badge?.textContent).toBe(chinese);
  expect(container.textContent).toContain('第 2–4 次提交记录缺失');
  expect(generation.terminal?.outcome).toBe(outcome);
  expect(generation.envelope.continuity.contextEpoch).toBe(3);
  expect(container.querySelector('pre')?.textContent).toBe('原文不能被翻译');
});
