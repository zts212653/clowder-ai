import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ImportedSessionNotice } from '../ImportedSessionNotice';

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  coordinate: undefined as undefined | { sessionId: string; catId: string },
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: fixture.api }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: unknown) => unknown) =>
    selector({ threads: [{ id: 'thread-1', sessionImport: fixture.coordinate }] }),
}));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: [] }) }));
vi.mock('../../composer-routing-presentation', () => ({ composerCatName: () => 'Sol' }));
vi.mock('../../shell/shell-language', () => ({ useShellLanguage: () => 'en' }));
vi.mock('../../shell/shell-copy', () => ({
  defineShellCopy: (copy: unknown) => copy,
  useShellCopy: (copy: { en: unknown }) => copy.en,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div');
const root = createRoot(host);
afterEach(async () => {
  await act(async () => root.render(null));
  fixture.coordinate = undefined;
  fixture.api.mockReset();
});

it('opening an ordinary conversation never requests session history for the origin card', async () => {
  await act(async () => root.render(<ImportedSessionNotice threadId="thread-1" />));
  expect(fixture.api).not.toHaveBeenCalled();
  expect(host.textContent).toBe('');
});

it('a successful import coordinate requests its bounded origin projection and displays it', async () => {
  fixture.coordinate = { sessionId: 'logical-1', catId: 'codex' };
  fixture.api.mockResolvedValue({
    ok: true,
    json: async () => ({
      importedSession: {
        catId: 'codex',
        cliSessionId: 'native-original',
        clientId: 'openai',
        lastActivityAt: Date.now() - 7_200_000,
      },
    }),
  });
  await act(async () => root.render(<ImportedSessionNotice threadId="thread-1" />));
  expect(fixture.api).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain('native-original');
  expect(host.textContent).toContain('Connected to a Codex session');
  expect(host.textContent).toContain('2 hours ago');
  expect(host.textContent).toContain('Sol continues from here');
});
