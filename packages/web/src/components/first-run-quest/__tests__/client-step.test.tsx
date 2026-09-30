import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { ClientStep } from '../ClientStep';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
const client = {
  client: 'codex',
  provider: 'openai',
  cli: 'codex',
  label: 'Codex',
  installed: true,
  hasApiKey: false,
  authenticated: false,
};
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

it('does not treat an OAuth account record as CLI authentication', async () => {
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          url.includes('available-clients')
            ? { clients: [client] }
            : { providers: [{ id: 'codex', authType: 'oauth' }] },
        ),
      ),
  );
  await act(async () => {
    root.render(<ClientStep onSelect={vi.fn()} />);
  });
  expect(container.textContent).toContain('需要登录');
  expect(container.querySelector('[data-testid="first-run-select-codex"]')).toBeNull();
});

it('keeps pending until a fresh native credential probe succeeds', async () => {
  let authenticated = false;
  const onChange = vi.fn();
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          url.includes('available-clients') ? { clients: [{ ...client, authenticated }] } : { providers: [] },
        ),
      ),
  );
  await act(async () => {
    root.render(
      <ClientStep
        savedClients={[{ ...client, authStatus: 'pending' }]}
        onClientsChange={onChange}
        onSelect={vi.fn()}
      />,
    );
  });
  expect(container.textContent).toContain('等待登录');
  authenticated = true;
  const refresh = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '重新检测');
  await act(async () => {
    refresh?.click();
  });
  expect(container.querySelector('[data-testid="first-run-select-codex"]')).not.toBeNull();
  expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ authStatus: 'ready' })]);
});

it('reports detection failures and allows retry instead of claiming no installation', async () => {
  vi.mocked(apiFetch).mockRejectedValue(new Error('offline'));
  await act(async () => {
    root.render(<ClientStep onSelect={vi.fn()} />);
  });
  expect(container.textContent).toContain('检测失败');
  expect(container.textContent).not.toContain('未检测到已安装');
});
