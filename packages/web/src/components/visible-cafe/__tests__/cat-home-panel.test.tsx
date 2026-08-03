import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatHomePanel } from '@/components/visible-cafe/cat-home/CatHomePanel';
import type { CatData } from '@/hooks/useCatData';

const apiFetchMock = vi.fn();

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const cat = {
  id: 'fable-5',
  displayName: '宪宪',
  nickname: '宪宪',
  avatar: '/cats/fable.png',
  color: { primary: '#8b5cf6', secondary: '#7c3aed' },
  mentionPatterns: ['@宪宪'],
  clientId: 'claude',
  defaultModel: 'claude-fable-5',
  roleDescription: '',
  personality: '',
} satisfies CatData;

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function clickButton(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`button containing ${label} was not found`);
  act(() => button.click());
}

const diaryResponses = new Map<string, unknown>([
  [
    '/api/auto-dream/cats/fable-5/life-settings',
    {
      catId: 'fable-5',
      config: null,
      defaults: { enabled: false, rhythm: { kind: 'gentle' }, wakeTime: '22:00', timezone: 'UTC' },
    },
  ],
  [
    '/api/auto-dream/diaries?catId=fable-5&limit=20',
    {
      diaries: [
        {
          diaryId: 'dream_one',
          catId: 'fable-5',
          localDate: '2026-07-19',
          headline: '窗外那颗慢慢亮起来的星',
          summary: '我沿着一条旧线索走了一会儿，回来时多带了一点安静。',
          engagement: { opened: false, reacted: false, openCount: 0 },
        },
      ],
      engagementMetrics: { publishedDiaryCount: 1, openedDiaryCount: 0, reactedDiaryCount: 0 },
    },
  ],
  [
    '/api/auto-dream/diaries/dream_one',
    {
      diary: {
        diaryId: 'dream_one',
        catId: 'fable-5',
        localDate: '2026-07-19',
        headline: '窗外那颗慢慢亮起来的星',
        summary: '我沿着一条旧线索走了一会儿，回来时多带了一点安静。',
        bodyMarkdown: '这是点开以后才读到的完整正文。',
        engagement: { opened: false, reacted: false, openCount: 0 },
      },
      historicalNotice: '这是某天的现场记录未清洗，不代表今天仍成立。',
    },
  ],
]);

async function handleDiaryFetch(path: string, init?: RequestInit): Promise<Response> {
  const fixed = diaryResponses.get(path);
  if (fixed) return jsonResponse(fixed);
  if (path === '/api/auto-dream/diaries/dream_one/engagement') {
    const payload = JSON.parse(String(init?.body));
    return jsonResponse({
      created: true,
      state: { opened: true, reacted: payload.kind === 'reaction' ? payload.active : false, openCount: 1 },
    });
  }
  throw new Error(`Unexpected request: ${path}`);
}

describe('F255 cat home panel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    apiFetchMock.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps diary cards folded, records an explicit open, then sends a light reaction', async () => {
    apiFetchMock.mockImplementation(handleDiaryFetch);

    await act(async () => {
      root.render(<CatHomePanel cat={cat} availableCats={[cat]} onSelectCat={() => {}} onClose={() => {}} />);
    });
    await flush();

    expect(container.textContent).toContain('宪宪的房间');
    expect(container.textContent).toContain('窗外那颗慢慢亮起来的星');
    expect(container.textContent).toContain('我沿着一条旧线索走了一会儿');
    expect(container.textContent).not.toContain('这页我喜欢');

    clickButton(container, '读全文');
    await flush();
    expect(container.textContent).toContain('这是点开以后才读到的完整正文。');
    expect(container.textContent).toContain('这页我喜欢');
    const openCall = apiFetchMock.mock.calls.find(
      ([path, init]) =>
        path === '/api/auto-dream/diaries/dream_one/engagement' && JSON.parse(String(init.body)).kind === 'open',
    );
    expect(openCall).toBeTruthy();
    expect(JSON.parse(String(openCall?.[1].body))).not.toHaveProperty('ownerUserId');

    clickButton(container, '这页我喜欢');
    await flush();
    expect(container.textContent).toContain('已经告诉宪宪');
    const reactionCall = apiFetchMock.mock.calls.find(
      ([path, init]) =>
        path === '/api/auto-dream/diaries/dream_one/engagement' && JSON.parse(String(init.body)).kind === 'reaction',
    );
    expect(JSON.parse(String(reactionCall?.[1].body))).toMatchObject({ kind: 'reaction', active: true });
  });

  it('previews settings before confirmation and never exposes scheduler identifiers', async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/auto-dream/cats/fable-5/life-settings') {
        return jsonResponse({
          catId: 'fable-5',
          config: null,
          defaults: { enabled: false, rhythm: { kind: 'gentle' }, wakeTime: '22:00', timezone: 'UTC' },
        });
      }
      if (path === '/api/auto-dream/diaries?catId=fable-5&limit=20') {
        return jsonResponse({ diaries: [], engagementMetrics: null });
      }
      if (path === '/api/auto-dream/cats/fable-5/life-settings/preview') {
        return jsonResponse({
          previewId: 'lifepreview_one',
          catId: 'fable-5',
          settings: JSON.parse(String(init?.body)).settings,
          nextWakeAt: 1_800_000_000_000,
          weeklyWakeCount: 3,
          costBand: 'low',
          costNotice: '每周约 3 次唤醒；每次都可能调用模型，请按猫粮预算调整。',
          expiresAt: 1_800_000_900_000,
        });
      }
      if (path === '/api/auto-dream/life-settings/decision') {
        return jsonResponse({
          status: 'confirmed',
          config: {
            catId: 'fable-5',
            enabled: true,
            rhythm: { kind: 'gentle' },
            wakeTime: '22:00',
            timezone: 'America/Los_Angeles',
            nextWakeAt: 1_800_000_000_000,
            weeklyWakeCount: 3,
            costBand: 'low',
            costNotice: '每周约 3 次唤醒；每次都可能调用模型，请按猫粮预算调整。',
            projectionStatus: 'ready',
            revision: 1,
          },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await act(async () => {
      root.render(<CatHomePanel cat={cat} availableCats={[cat]} onSelectCat={() => {}} onClose={() => {}} />);
    });
    await flush();
    clickButton(container, '生活与作息');

    const enabled = container.querySelector<HTMLInputElement>('input[name="enabled"]');
    if (!enabled) throw new Error('enabled input was not found');
    act(() => enabled.click());
    clickButton(container, '预览这份生活');
    await flush();

    expect(container.textContent).toContain('每周约 3 次唤醒');
    expect(apiFetchMock.mock.calls.some(([path]) => path === '/api/auto-dream/life-settings/decision')).toBe(false);
    clickButton(container, '确认这个作息');
    await flush();

    expect(apiFetchMock.mock.calls.some(([path]) => path === '/api/auto-dream/life-settings/decision')).toBe(true);
    expect(container.textContent).toContain('这份生活已经安顿好了');
    expect(container.textContent).not.toMatch(/cron|task[_ -]?id|thread[_ -]?id/i);
  });

  it('shows a failed projection as disconnected instead of active', async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auto-dream/cats/fable-5/life-settings') {
        return jsonResponse({
          catId: 'fable-5',
          config: {
            catId: 'fable-5',
            enabled: true,
            rhythm: { kind: 'gentle' },
            wakeTime: '22:00',
            timezone: 'America/Los_Angeles',
            nextWakeAt: 1_800_000_000_000,
            weeklyWakeCount: 3,
            costBand: 'low',
            costNotice: '每周约 3 次唤醒。',
            projectionStatus: 'error',
            projectionError: 'present-loop template is unavailable',
            revision: 1,
          },
          defaults: { enabled: false, rhythm: { kind: 'gentle' }, wakeTime: '22:00', timezone: 'UTC' },
        });
      }
      return jsonResponse({ diaries: [], engagementMetrics: null });
    });

    await act(async () => {
      root.render(<CatHomePanel cat={cat} availableCats={[cat]} onSelectCat={() => {}} onClose={() => {}} />);
    });
    await flush();
    clickButton(container, '生活与作息');

    expect(container.textContent).toContain('私人时间暂时没有接上');
    expect(container.textContent).not.toContain('私人时间已开启');
    expect(container.textContent).not.toContain('下次预计：');
  });

  it('shows a retryable error when life settings cannot be loaded', async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auto-dream/cats/fable-5/life-settings') {
        return jsonResponse({ error: 'unavailable' }, 503);
      }
      return jsonResponse({ diaries: [], engagementMetrics: null });
    });

    await act(async () => {
      root.render(<CatHomePanel cat={cat} availableCats={[cat]} onSelectCat={() => {}} onClose={() => {}} />);
    });
    await flush();
    clickButton(container, '生活与作息');

    expect(container.textContent).toContain('生活设置没有取回来 (503)');
    expect(container.textContent).toContain('再试一次');
    expect(container.textContent).not.toContain('正在看看');
  });

  it('closes the room with Escape', async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auto-dream/cats/fable-5/life-settings') {
        return jsonResponse({
          catId: 'fable-5',
          config: null,
          defaults: { enabled: false, rhythm: { kind: 'gentle' }, wakeTime: '22:00', timezone: 'UTC' },
        });
      }
      return jsonResponse({ diaries: [], engagementMetrics: null });
    });
    const onClose = vi.fn();
    await act(async () => {
      root.render(<CatHomePanel cat={cat} availableCats={[cat]} onSelectCat={() => {}} onClose={onClose} />);
    });
    await flush();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
