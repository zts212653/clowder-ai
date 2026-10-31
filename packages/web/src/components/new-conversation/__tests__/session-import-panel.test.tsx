import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionImportPanel } from '../SessionImportPanel';
import type { NewConversationAdmission } from '../useNewConversationAdmission';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../composer-routing-presentation', () => ({
  composerCatName: (id: string, lookup: (id: string) => { displayName?: string } | undefined, fallback: string) =>
    lookup(id)?.displayName ?? fallback,
  buildComposerRecipientIdentities: () =>
    new Map([
      ['codex', { label: 'Sol' }],
      ['claude', { label: 'Sonnet' }],
    ]),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: api }));
vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (c: { displayName: string }) => c.displayName,
  useCatData: () => ({
    cats: [
      { id: 'codex', displayName: 'Sol', clientId: 'openai', cli: { command: 'codex' } },
      { id: 'claude', displayName: 'Sonnet', clientId: 'anthropic', cli: { command: 'claude' } },
      { id: 'gpt-pro', displayName: 'Pro Cloud', clientId: 'openai' },
      { id: 'oc', displayName: 'OpenCode cat', clientId: 'opencode', cli: { command: 'opencode' } },
      { id: 'kimi', displayName: 'Kimi', clientId: 'kimi', cli: { command: 'kimi' } },
    ],
  }),
}));
let root: Root;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function fixture() {
  return {
    ready: true,
    intent: { preferredCats: [], creationStarted: false },
    importSession: vi.fn(async () => {}),
    updateTitle: vi.fn(),
    updatePinned: vi.fn(),
  } as unknown as NewConversationAdmission;
}
async function render(admission: NewConversationAdmission, onNavigate = vi.fn()) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<SessionImportPanel admission={admission} onNavigate={onNavigate} />));
}
function button(name: string) {
  const found = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === name);
  if (!found) throw new Error(`button not found: ${name}`);
  return found;
}
async function click(name: string) {
  await act(async () => {
    const radio = document.querySelector<HTMLInputElement>(`input[type="radio"][aria-label="${name}"]`);
    if (radio) radio.click();
    else button(name).click();
  });
}
async function enterId(value: string) {
  if (!document.querySelector('input[aria-label="会话 ID"]')) await click('找不到？粘贴会话 ID');
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="会话 ID"]');
    if (!input) throw new Error('ID input missing');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
it('keeps the real viewport import panel open across stationary outside history scrolls', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(24, 600, 40, 32));
  api.mockResolvedValue({ ok: true, json: async () => ({ sessions: [] }) });
  const admission = fixture();
  await render(admission);
  await click('接上本机已有的会话');
  const history = document.createElement('div');
  document.body.append(history);
  await act(async () => history.dispatchEvent(new Event('scroll')));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(admission.importSession).not.toHaveBeenCalled();
});
it('shows a locked session in place with a check-again action, and never starts admission', async () => {
  const admission = fixture();
  api.mockResolvedValue({ ok: false, json: async () => ({ code: 'SESSION_ACTIVE_WRITER' }) });
  await render(admission);
  await click('接上本机已有的会话');
  expect(document.querySelector('select')?.textContent).not.toContain('Other');
  await enterId('019aaaaa-1111-7111-8111-111111111111');
  await click('核对会话');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    '这个会话正在 Codex 里运行，先在那边关掉再接。',
  );
  expect(button('再看一次').disabled).toBe(false);
  expect(button('接上并打开').disabled).toBe(true);
  expect(admission.importSession).not.toHaveBeenCalled();
});

it('offers OpenCode members and its native IDs, while unsupported native identity contracts stay absent', async () => {
  api.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url.includes('?')
        ? {
            sessions: [
              {
                sessionId: 'ses_original',
                firstPrompt: '',
                projectPath: '/work/long-project',
                lastActivityAt: 1,
                turnCount: null,
                alreadyBound: false,
              },
            ],
          }
        : {
            session: {
              sessionId: 'ses_original',
              firstPrompt: '',
              projectPath: '/work/long-project',
              lastActivityAt: 1,
            },
          },
  }));
  const admission = fixture();
  await render(admission);
  await click('接上本机已有的会话');
  const tool = document.querySelector<HTMLSelectElement>('select[aria-label="会话来自哪个工具"]')!;
  expect(Array.from(tool.options).map((o) => o.value)).toEqual(['anthropic', 'openai', 'opencode']);
  await act(async () => {
    tool.value = 'opencode';
    tool.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(document.querySelector('select[aria-label="交给哪只猫"]')?.textContent).toContain('OpenCode cat');
  expect(document.querySelector('select[aria-label="交给哪只猫"]')?.textContent).not.toContain('Kimi');
  expect(document.querySelector('input[type="radio"]')?.getAttribute('aria-label')).toBe('没有可显示的第一句');
  await click('没有可显示的第一句');
  expect(api).toHaveBeenCalledWith('/api/local-sessions/oc/ses_original');
  await click('接上并打开');
  expect(admission.importSession).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'ses_original', catId: 'oc' }),
  );
});

it('explains a pasted OpenCode child session and does not begin conversation admission', async () => {
  api.mockResolvedValue({ ok: false, json: async () => ({ code: 'SESSION_NOT_TOP_LEVEL' }) });
  const admission = fixture();
  await render(admission);
  await click('接上本机已有的会话');
  const tool = document.querySelector<HTMLSelectElement>('select[aria-label="会话来自哪个工具"]')!;
  await act(async () => {
    tool.value = 'opencode';
    tool.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await enterId('ses_child');
  await click('核对会话');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('这是子代理派生的会话，请选择原来的主会话。');
  expect(button('接上并打开').disabled).toBe(true);
  expect(admission.importSession).not.toHaveBeenCalled();
});

it('uses the accessible bound conversation name when no human first line exists', async () => {
  api.mockResolvedValue({
    ok: true,
    json: async () => ({
      limited: true,
      sessions: [
        {
          sessionId: 'known',
          firstPrompt: '',
          recentPrompt: 'runtime wrapper must not become a label',
          projectPath: '/work/project',
          lastActivityAt: 1,
          turnCount: null,
          alreadyBound: true,
          boundThread: { id: 'bound', title: '用户确认的名字' },
        },
        {
          sessionId: 'hidden',
          firstPrompt: '',
          recentPrompt: 'do not use the latest prompt as the first',
          projectPath: '/work/project',
          lastActivityAt: 1,
          turnCount: null,
          alreadyBound: true,
        },
        {
          sessionId: 'untitled',
          firstPrompt: '',
          projectPath: '/work/project',
          lastActivityAt: 1,
          turnCount: null,
          alreadyBound: true,
          boundThread: { id: 'own-untitled', title: null },
        },
        {
          sessionId: 'same-title',
          firstPrompt: '同名首句',
          projectPath: '/work/project',
          lastActivityAt: 1,
          turnCount: null,
          alreadyBound: true,
          boundThread: { id: 'own-same', title: '同名首句' },
        },
      ],
    }),
  });
  await render(fixture());
  await click('接上本机已有的会话');
  const labels = Array.from(document.querySelectorAll('input[type="radio"]')).map((r) => r.getAttribute('aria-label'));
  expect(labels).toEqual(['用户确认的名字', '没有可显示的第一句', '无标题对话', '同名首句']);
  expect(document.body.textContent?.match(/用户确认的名字/g)).toHaveLength(1);
  expect(document.body.textContent?.match(/同名首句/g)).toHaveLength(1);
  expect(document.body.textContent).not.toContain('已接在「没有可显示的第一句」');
  expect(document.body.textContent).not.toContain('runtime wrapper');
  expect(document.body.textContent).toContain('只显示最近的一部分');
});
it('a checked session supplies its project and first prompt to message-free admission', async () => {
  const admission = fixture();
  api.mockResolvedValue({
    ok: true,
    json: async () => ({
      session: { sessionId: 'id', projectPath: '/original', firstPrompt: 'Fix imports', lastActivityAt: 1 },
    }),
  });
  await render(admission);
  await click('接上本机已有的会话');
  await enterId('id');
  await click('核对会话');
  expect(document.querySelector<HTMLInputElement>('input[aria-label="对话名（可不填）"]')?.placeholder).toBe(
    'Fix imports',
  );
  await click('接上并打开');
  expect(admission.importSession).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'id', catId: 'codex', projectPath: '/original', firstPrompt: 'Fix imports' }),
  );
});

it('Escape dismisses a panel while the read-only session probe is pending', async () => {
  api.mockReturnValue(new Promise(() => {}));
  await render(fixture());
  await click('接上本机已有的会话');
  await enterId('id');
  await click('核对会话');
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('only offers cats using the selected native tool', async () => {
  await render(fixture());
  await click('接上本机已有的会话');
  const cats = document.querySelector('select[aria-label="交给哪只猫"]');
  expect(cats?.textContent).toContain('Sol');
  expect(cats?.textContent).not.toContain('Sonnet');
  expect(cats?.textContent).not.toContain('Pro Cloud');
});

it('owner denial explains the access boundary rather than suggesting pasted ID as a workaround', async () => {
  const admission = fixture();
  api.mockResolvedValue({ ok: false, status: 403, json: async () => ({ code: 'SESSION_OWNER_REQUIRED' }) });
  await render(admission);
  await click('接上本机已有的会话');
  expect(document.body.textContent).toContain('只有配置的所有者可以查看或接入本机会话');
  expect(document.body.textContent).not.toContain('最近会话暂时读不到，可以粘贴会话 ID');
  expect(document.body.textContent).not.toContain('找不到？粘贴会话 ID');
  expect(button('接上并打开').disabled).toBe(true);
  expect(admission.importSession).not.toHaveBeenCalled();
});

it('lazily shows recent metadata; selection still checks the lock and claimed rows only open their conversation', async () => {
  const admission = fixture();
  const navigate = vi.fn();
  const id = '019aaaaa-1111-7111-8111-111111111111';
  api.mockImplementation(async (url: string) =>
    url.endsWith('?limit=20')
      ? {
          ok: true,
          json: async () => ({
            sessions: [
              {
                sessionId: id,
                projectPath: '/original',
                firstPrompt: 'Original native task',
                lastActivityAt: 123,
                turnCount: null,
                alreadyBound: false,
              },
              {
                sessionId: '019aaaaa-1111-7111-8111-222222222222',
                projectPath: '/bound',
                firstPrompt: 'Existing native work',
                lastActivityAt: 122,
                turnCount: 3,
                alreadyBound: true,
                boundThread: { id: 'existing-thread', title: 'Existing conversation' },
              },
            ],
          }),
        }
      : { ok: false, json: async () => ({ code: 'SESSION_ACTIVE_WRITER' }) },
  );
  await render(admission, navigate);
  expect(api).not.toHaveBeenCalled();
  await click('接上本机已有的会话');
  expect(api).toHaveBeenCalledWith(
    '/api/local-sessions/codex?limit=20',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(document.body.textContent).toContain('Original native task');
  expect(document.body.textContent).not.toContain('/original');
  expect(document.querySelector('li [title*="/original"]')).not.toBeNull();
  expect(document.body.textContent).toContain('codex exec 启动的也从这里贴。');
  const rows = document.querySelectorAll('section[aria-label="最近会话"] li');
  expect(rows[0].textContent).not.toContain('轮');
  expect(rows[1].textContent).toContain('3 轮');
  expect(document.body.textContent?.match(/本机会话索引不记录轮数/g)).toHaveLength(1);
  await click('Original native task');
  expect(api).toHaveBeenCalledWith(`/api/local-sessions/codex/${id}`);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('这个会话正在 Codex 里运行');
  expect(admission.importSession).not.toHaveBeenCalled();
  await click('已接在「Existing conversation」对话里 · 打开');
  expect(navigate).toHaveBeenCalledWith('existing-thread');
});

it('tool switches discard the previous list response and keep pasted ID available when an index fails', async () => {
  let oldResponse: (value: unknown) => void = () => {};
  api.mockImplementation((url: string) =>
    url.includes('/codex?')
      ? new Promise((resolve) => {
          oldResponse = resolve;
        })
      : Promise.resolve({ ok: false, json: async () => ({}) }),
  );
  await render(fixture());
  await click('接上本机已有的会话');
  await act(async () => {
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="会话来自哪个工具"]');
    if (!select) throw new Error('tool selector missing');
    select.value = 'anthropic';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () =>
    oldResponse({ ok: true, json: async () => ({ sessions: [{ firstPrompt: 'Wrong old tool session' }] }) }),
  );
  expect(document.body.textContent).not.toContain('Wrong old tool session');
  expect(document.body.textContent).toContain('最近会话暂时读不到，可以粘贴会话 ID。');
  expect(document.body.textContent).not.toContain('用 codex exec 启动的会话');
  expect(document.querySelector('input[aria-label="会话 ID"]')).toBeNull();
  await click('找不到？粘贴会话 ID');
  expect(document.querySelector('input[aria-label="会话 ID"]')).not.toBeNull();
});

it('keeps the pasted-ID fallback collapsed until it is requested', async () => {
  api.mockResolvedValue({ ok: true, json: async () => ({ sessions: [] }) });
  await render(fixture());
  await click('接上本机已有的会话');
  expect(document.querySelector('input[aria-label="会话 ID"]')).toBeNull();
  await click('找不到？粘贴会话 ID');
  expect(document.querySelector('input[aria-label="会话 ID"]')).not.toBeNull();
});

it('selects the entire session row and synchronizes its activity with the successful preflight', async () => {
  const id = '019aaaaa-1111-7111-8111-111111111111';
  const checkedAt = Date.now() - 3_600_000;
  api.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url.includes('?limit=20')
        ? {
            sessions: [
              {
                sessionId: id,
                firstPrompt: 'Recognize this session',
                projectPath: '/projects/recognizable',
                lastActivityAt: checkedAt - 3_600_000,
                turnCount: null,
                alreadyBound: false,
              },
            ],
          }
        : {
            session: {
              sessionId: id,
              firstPrompt: 'Recognize this session',
              projectPath: '/projects/recognizable',
              lastActivityAt: checkedAt,
            },
          },
  }));
  await render(fixture());
  await click('接上本机已有的会话');
  const row = document.querySelector('section[aria-label="最近会话"] li');
  if (!row) throw new Error('session row missing');
  const detail = row.querySelector('[title^="/projects/"]') ?? row.querySelector('p');
  if (!detail) throw new Error('project and time missing');
  await act(async () => (detail as HTMLElement).click());
  expect(api).toHaveBeenCalledWith(`/api/local-sessions/codex/${id}`);
  const radio = row.querySelector<HTMLInputElement>('input[type="radio"]');
  expect(radio?.checked).toBe(true);
  expect(row.textContent).toContain('recognizable');
  expect(row.textContent).not.toContain('/projects/');
  expect(row.textContent).toContain('1小时前');
  const summary = document.querySelector('output[aria-label="核对结果"]');
  expect(summary?.textContent).toContain('Sol');
  expect(summary?.textContent).not.toContain('所选的猫');
  expect(summary?.textContent).toContain('最后活动：1小时前');
});
