import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FirstRunQuestWizard } from '../../FirstRunQuestWizard';
import { recommendNativePartners } from '../native-onboarding';
import { useNativeOnboarding } from '../useNativeOnboarding';

vi.mock('../useNativeOnboarding', () => ({ useNativeOnboarding: vi.fn() }));
vi.mock('../../settings/members/MemberRuntimeFields', () => ({ MemberRuntimeFields: () => null }));
let root: Root, container: HTMLDivElement;
let setup: ReturnType<typeof useNativeOnboarding>;
const runtimes = [
  { id: 'codex', label: 'Codex', clientId: 'openai' as const, installed: false, models: [] },
  { id: 'claude', label: 'Claude Code', clientId: 'anthropic' as const, installed: false, models: [] },
  { id: 'dsh', label: 'DSH', clientId: 'acp' as const, installed: false, models: [] },
];
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  setup = {
    draft: {
      version: 2,
      journeyId: 'boundary',
      partners: recommendNativePartners(runtimes, [], [], 'boundary'),
      goal: '小目标',
      lead: '',
      created: {},
    },
    loading: false,
    error: '',
    errorStage: null,
    busy: '',
    patch: vi.fn(),
    patchPartner: vi.fn(),
    start: vi.fn(),
    reload: vi.fn(),
  } as ReturnType<typeof useNativeOnboarding>;
  vi.mocked(useNativeOnboarding).mockImplementation(() => setup);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});
const render = () => act(() => root.render(<FirstRunQuestWizard open onClose={vi.fn()} onCreated={vi.fn()} />));
const next = () => document.querySelector<HTMLButtonElement>('button[aria-label^="下一步"]')!;

it('shows actionable installation help without claiming unavailable tools are selectable', () => {
  render();
  expect(document.body.textContent).toContain('还没有找到可用工具');
  expect(document.querySelectorAll('input[type="checkbox"]:disabled')).toHaveLength(3);
  expect(next().disabled).toBe(true);
  expect(document.querySelector('a[href="https://github.com/openai/codex"]')).not.toBeNull();
  expect(document.body.textContent).not.toContain('选择至少一位伙伴');
});
it('distinguishes a detection failure from zero installed clients and allows retry', () => {
  setup = { ...setup, error: '服务暂时不可用', errorStage: 'discovery' } as typeof setup;
  render();
  expect(document.body.textContent).toContain('检测未完成');
  expect(document.body.textContent).not.toContain('还没有找到可用工具');
  expect(next().disabled).toBe(true);
});
it('allows one available partner, while making unselected versus unavailable states distinct', () => {
  setup.draft!.partners[0].runtime.installed = true;
  setup.draft!.partners[0].selected = true;
  render();
  expect(next().disabled).toBe(false);
  act(() => next().click());
  expect(document.body.textContent).toContain('由 Codex 伙伴 完成');
  expect(document.body.textContent).not.toContain('谁先提出方案');
});
it('shows the actual collaboration order before the user submits a multiple-partner goal', () => {
  for (const partner of setup.draft!.partners.slice(0, 2)) {
    partner.runtime.installed = true;
    partner.selected = true;
  }
  render();
  act(() => next().click());
  expect(document.body.textContent).toContain('谁先提出方案');
  expect(document.body.textContent).toContain('提出方案');
  expect(document.body.textContent).toContain('检查并汇总');
  expect(document.body.textContent).not.toContain('其他伙伴也可以');
});
