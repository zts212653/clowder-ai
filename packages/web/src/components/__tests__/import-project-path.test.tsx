import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportProjectModal } from '../mission-control/ImportProjectModal';

vi.mock('@cat-cafe/shared', () => ({ deploymentDefaults: { roadmapPath: 'docs/team/ACTIVE.md' } }));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function input(label: string): HTMLInputElement {
  const element = [...container.querySelectorAll('label')]
    .find((item) => item.textContent?.trim() === label)
    ?.querySelector('input');
  if (!element) throw new Error(`Missing input: ${label}`);
  return element;
}

function change(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('project import uses the configured roadmap default', () => {
  for (const override of [undefined, 'planning/custom.md']) {
    it(`submits ${override ?? 'the configured path'} and lets the user choose another path`, async () => {
      vi.mocked(apiFetch).mockResolvedValue({ ok: true } as Response);
      const imported = vi.fn();
      await act(async () => root.render(<ImportProjectModal onClose={vi.fn()} onImported={imported} />));
      const pathInput = input('Backlog 路径');
      expect(pathInput.value).toBe('docs/team/ACTIVE.md');
      await act(async () => {
        change(input('项目名称 *'), 'Fixture project');
        change(input('项目路径 *'), '/tmp/fixture-project');
        if (override) change(pathInput, override);
      });
      const button = [...container.querySelectorAll('button')].find((item) => item.textContent === '导入');
      if (!button) throw new Error('Missing import button');
      await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(imported).toHaveBeenCalledOnce();
      const options = vi.mocked(apiFetch).mock.calls[0]?.[1];
      expect(JSON.parse(options?.body as string).backlogPath).toBe(override ?? 'docs/team/ACTIVE.md');
    });
  }
});
