import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginManagerContent } from '../plugin-manager/PluginManagerContent';
import {
  PLUGIN_MANAGER_DESIGN_FIXTURES,
  type PluginManagerDesignFixture,
} from '../plugin-manager/plugin-manager-fixtures';

const base = PLUGIN_MANAGER_DESIGN_FIXTURES[0];
const list = {
  key: 'names',
  label: 'Names',
  kind: 'list' as const,
  required: false,
  sensitive: false,
  currentValue: '["one","two"]',
};
const secret = {
  key: 'GITHUB_TOKEN',
  label: 'Personal Access Token',
  kind: 'secret' as const,
  required: false,
  sensitive: true,
  currentValue: '••••••',
};

describe('Plugin Manager v2 configuration', () => {
  let container: HTMLDivElement;
  let root: Root;
  const save = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    save.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  function render(
    fields = [list, secret] as NonNullable<PluginManagerDesignFixture['configFields']>,
    presentation: 'v1' | 'v2' = 'v2',
    id = 'github',
  ) {
    act(() =>
      root.render(
        <PluginManagerContent
          presentation={presentation}
          fixtures={[{ ...base, id, testable: false, configFields: fields }]}
          onConfigure={save}
        />,
      ),
    );
  }
  function click(text: string) {
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === text || b.getAttribute('aria-label') === text,
    );
    expect(button, text).toBeTruthy();
    act(() => button?.click());
  }
  function type(label: string, value: string) {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    expect(input, label).toBeTruthy();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  it('uses concise headings and translates known labels only in v2', () => {
    render();
    const headings = [...container.querySelectorAll('h4')].map((x) => x.textContent);
    expect(headings).toEqual(['插件标识', '简介', '配置', '能力']);
    expect(container.querySelector('label[for="plugin-manager-github-GITHUB_TOKEN"]')?.textContent).toContain(
      '个人访问令牌',
    );
    expect(container.textContent).toContain('Names');
  });
  it('edits/removes/adds tags and saves a string array without resending a masked secret', () => {
    render();
    type('Names 第 1 项', 'comma,quote"');
    click('移除 Names 第 2 项');
    click('添加 Names');
    type('Names 第 2 项', '中文');
    click('保存配置');
    expect(save).toHaveBeenCalledWith('github', [{ key: 'names', value: '["comma,quote\\"","中文"]' }]);
  });
  it('persists removing every tag as [] rather than clearing to a default', () => {
    render();
    click('移除 Names 第 2 项');
    click('移除 Names 第 1 项');
    click('保存配置');
    expect(save).toHaveBeenCalledWith('github', [{ key: 'names', value: '[]' }]);
  });
  it('shows declared defaults without submitting them until edited', () => {
    render([{ ...list, currentValue: null, default: ['default'] }]);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Names 第 1 项"]')?.value).toBe('default');
    click('保存配置');
    expect(save).not.toHaveBeenCalled();
    type('Names 第 1 项', 'new');
    click('保存配置');
    expect(save).toHaveBeenCalledWith('github', [{ key: 'names', value: '["new"]' }]);
  });
  it('keeps malformed stored values visible rather than coercing them to an empty array', () => {
    render([{ ...list, currentValue: '[1]' }]);
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('[1]');
    expect(container.textContent).toContain('不是字符串数组');
    expect(save).not.toHaveBeenCalled();
  });
  it('keeps hidden and sensitive fields out of the tag editor', () => {
    render([
      { ...list, hidden: true },
      { ...list, key: 'tokens', sensitive: true, currentValue: '••••••' },
    ]);
    expect(container.querySelector('[data-string-list-editor]')).toBeNull();
    expect(container.querySelector('textarea')?.textContent).not.toContain('••••••');
  });
  it('preserves the real GitHub comma-separated schema while showing Chinese tags', () => {
    render([
      {
        ...list,
        key: 'GITHUB_SETUP_NOISE_BOT_LOGINS',
        kind: 'string',
        label: 'Noise Bot Login List',
        currentValue: 'one[bot],two[bot]',
      },
    ]);
    type('要忽略的机器人账号 第 1 项', 'new[bot]');
    click('保存配置');
    expect(save).toHaveBeenCalledWith('github', [{ key: 'GITHUB_SETUP_NOISE_BOT_LOGINS', value: 'new[bot],two[bot]' }]);
  });
  it('does not reinterpret another plugin field with the same key or label', () => {
    render(
      [
        {
          ...list,
          key: 'GITHUB_SETUP_NOISE_BOT_LOGINS',
          kind: 'string',
          label: 'Noise Bot Login List',
          currentValue: 'literal',
        },
      ],
      'v2',
      'other',
    );
    expect(container.querySelector('[data-string-list-editor]')).toBeNull();
    expect(container.textContent).toContain('Noise Bot Login List');
  });
  it('keeps v1 headings and raw JSON input unchanged', () => {
    render(undefined, 'v1');
    expect([...container.querySelectorAll('h4')].map((x) => x.textContent)).toEqual([
      '插件标识',
      '插件简介',
      '插件配置',
      '能力说明',
    ]);
    expect(container.querySelector('[data-string-list-editor]')).toBeNull();
    expect(container.textContent).toContain('Personal Access Token');
  });
  it('focuses a new tag and returns focus to Add after removing the last tag', () => {
    render([{ ...list, currentValue: '[]' }]);
    click('添加 Names');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Names 第 1 项');
    click('移除 Names 第 1 项');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('添加 Names');
  });
  it('adds to an empty GitHub string and serializes comma paste as distinct tags', () => {
    render([{ ...list, key: 'GITHUB_SETUP_NOISE_BOT_LOGINS', kind: 'string', currentValue: null }]);
    click('添加 要忽略的机器人账号');
    type('要忽略的机器人账号 第 1 项', 'a,b');
    expect(container.querySelectorAll('[data-tag-index]')).toHaveLength(2);
    click('保存配置');
    expect(save).toHaveBeenCalledWith('github', [{ key: 'GITHUB_SETUP_NOISE_BOT_LOGINS', value: 'a,b' }]);
  });
  it('rejects edited invalid JSON without replacing or submitting it', () => {
    render([{ ...list, currentValue: '[1]' }]);
    const input = container.querySelector('textarea');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, 'broken');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click('保存配置');
    expect(save).not.toHaveBeenCalled();
    expect(input?.value).toBe('broken');
    expect(document.activeElement).toBe(input);
  });
});
