import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/useConfirm', async (importOriginal) => importOriginal());

import { apiFetch } from '@/utils/api-client';
import { PluginManagerContent } from '../plugin-manager/PluginManagerContent';
import {
  PLUGIN_MANAGER_DESIGN_FIXTURES,
  type PluginManagerDesignFixture,
} from '../plugin-manager/plugin-manager-fixtures';

const fetch = vi.mocked(apiFetch);
const base = PLUGIN_MANAGER_DESIGN_FIXTURES[0];
const step = 'Log in with the GitHub CLI (`gh auth login`) on the machine running Clowder AI';
const fields: NonNullable<PluginManagerDesignFixture['configFields']> = [
  { key: 'account', kind: 'string', label: 'Account', currentValue: null, required: false, sensitive: false },
  {
    key: 'connection',
    kind: 'operation',
    label: '检查连接',
    currentValue: null,
    required: false,
    sensitive: false,
    actions: [{ id: 'check', label: '检查连接', render: 'button' }],
  },
];
describe('Plugin Manager v2 detail guidance', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    fetch.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  function render(overrides: Partial<PluginManagerDesignFixture> = {}, presentation: 'v1' | 'v2' = 'v2') {
    act(() =>
      root.render(
        <PluginManagerContent
          presentation={presentation}
          fixtures={[{ ...base, configFields: fields, steps: [step], ...overrides }]}
        />,
      ),
    );
  }
  it('translates a known setup instruction while rendering its command as code', () => {
    render();
    expect(container.textContent).toContain('在运行');
    expect(container.textContent).toContain('登录 GitHub');
    expect([...container.querySelectorAll('code')].map((x) => x.textContent)).toContain('gh auth login');
    expect(container.textContent).not.toContain('Log in with the GitHub CLI');
  });
  it('retains unknown instruction content as escaped text with inline code only', () => {
    render({ id: 'third-party', steps: ['Run `<script>bad</script>` and `tool start`; unknown instructions.'] });
    expect(container.querySelector('script')).toBeNull();
    expect([...container.querySelectorAll('code')].map((x) => x.textContent)).toEqual([
      '<script>bad</script>',
      'tool start',
    ]);
    expect(container.textContent).toContain('unknown instructions.');
  });
  it('shows Chinese capability groups and known names with original identifiers', () => {
    render({
      contributions: [
        { id: 'cicd-check', kind: 'schedule', name: 'cicd-check' },
        { id: 'webhook-events', kind: 'events', name: '事件接收' },
        { id: 'message', kind: 'messaging', name: 'Message channel' },
      ],
    });
    expect([...container.querySelectorAll('h5')].map((x) => x.textContent)).toEqual(['定时任务', '事件', '消息']);
    expect(container.textContent).toContain('检查 CI/CD 状态');
    expect([...container.querySelectorAll('code')].map((x) => x.textContent)).toContain('cicd-check');
    expect(container.textContent).toContain('Message channel');
  });
  it('puts current problem and declared operations before the introduction and renders actions once', () => {
    render({ activationFailed: true, intent: 'disabled', live: 'stopped', diagnostic: '连接被拒绝' });
    const problem = container.querySelector('[data-plugin-detail-section="attention"]');
    expect(problem?.textContent).toContain('连接被拒绝');
    expect(problem?.textContent).toContain('配置');
    const introduction = container.querySelector('[data-plugin-detail-section="introduction"]');
    expect(introduction).not.toBeNull();
    if (introduction) expect(problem?.compareDocumentPosition(introduction)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(container.querySelectorAll('[data-testid="github-action-check"]')).toHaveLength(1);
    expect(problem?.querySelector('[data-testid="github-action-check"]')).not.toBeNull();
  });
  it('passes unsaved configuration to the same declared operation without new endpoint or generic repair', async () => {
    fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, label: 'checked', render: 'status' })));
    render({ activationFailed: true });
    const input = container.querySelector<HTMLInputElement>('[data-testid="field-account"]');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'alice');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="github-action-check"]')?.click());
    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/github/actions/connection/check',
      expect.objectContaining({ body: JSON.stringify({ account: 'alice' }) }),
    );
    expect(container.textContent).not.toContain('通用修复');
  });
  it('does not turn historical diagnostics into a current problem or fabricate actions', () => {
    render({ configFields: [], diagnostic: '旧错误', live: 'running', activationFailed: false });
    expect(container.querySelector('[data-plugin-detail-section="attention"]')).toBeNull();
    expect(container.textContent).toContain('诊断记录');
    expect(container.textContent).toContain('旧错误');
  });
  it('preserves v1 labels, plain steps and operation location', () => {
    render({ activationFailed: true }, 'v1');
    expect(container.textContent).toContain(step);
    expect(container.querySelector('code')).toBeNull();
    expect(
      container.querySelector('[data-plugin-detail-section="configuration"] [data-testid="github-action-check"]'),
    ).not.toBeNull();
  });
  it('keeps the same operation node when the current problem clears', () => {
    render({ activationFailed: true });
    const action = container.querySelector('[data-testid="github-action-check"]');
    render({ activationFailed: false });
    expect(container.querySelector('[data-testid="github-action-check"]')).toBe(action);
    expect(container.querySelector('[data-plugin-detail-section="attention"]')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps declared confirmation fail-closed at its new position', async () => {
    render({
      activationFailed: true,
      configFields: [
        { ...fields[1], actions: [{ id: 'check', label: '检查连接', render: 'button', confirm: '确认重新连接？' }] },
      ],
    });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="github-action-check"]')?.click());
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not offer package operations before installation', () => {
    render({ artifact: 'quarantined', installedVersion: null });
    expect(container.querySelector('[data-plugin-detail-section="attention"]')?.textContent).toContain('安装包已隔离');
    expect(container.querySelector('[data-testid="github-action-check"]')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
