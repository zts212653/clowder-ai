import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginManagerContent } from '../plugin-manager/PluginManagerContent';
import { PLUGIN_MANAGER_DESIGN_FIXTURES } from '../plugin-manager/plugin-manager-fixtures';

function button(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(label));
}

describe('F202 terminal Plugin Manager Design Gate', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('separates installed plugins from a bounded recommendation shelf', async () => {
    await act(async () => root.render(<PluginManagerContent fixtures={PLUGIN_MANAGER_DESIGN_FIXTURES} />));

    expect(container.querySelector('[data-testid="plugin-manager"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-plugin-id="video-analysis"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-plugin-id="feishu-meeting-intake"]')).toHaveLength(1);
    expect(container.querySelector('[data-plugin-section="installed"]')?.textContent).toContain('已安装');
    expect(container.querySelector('[data-plugin-section="recommended"]')?.textContent).toContain('推荐');
    expect(container.querySelector('[data-plugin-section="recommended"]')?.textContent).toContain('视频分析');
    expect(container.textContent).not.toContain('需处理');
  });

  it('limits the default recommendation shelf to three catalog candidates but searches all matches', async () => {
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      ...PLUGIN_MANAGER_DESIGN_FIXTURES[2],
      id: `recommended-${index + 1}`,
      displayName: `推荐插件 ${index + 1}`,
    }));
    await act(async () =>
      root.render(<PluginManagerContent fixtures={[PLUGIN_MANAGER_DESIGN_FIXTURES[0], ...candidates]} />),
    );

    expect(container.querySelectorAll('[data-plugin-section="recommended"] [data-plugin-id]')).toHaveLength(3);

    const search = container.querySelector('input[aria-label="搜索插件"]') as HTMLInputElement | null;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(search, '推荐插件');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container.querySelectorAll('[data-plugin-section="recommended"] [data-plugin-id]')).toHaveLength(5);
  });

  it('uses a filled accessible selection state without the persistent accent outline', async () => {
    await act(async () => root.render(<PluginManagerContent fixtures={PLUGIN_MANAGER_DESIGN_FIXTURES} />));

    const github = container.querySelector('[data-plugin-id="github"]');
    const video = container.querySelector('[data-plugin-id="video-analysis"]');
    expect(github?.getAttribute('aria-current')).toBe('true');
    expect((github as HTMLElement | null)?.style.backgroundColor).toBe('var(--console-active-bg)');
    expect(github?.className).not.toContain('!bg-');
    expect(github?.className).not.toContain('ring-1');
    expect(video?.getAttribute('aria-current')).toBeNull();

    await act(async () => button(container, '视频分析')?.click());

    expect(github?.getAttribute('aria-current')).toBeNull();
    expect(video?.getAttribute('aria-current')).toBe('true');
    expect((video as HTMLElement | null)?.style.backgroundColor).toBe('var(--console-active-bg)');
    expect(video?.className).not.toContain('!bg-');
    expect(video?.className).not.toContain('ring-1');
  });

  it('searches across installed and uninstalled plugins', async () => {
    await act(async () => root.render(<PluginManagerContent fixtures={PLUGIN_MANAGER_DESIGN_FIXTURES} />));
    const search = container.querySelector('input[aria-label="搜索插件"]');
    expect(search).not.toBeNull();
    expect(search?.closest('[data-mobile-panel="list"]')).not.toBeNull();

    await act(async () => {
      search?.setAttribute('value', '视频');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container.querySelectorAll('[data-plugin-id]')).toHaveLength(2);
    expect(container.textContent).toContain('视频分析');
    expect(container.textContent).toContain('本地视频生成');
  });

  it('expresses installed state only through toggle and uninstall actions', async () => {
    await act(async () => root.render(<PluginManagerContent fixtures={PLUGIN_MANAGER_DESIGN_FIXTURES} />));
    await act(async () => button(container, '飞书会议纪要')?.click());

    const row = container.querySelector('[data-plugin-id="feishu-meeting-intake"]');
    const detail = container.querySelector('[data-testid="plugin-manager-detail"]');
    expect(detail?.className).toContain('settings-resource-card');
    expect(button(detail as HTMLElement, '设置')).toBeUndefined();
    expect(row?.querySelector('button[aria-pressed]')).not.toBeNull();
    expect(row?.querySelector('button[aria-label^="卸载"]')).not.toBeNull();
    expect(detail?.querySelector('button[aria-pressed]')).toBeNull();
    expect(detail?.querySelector('button[aria-label^="卸载"]')).toBeNull();
    expect(detail?.textContent).not.toContain('已安装');
    expect(detail?.textContent).not.toContain('未安装');
    expect(detail?.textContent).toContain('事件输入');
    expect(container.textContent).not.toContain('更新');
    expect(container.textContent).not.toContain('修复');
  });

  it('does not draw a fake lifecycle toggle for read-only compatibility rows', async () => {
    const compatibility = {
      ...PLUGIN_MANAGER_DESIGN_FIXTURES[0],
      sourceAdapter: 'repository-local' as const,
      actions: {
        install: false,
        setEnabled: false,
        uninstall: false,
        blockingReasons: ['compatibility-read-only'],
      },
    };

    await act(async () => root.render(<PluginManagerContent fixtures={[compatibility]} />));

    const row = container.querySelector('[data-plugin-id="github"]');
    expect(row?.querySelector('button[aria-pressed]')).toBeNull();
    expect(row?.querySelector('button[aria-label^="卸载"]')).toBeNull();
  });

  it('keeps a blocked lifecycle toggle actionable and routes it to configuration', async () => {
    const onSetEnabled = vi.fn();
    const blocked = {
      ...PLUGIN_MANAGER_DESIGN_FIXTURES[1],
      config: 'incomplete' as const,
      intent: 'disabled' as const,
      configFields: [
        {
          kind: 'secret' as const,
          key: 'PLUGIN_TOKEN',
          label: 'Plugin token',
          required: true,
          currentValue: null,
          sensitive: true,
        },
      ],
      actions: {
        install: false,
        setEnabled: false,
        uninstall: true,
        blockingReasons: ['config-incomplete'],
      },
    };

    await act(async () => root.render(<PluginManagerContent fixtures={[blocked]} onSetEnabled={onSetEnabled} />));

    const toggle = container.querySelector('button[aria-label="启用飞书会议纪要同步"]') as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();
    expect(toggle?.disabled).toBe(false);
    expect(container.querySelector('[data-plugin-toggle-blocked-reason]')).toBeNull();

    await act(async () => toggle?.click());

    expect(onSetEnabled).not.toHaveBeenCalled();
    const configuration = container.querySelector('[data-plugin-detail-section="configuration"]');
    const requiredField = container.querySelector('[data-testid="field-PLUGIN_TOKEN"]') as HTMLInputElement | null;
    expect(document.activeElement).toBe(requiredField);
    expect(requiredField?.getAttribute('aria-invalid')).toBe('true');
    expect(requiredField?.className).toContain('border-conn-red-ring');
    expect(configuration?.className).not.toContain('focus:ring-2');
    expect(container.textContent).toContain('请填写 Plugin token');
  });

  it('uses the same required-field validation when saving an incomplete configuration', async () => {
    const onConfigure = vi.fn();
    const blocked = {
      ...PLUGIN_MANAGER_DESIGN_FIXTURES[1],
      config: 'incomplete' as const,
      configFields: [
        {
          kind: 'secret' as const,
          key: 'PLUGIN_TOKEN',
          label: 'Plugin token',
          required: true,
          currentValue: null,
          sensitive: true,
        },
      ],
    };

    await act(async () => root.render(<PluginManagerContent fixtures={[blocked]} onConfigure={onConfigure} />));

    const save = button(container, '保存配置') as HTMLButtonElement | undefined;
    expect(save?.disabled).toBe(false);
    await act(async () => save?.click());

    const requiredField = container.querySelector('[data-testid="field-PLUGIN_TOKEN"]') as HTMLInputElement | null;
    expect(onConfigure).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(requiredField);
    expect(requiredField?.getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).toContain('请填写 Plugin token');
  });

  it('serializes an untouched required boolean from the manifest without plugin-specific logic', async () => {
    const onConfigure = vi.fn();
    const blocked = {
      ...PLUGIN_MANAGER_DESIGN_FIXTURES[1],
      config: 'incomplete' as const,
      configFields: [
        {
          kind: 'boolean' as const,
          key: 'ALLOW_REMOTE',
          label: 'Allow remote access',
          required: true,
          currentValue: null,
          sensitive: false,
        },
      ],
    };

    await act(async () => root.render(<PluginManagerContent fixtures={[blocked]} onConfigure={onConfigure} />));
    await act(async () => button(container, '保存配置')?.click());

    expect(onConfigure).toHaveBeenCalledWith('feishu-meeting-intake', [{ key: 'ALLOW_REMOTE', value: 'false' }]);
  });

  it('expresses uninstalled state only through the install action', async () => {
    await act(async () => root.render(<PluginManagerContent fixtures={PLUGIN_MANAGER_DESIGN_FIXTURES} />));
    await act(async () => button(container, '视频分析')?.click());

    const row = container.querySelector('[data-plugin-id="video-analysis"]');
    const detail = container.querySelector('[data-testid="plugin-manager-detail"]');
    expect(button(row as HTMLElement, '安装')).not.toBeUndefined();
    expect(button(detail as HTMLElement, '安装')).toBeUndefined();
    expect(button(detail as HTMLElement, '设置')).toBeUndefined();
    expect(detail?.querySelector('button[aria-pressed]')).toBeNull();
    expect(detail?.querySelector('button[aria-label^="卸载"]')).toBeNull();
    expect(detail?.textContent).not.toContain('已安装');
    expect(detail?.textContent).not.toContain('未安装');
  });

  it('presents a quarantined package as removable without exposing install or enable', async () => {
    const quarantined = {
      ...PLUGIN_MANAGER_DESIGN_FIXTURES[2],
      id: 'rejected-package',
      displayName: 'Rejected package',
      artifact: 'quarantined' as const,
      installedVersion: null,
      config: 'invalid' as const,
      actions: {
        install: false,
        setEnabled: false,
        uninstall: true,
        blockingReasons: ['package-quarantined'],
      },
      diagnostic: 'Plugin package archive failed Host verification.',
    };
    await act(async () => root.render(<PluginManagerContent fixtures={[quarantined]} />));

    const row = container.querySelector('[data-plugin-id="rejected-package"]');
    expect(button(row as HTMLElement, '安装')).toBeUndefined();
    expect(row?.querySelector('button[aria-pressed]')).toBeNull();
    expect(row?.querySelector('button[aria-label="移除Rejected package"]')).not.toBeNull();
    expect(container.textContent).toContain('Plugin package archive failed Host verification.');
  });

  it('places offline install in the page toolbar, outside the list column', async () => {
    await act(async () => root.render(<PluginManagerContent fixtures={PLUGIN_MANAGER_DESIGN_FIXTURES} />));

    const toolbar = container.querySelector('[data-plugin-manager-toolbar]');
    const list = container.querySelector('[data-mobile-panel="list"]');
    expect(toolbar?.textContent).toContain('离线安装');
    expect(list?.textContent).not.toContain('离线安装');
    expect(toolbar?.className).toContain('justify-end');
  });

  it('uses manifest visuals, unclipped list cards, and localized detail descriptions', async () => {
    await act(async () => root.render(<PluginManagerContent fixtures={PLUGIN_MANAGER_DESIGN_FIXTURES} />));

    const githubRow = container.querySelector('[data-plugin-id="github"]');
    expect(githubRow?.getAttribute('data-plugin-list-row')).toBe('true');
    expect(githubRow?.className).toContain('min-h-[88px]');
    expect(githubRow?.className).not.toContain('overflow-hidden');
    expect(githubRow?.querySelector('[data-plugin-description]')?.className).toContain('line-clamp-2');
    expect(githubRow?.querySelector('[data-plugin-icon="github"]')).not.toBeNull();

    const detail = container.querySelector('[data-testid="plugin-manager-detail"]');
    expect(detail?.textContent).toContain('跟踪 PR、CI/CD、冲突检测与仓库扫描');

    await act(async () => button(container, '飞书会议纪要')?.click());
    const feishuIcon = container.querySelector(
      '[data-testid="plugin-manager-detail"] img[src="/images/connectors/feishu.png"]',
    );
    expect(feishuIcon).not.toBeNull();
    expect(feishuIcon?.className).toContain('h-full');
    expect(feishuIcon?.className).toContain('w-full');
    expect(feishuIcon?.className).toContain('object-cover');
    expect(feishuIcon?.parentElement?.className).toContain('overflow-hidden');

    await act(async () => button(container, '视频分析')?.click());
    expect(container.querySelector('[data-plugin-id="video-analysis"]')).not.toBeNull();
    const packageIcon = container.querySelector(
      '[data-testid="plugin-manager-detail"] img[src="/images/plugin-fixtures/video-analysis.svg"]',
    );
    expect(packageIcon).not.toBeNull();
    expect(packageIcon?.className).toContain('h-full');
    expect(packageIcon?.className).toContain('w-full');
    expect(packageIcon?.className).toContain('object-cover');
    expect(container.querySelector('[data-testid="plugin-manager-detail"]')?.textContent).toContain(
      '通过已配置的 Gemini 或智谱视觉模型分析远程视频。',
    );
  });

  it('preserves an actionable catalog degradation banner without hiding installed plugins', async () => {
    await act(async () =>
      root.render(<PluginManagerContent fixtures={PLUGIN_MANAGER_DESIGN_FIXTURES} catalogStatus="degraded" />),
    );

    expect(container.textContent).toContain('目录暂时不可用');
    expect(container.textContent).toContain('已安装插件仍可管理');
    expect(container.textContent).toContain('飞书会议纪要同步');
  });

  it('uses list then detail navigation on narrow screens instead of stacking both journeys', async () => {
    await act(async () => root.render(<PluginManagerContent fixtures={PLUGIN_MANAGER_DESIGN_FIXTURES} />));

    const list = container.querySelector('[data-mobile-panel="list"]');
    const detail = container.querySelector('[data-mobile-panel="detail"]');
    expect(list?.className).toContain('flex');
    expect(detail?.className).toContain('hidden');

    await act(async () => button(container, '视频分析')?.click());
    expect(list?.className).toContain('hidden');
    expect(detail?.className).toContain('flex');
    expect(button(container, '返回插件列表')).not.toBeUndefined();

    await act(async () => button(container, '返回插件列表')?.click());
    expect(list?.className).toContain('flex');
    expect(detail?.className).toContain('hidden');
  });

  it('keeps the list and detail as independent desktop scroll regions', async () => {
    await act(async () => root.render(<PluginManagerContent fixtures={PLUGIN_MANAGER_DESIGN_FIXTURES} />));

    expect([...container.querySelectorAll('p')].some((element) => element.textContent?.trim() === '插件列表')).toBe(
      false,
    );
    const list = container.querySelector('[data-plugin-scroll-region="list"]');
    const detail = container.querySelector('[data-plugin-scroll-region="detail"]');
    expect(list).not.toBeNull();
    expect(detail).not.toBeNull();
    expect(list?.className).toContain('overflow-y-auto');
    expect(detail?.className).toContain('overflow-y-auto');
  });

  it('separates package identity, short Agent introduction, configuration, and human capability docs', async () => {
    const github = {
      ...PLUGIN_MANAGER_DESIGN_FIXTURES[0],
      readme: { state: 'available' as const, markdown: '# GitHub\n\n这是只在显式详情中读取的用户文档。' },
    };
    await act(async () => root.render(<PluginManagerContent fixtures={[github]} />));

    const detail = container.querySelector('[data-testid="plugin-manager-detail"]');
    expect(detail?.textContent).toContain('插件标识');
    expect(detail?.textContent).toContain('插件简介');
    expect(detail?.textContent).toContain('插件配置');
    expect(detail?.textContent).toContain('能力说明');
    expect(detail?.textContent).toContain('@clowder-ai/github');
    expect(detail?.textContent).toContain('跟踪 PR、CI/CD、冲突检测与仓库扫描');
    expect(detail?.textContent).toContain('这是只在显式详情中读取的用户文档。');
  });

  it('groups declared contributions and runtime tools by their real type and description', async () => {
    const video = {
      ...PLUGIN_MANAGER_DESIGN_FIXTURES[2],
      artifact: 'installed' as const,
      installedVersion: PLUGIN_MANAGER_DESIGN_FIXTURES[2].availableVersion,
      contributions: [{ id: 'video-analysis-toolset', kind: 'mcp' as const, name: 'video-analysis-toolset' }],
      tools: [
        {
          contributionId: 'video-analysis-toolset',
          name: 'video_analysis',
          description: '分析远程视频并返回结构化结果。',
        },
      ],
    };

    await act(async () => root.render(<PluginManagerContent fixtures={[video]} />));

    const detail = container.querySelector('[data-testid="plugin-manager-detail"]');
    const capabilityRow = detail?.querySelector('[data-contribution-kind="mcp"] li');
    expect(detail?.textContent).toContain('MCP');
    expect(capabilityRow?.textContent).toBe('video_analysis — 分析远程视频并返回结构化结果。');
    expect(capabilityRow?.querySelectorAll('p')).toHaveLength(1);
    expect(detail?.textContent?.match(/Analyze video/g) ?? []).toHaveLength(0);
    expect(detail?.textContent).not.toContain('插件未提供用途说明。');
  });

  it('labels content editor provider contributions from the manifest without Host-specific copy', async () => {
    const editor = {
      ...PLUGIN_MANAGER_DESIGN_FIXTURES[0],
      contributions: [{ id: 'docx-editor', kind: 'content-editor-provider' as const, name: 'docx-editor' }],
    };

    await act(async () => root.render(<PluginManagerContent fixtures={[editor]} />));

    const detail = container.querySelector('[data-testid="plugin-manager-detail"]');
    expect(detail?.querySelector('[data-contribution-kind="content-editor-provider"]')?.textContent).toContain(
      'Content Editor',
    );
    expect(detail?.textContent).toContain('docx-editor');
  });

  it('does not relabel permission grants as exposed tools before package admission', async () => {
    const video = {
      ...PLUGIN_MANAGER_DESIGN_FIXTURES[2],
      capabilities: [
        { name: 'Analyze video', description: 'Permission-backed video analysis.' },
        { name: 'Analyze video', description: 'Permission-backed video analysis.' },
      ],
      contributions: undefined,
    };

    await act(async () => root.render(<PluginManagerContent fixtures={[video]} />));

    const detail = container.querySelector('[data-testid="plugin-manager-detail"]');
    expect(detail?.textContent).toContain('安装后可查看具体工具与用途。');
    expect(detail?.textContent).not.toContain('Analyze video');
  });

  it('distinguishes unavailable contribution metadata from a verified empty contribution surface', async () => {
    const unavailable = {
      ...PLUGIN_MANAGER_DESIGN_FIXTURES[1],
      contributions: undefined,
    };

    await act(async () => root.render(<PluginManagerContent fixtures={[unavailable]} />));

    const detail = container.querySelector('[data-testid="plugin-manager-detail"]');
    expect(detail?.textContent).toContain('能力信息暂不可用。');
    expect(detail?.textContent).not.toContain('此插件未声明可展示的工具或资源。');

    await act(async () =>
      root.render(
        <PluginManagerContent
          fixtures={[
            {
              ...unavailable,
              contributions: [],
            },
          ]}
        />,
      ),
    );

    expect(detail?.textContent).toContain('此插件未声明可展示的工具或资源。');
    expect(detail?.textContent).not.toContain('能力信息暂不可用。');
  });
});
