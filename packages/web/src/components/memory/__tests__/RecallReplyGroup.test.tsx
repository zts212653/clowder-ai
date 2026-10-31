import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecallReplyGroup } from '../RecallReplyGroup';

const mocks = vi.hoisted(() => ({ getCatById: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: mocks.getCatById }) }));
vi.mock('../../CatAvatar', () => ({
  CatAvatar: ({ catId }: { catId: string }) => <span data-avatar-cat={catId}>猫头像</span>,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
describe('F321 reply calendar labels', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    mocks.getCatById.mockReturnValue(undefined);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 2, 12));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
  it('preserves delivery expansion for existing callers that omit the global-page flag', async () => {
    await act(async () =>
      root.render(
        <RecallReplyGroup
          group={{
            id: 'existing-workspace',
            events: [
              {
                id: 'delivery',
                source: 'push',
                timestamp: 1,
                query: '',
                cueStatus: 'applied',
                results: [{ title: '已批准品味', sourceType: 'taste' }],
              },
            ],
          }}
          initiallyExpanded={true}
          onLocate={() => {}}
        />,
      ),
    );
    const button = container.querySelector('[data-recall-event-id="delivery"] button') as HTMLButtonElement;
    expect(button).not.toBeNull();
    await act(async () => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent?.split('已批准品味')).toHaveLength(3);
  });
  it.each([
    [new Date(2026, 9, 2, 7, 43), '07:43 的回复'],
    [new Date(2026, 9, 1, 21, 52), '昨天 21:52 的回复'],
    [new Date(2026, 8, 30, 4, 48), '9月30日 04:48 的回复'],
  ])('shows the actual day (%s)', async (date, label) => {
    await act(async () =>
      root.render(
        <RecallReplyGroup
          group={{ id: 'group', timestamp: date.getTime(), events: [] }}
          initiallyExpanded={false}
          onLocate={() => {}}
        />,
      ),
    );
    expect(container.textContent).toContain(label);
  });
  it('uses an explicit calendar label for the global page while existing callers keep relative labels', async () => {
    await act(async () =>
      root.render(
        <RecallReplyGroup
          group={{ id: 'global', timestamp: new Date(2026, 9, 2, 7, 43).getTime(), events: [] }}
          replyTimeLabel="10 月 2 日 07:43 的回复"
          initiallyExpanded={false}
          onLocate={() => {}}
        />,
      ),
    );
    expect(container.textContent).toContain('10 月 2 日 07:43 的回复');
  });
  it('does not render a raw cat identifier when roster metadata is unavailable', async () => {
    await act(async () =>
      root.render(
        <RecallReplyGroup
          group={{ id: 'group', catId: 'cat_internal_coordinate', events: [] }}
          initiallyExpanded={false}
          onLocate={() => {}}
        />,
      ),
    );
    expect(container.textContent).toContain('猫的名字暂时读不到');
    expect(container.querySelector('[data-avatar-cat]')).toBeNull();
    expect(container.innerHTML).not.toContain('cat_internal_coordinate');
  });
  it('retains the known cat nickname and avatar', async () => {
    mocks.getCatById.mockReturnValue({ nickname: '宪宪', displayName: '宪宪' });
    await act(async () =>
      root.render(
        <RecallReplyGroup
          group={{ id: 'group', catId: 'sonnet', events: [] }}
          initiallyExpanded={false}
          onLocate={() => {}}
        />,
      ),
    );
    expect(container.textContent).toContain('宪宪');
    expect(container.querySelector('[data-avatar-cat]')?.getAttribute('data-avatar-cat')).toBe('sonnet');
  });
});
