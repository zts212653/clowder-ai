import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirstRunQuestWizard } from '../FirstRunQuestWizard';
import { recommendNativePartners } from '../first-run-quest/native-onboarding';
import { useNativeOnboarding } from '../first-run-quest/useNativeOnboarding';

vi.mock('../first-run-quest/useNativeOnboarding', () => ({ useNativeOnboarding: vi.fn() }));
vi.mock('../settings/members/MemberRuntimeFields', () => ({ MemberRuntimeFields: () => null }));

const runtimes = [{ id: 'codex', label: 'Codex', clientId: 'openai' as const, installed: true, models: [] }];

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
const onCreated = vi.fn();

function makeSetup(goal = '小目标') {
  const partners = recommendNativePartners(runtimes, [], [], 'wizard-shell');
  return {
    draft: { version: 2 as const, journeyId: 'wizard-shell', partners, goal, lead: '', created: {} },
    loading: false,
    error: '',
    errorStage: null,
    busy: '',
    patch: vi.fn(),
    patchPartner: vi.fn(),
    start: vi.fn(),
    reload: vi.fn(),
  } as unknown as ReturnType<typeof useNativeOnboarding>;
}

function install(goal = '小目标') {
  const setup = makeSetup(goal);
  vi.mocked(useNativeOnboarding).mockReturnValue(setup);
  return setup;
}

const render = () => act(() => root.render(<FirstRunQuestWizard open onClose={onClose} onCreated={onCreated} />));
const button = (selector: string) => document.querySelector<HTMLButtonElement>(selector);
const nextButton = () => button('button[aria-label^="下一步"]');
const saveButton = () => button('button[aria-label="保存伙伴，前往对话"]');

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  onClose.mockReset();
  onCreated.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

describe('FirstRunQuestWizard native two-step setup', () => {
  it('renders the native partner step instead of the removed demo copy', () => {
    install();
    render();

    // The wizard is always portalled to document.body.
    expect(document.querySelector('[role="dialog"][aria-labelledby="native-setup-title"]')).not.toBeNull();
    expect(document.body.textContent).toContain('把你的工具，变成一起做事的伙伴');
    expect(document.body.textContent).toContain('1 / 2 · 配置伙伴');
    // The legacy demo/template wizard owned this copy; it was replaced by native discovery.
    expect(document.body.textContent).not.toContain('认识你的协作团队');
    expect(document.body.textContent).not.toContain('选择团队角色');
    expect(document.body.textContent).not.toContain('开始演示');
  });

  it('advances to the goal step and saves through the setup hook', () => {
    const setup = install('小目标');
    render();

    expect(nextButton()?.disabled).toBe(false);
    act(() => nextButton()?.click());

    expect(document.body.textContent).toContain('一起完成一件小事');
    expect(document.body.textContent).toContain('2 / 2 · 第一个小目标');
    const save = saveButton();
    expect(save).not.toBeNull();
    expect(save?.disabled).toBe(false);
    act(() => save?.click());
    expect(setup.start).toHaveBeenCalledOnce();
  });

  it('keeps saving disabled until the goal is written', () => {
    const setup = install('');
    render();

    act(() => nextButton()?.click());
    const save = saveButton();
    expect(save).not.toBeNull();
    expect(save?.disabled).toBe(true);
    act(() => save?.click());
    expect(setup.start).not.toHaveBeenCalled();
  });

  it('returns to the partner step and closes without saving', () => {
    const setup = install();
    render();

    act(() => nextButton()?.click());
    const back = Array.from(document.querySelectorAll('button')).find((item) => item.textContent === '返回选择伙伴');
    expect(back).toBeDefined();
    act(() => back?.click());
    expect(document.body.textContent).toContain('1 / 2 · 配置伙伴');

    act(() => button('button[aria-label="关闭伙伴配置"]')?.click());
    expect(onClose).toHaveBeenCalledOnce();
    expect(setup.start).not.toHaveBeenCalled();
  });

  it('disables the primary and close controls while the setup is running', () => {
    const setup = install();
    setup.busy = '正在保存';
    render();

    // While busy the primary control exposes the busy label instead of the step label.
    const primary = button('button[aria-label="正在保存"]');
    expect(primary).not.toBeNull();
    expect(primary?.disabled).toBe(true);
    expect(button('button[aria-label="关闭伙伴配置"]')?.disabled).toBe(true);
    expect(nextButton()).toBeNull();
    expect(setup.start).not.toHaveBeenCalled();
  });
});
