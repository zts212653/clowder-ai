import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));

import { writeShellLanguage } from '../../shell/shell-language';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { InstallPreviewModal } from '../InstallPreviewModal';
import { installPreviewCopy } from '../install-preview.shell-copy';

const recommendation = {
  profile: {
    os: 'darwin' as const,
    arch: 'arm64' as const,
    gpu: 'none' as const,
    pythonArch: 'native' as const,
    ramGb: 16,
    diskFreeGb: 40,
    detectedAt: 1,
  },
  recommendation: {
    serviceId: 'whisper',
    profile: {
      os: 'darwin' as const,
      arch: 'arm64' as const,
      gpu: 'none' as const,
      pythonArch: 'native' as const,
      ramGb: 16,
      diskFreeGb: 40,
      detectedAt: 1,
    },
    models: [
      {
        name: 'owner/whisper-small',
        size: '2 GB',
        description: 'Balanced local model',
        requirements: { ramGb: 4, diskGb: 3, gpu: 'recommended' as const },
        performance: 'Runs locally',
      },
    ],
    notes: ['Existing installs stay available'],
    customModelHint: {
      requirement: 'Use an owner/model identifier',
      example: 'owner/model-name',
      unsupported: 'Archive files',
      links: [{ label: 'Model catalog', url: 'https://example.com/models' }],
    },
  },
  suggestedPort: 18888,
};

const response = (body: unknown, ok = true, status = ok ? 200 : 403) => ({
  ok,
  status,
  json: async () => body,
});

describe('InstallPreviewModal shell language boundary', () => {
  let host: HTMLDivElement;
  let root: Root;
  const onCancel = vi.fn();
  const onConfirm = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    window.localStorage.clear();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  async function renderModal(props: Partial<ComponentProps<typeof InstallPreviewModal>> = {}) {
    await act(async () => {
      root.render(
        <InstallPreviewModal
          open
          serviceId="whisper"
          serviceName="Whisper"
          estimatedMinutes={8}
          onConfirm={onConfirm}
          onCancel={onCancel}
          {...props}
        />,
      );
    });
    await vi.waitFor(() => expect(host.textContent).not.toMatch(/检测环境中…|Checking environment…/u));
  }

  it('uses the structured service identity and requests owner-localized display words in v2', async () => {
    writeShellPresentation('v2');
    writeShellLanguage('en');
    apiFetch.mockResolvedValue(response(recommendation));
    await renderModal({ serviceId: 'whisper-stt', serviceName: '语音识别 (Whisper)', mode: 'reconfigure' });
    expect(host.querySelector('h3')?.textContent).toBe('Reconfigure Speech recognition (Whisper)');
    expect(apiFetch).toHaveBeenCalledWith('/api/services/whisper-stt/install-preview?locale=en');
    expect(host.textContent).toContain('Balanced local model');
    expect(host.textContent).toContain('Existing installs stay available');
  });

  it.each([
    undefined,
    'owner/whisper-small',
    'owner/custom-initial',
  ])('initializes model and port when language changes before the first response (%s)', async (initialModel) => {
    writeShellPresentation('v2');
    writeShellLanguage('en');
    let releaseFirst!: (value: ReturnType<typeof response>) => void;
    apiFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseFirst = resolve;
      }),
    );
    apiFetch.mockResolvedValue(
      response({
        ...recommendation,
        recommendation: { ...recommendation.recommendation, notes: ['Current preview response'] },
      }),
    );
    await act(async () =>
      root.render(
        <InstallPreviewModal
          open
          serviceId="whisper"
          serviceName="Whisper"
          initialModel={initialModel}
          initialPort={19876}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />,
      ),
    );
    expect(host.textContent).toContain('Checking environment…');
    await act(async () => writeShellLanguage('zh'));
    await vi.waitFor(() => expect(host.textContent).toContain('Current preview response'));
    const confirm = host.querySelector<HTMLButtonElement>('button.console-button-primary');
    expect(confirm?.disabled).toBe(false);
    expect(
      host.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.closest('label')?.querySelector('p')
        ?.textContent,
    ).toBe(initialModel === 'owner/custom-initial' ? '自定义模型' : 'whisper-small');
    expect(Array.from(host.querySelectorAll<HTMLInputElement>('input')).map((input) => input.value)).toContain('19876');
    await act(async () =>
      releaseFirst(
        response({
          ...recommendation,
          recommendation: { ...recommendation.recommendation, notes: ['Withdrawn first response'] },
        }),
      ),
    );
    expect(host.textContent).not.toContain('Withdrawn first response');
    expect(confirm?.disabled).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('preserves a custom model and port when a language read arrives, and ignores an older response', async () => {
    writeShellPresentation('v2');
    writeShellLanguage('en');
    apiFetch.mockResolvedValue(response(recommendation));
    await renderModal({ initialModel: 'owner/custom-draft', initialPort: 19876 });
    let resolveChinese: (value: ReturnType<typeof response>) => void = () => {
      throw Error('Chinese request missing');
    };
    apiFetch.mockImplementationOnce(
      () =>
        new Promise<ReturnType<typeof response>>((resolve) => {
          resolveChinese = resolve;
        }),
    );
    await act(async () => writeShellLanguage('zh'));
    apiFetch.mockResolvedValueOnce(
      response({
        ...recommendation,
        recommendation: { ...recommendation.recommendation, notes: ['Latest English owner notes'] },
      }),
    );
    await act(async () => writeShellLanguage('en'));
    await vi.waitFor(() => expect(host.textContent).toContain('Latest English owner notes'));
    await act(async () =>
      resolveChinese(
        response({
          ...recommendation,
          recommendation: { ...recommendation.recommendation, notes: ['Older Chinese response'] },
        }),
      ),
    );
    expect(host.textContent).not.toContain('Older Chinese response');
    expect(Array.from(host.querySelectorAll<HTMLInputElement>('input')).map((input) => input.value)).toContain(
      'owner/custom-draft',
    );
    expect(Array.from(host.querySelectorAll<HTMLInputElement>('input')).map((input) => input.value)).toContain('19876');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('renders every generated control word in English in v2 while leaving service data untouched', async () => {
    writeShellPresentation('v2');
    writeShellLanguage('en');
    apiFetch.mockResolvedValue(response(recommendation));

    await renderModal();
    expect(host.querySelector('h3')?.textContent).toBe('Install Whisper');
    expect(host.textContent).toContain('Detected environment');
    expect(host.textContent).toContain('System: macOS arm64');
    expect(host.textContent).toContain('GPU: No GPU acceleration');
    expect(host.textContent).toContain('Memory: 16GB');
    expect(host.textContent).toContain('Available disk: 40GB');
    expect(host.textContent).toContain('Python: Not detected');
    expect(host.textContent).toContain('Model');
    expect(host.textContent).toContain('Recommended');
    expect(host.textContent).toContain('Balanced local model');
    expect(host.textContent).toContain('Service port');
    expect(host.textContent).toContain('A free port was found: 18888. Leave this blank to use it.');
    expect(host.textContent).toContain('Estimated time: about 8 minutes (depending on network speed)');
    expect(host.textContent).toContain('Offline installation guide');
    expect(host.querySelector<HTMLButtonElement>('button.console-button-primary')?.textContent).toBe(
      'Start installation',
    );
    expect(host.querySelector('button[aria-label="Close"]')).not.toBeNull();

    const radios = host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    await act(async () => radios.item(radios.length - 1).click());
    expect(host.textContent).toContain('Custom model');
    expect(host.textContent).toContain('Format: Use an owner/model identifier');
    expect(host.textContent).toContain('Example: owner/model-name');
    expect(host.textContent).toContain('Unsupported: Archive files (installation will fail)');

    expect(host.textContent?.match(/[\u3400-\u9fff]/gu) ?? []).toEqual([]);
  });

  it('keeps the classic presentation in its exact Chinese copy even when the v2 language preference is English', async () => {
    writeShellPresentation('classic');
    writeShellLanguage('en');
    apiFetch.mockResolvedValue(response(recommendation));

    await renderModal();
    expect(host.textContent).toBe(
      '安装 Whisper' +
        '检测到的环境' +
        '系统: macOS arm64' +
        'GPU: 无 GPU 加速' +
        '内存: 16GB' +
        '可用磁盘: 40GB' +
        'Python: 未检测到' +
        '模型选择' +
        'whisper-small' +
        '推荐' +
        '2 GB · 内存 4GB · 磁盘 3GB · 推荐 GPU' +
        'Balanced local model' +
        'Runs locally' +
        '自定义模型' +
        '注意事项' +
        '· Existing installs stay available' +
        '服务端口' +
        '系统已为你扫描到可用端口 18888，留空则使用该值' +
        '预计耗时 ~8 分钟（取决于网络速度）' +
        '网络受限 / 内网 / 离线？ ↗ 查看离线安装指南' +
        '开始安装',
    );
    expect(host.querySelector<HTMLButtonElement>('button.console-button-primary')?.textContent).toBe('开始安装');
    const closeButton = host.querySelector<HTMLButtonElement>('button[aria-label="关闭"]');
    const primaryButton = host.querySelector<HTMLButtonElement>('button.console-button-primary');
    const overlay = host.firstElementChild;
    const panel = overlay?.firstElementChild;
    expect(closeButton).not.toBeNull();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(overlay?.getAttribute('role')).toBeNull();
    expect(panel?.getAttribute('aria-modal')).toBeNull();
    expect(panel?.getAttribute('aria-labelledby')).toBeNull();
    expect(host.querySelector('h3')?.id).toBe('');
    expect(closeButton?.hasAttribute('type')).toBe(false);
    expect(closeButton?.querySelector('svg')?.hasAttribute('aria-hidden')).toBe(false);
    expect(primaryButton?.hasAttribute('type')).toBe(false);
  });

  it('pins every legacy generated phrase that classic can render', () => {
    const legacy = installPreviewCopy.zh;
    expect({
      installTitle: legacy.dialog.installTitle('Whisper'),
      reconfigureTitle: legacy.dialog.reconfigureTitle('Whisper'),
      close: legacy.dialog.close,
      loading: legacy.dialog.loading,
      forbidden: legacy.errors.forbidden,
      http: legacy.errors.http(403),
      network: legacy.errors.network,
      portInteger: legacy.errors.portInteger,
      portRange: legacy.errors.portRange,
      environment: legacy.environment,
      unsupported: legacy.unsupported,
      model: {
        ...legacy.model,
        memory: legacy.model.memory(4),
        disk: legacy.model.disk(3),
      },
      notes: legacy.notes,
      port: {
        title: legacy.port.title,
        automatic: legacy.port.automatic,
        suggested: legacy.port.suggested(18888),
      },
      estimatedTime: legacy.estimatedTime(8),
      reconfigureNote: legacy.reconfigureNote,
      offline: legacy.offline,
      actions: legacy.actions,
    }).toEqual({
      installTitle: '安装 Whisper',
      reconfigureTitle: '修改 Whisper',
      close: '关闭',
      loading: '检测环境中…',
      forbidden: '没有权限读取服务预览',
      http: '暂时读不到服务预览（HTTP 403）',
      network: '检测失败：网络错误',
      portInteger: '端口必须是整数（1-65535）',
      portRange: '端口需在 1-65535 范围内',
      environment: {
        title: '检测到的环境',
        system: '系统:',
        gpu: 'GPU:',
        memory: '内存:',
        disk: '可用磁盘:',
        python: 'Python:',
        gpuLabels: {
          apple: 'Apple Silicon',
          cuda: 'NVIDIA CUDA',
          rocm: 'AMD ROCm',
          none: '无 GPU 加速',
        },
        pythonArch: { native: '原生', x86Emulated: 'x86 模拟' },
        pythonMissing: '未检测到',
      },
      unsupported: { title: '当前环境暂不支持', action: '操作建议:' },
      model: {
        title: '模型选择',
        recommended: '推荐',
        custom: '自定义模型',
        format: '格式要求：',
        example: '示例：',
        unsupported: '不支持：',
        willFail: '（启动会失败）',
        memory: '内存 4GB',
        disk: '磁盘 3GB',
        gpuRequired: '需 GPU',
        gpuRecommended: '推荐 GPU',
        none: '无需模型',
        noneBody: '此服务只安装运行时依赖，不下载或选择模型。',
        audioCaptureBody: '此服务只安装运行时依赖，不下载或选择模型。语音识别模型请在 Whisper 服务中选择。',
      },
      notes: '注意事项',
      port: {
        title: '服务端口',
        automatic: '自动',
        suggested: '系统已为你扫描到可用端口 18888，留空则使用该值',
      },
      estimatedTime: '预计耗时 ~8 分钟（取决于网络速度）',
      reconfigureNote: '修改不会重建虚拟环境；端口仅写入配置，下次启用生效；切换模型会重新下载，但不重装依赖。',
      offline: { lead: '网络受限 / 内网 / 离线？', guide: '查看离线安装指南' },
      actions: { unsupported: '暂不支持', save: '保存修改', install: '开始安装' },
    });
  });

  it('localizes reconfigure, unsupported, loading and read-error states in v2', async () => {
    writeShellPresentation('v2');
    writeShellLanguage('en');
    let resolvePreview: ((value: ReturnType<typeof response>) => void) | undefined;
    apiFetch.mockReturnValue(new Promise((resolve) => (resolvePreview = resolve)));
    await act(async () => {
      root.render(
        <InstallPreviewModal
          open
          serviceId="whisper"
          serviceName="Whisper"
          mode="reconfigure"
          onConfirm={onConfirm}
          onCancel={onCancel}
        />,
      );
    });
    expect(host.textContent).toContain('Checking environment…');
    await act(async () => {
      resolvePreview?.(
        response({
          ...recommendation,
          recommendation: {
            ...recommendation.recommendation,
            models: [],
            unsupported: {
              reason: 'Provider is unavailable',
              userAction: 'Install the provider',
              retryHint: 'Try again after installation',
            },
          },
        }),
      );
    });
    await vi.waitFor(() => expect(host.textContent).toContain('This environment is not supported yet'));
    expect(host.querySelector('h3')?.textContent).toBe('Reconfigure Whisper');
    expect(host.textContent).toContain('Suggested action:');
    expect(host.querySelector<HTMLButtonElement>('button.console-button-primary')?.textContent).toBe('Not supported');

    apiFetch.mockResolvedValue(response({}, false, 403));
    await renderModal({ serviceId: 'denied' });
    expect(host.textContent).toContain('You do not have permission to read this service preview');
  });

  it('localizes the model-free audio-capture branch without translating service data', async () => {
    writeShellPresentation('v2');
    writeShellLanguage('en');
    apiFetch.mockResolvedValue(
      response({
        ...recommendation,
        recommendation: { ...recommendation.recommendation, serviceId: 'audio-capture', models: [], notes: [] },
      }),
    );

    await renderModal({ serviceId: 'audio-capture', serviceName: 'Audio Capture' });
    expect(host.textContent).toContain('No model required');
    expect(host.textContent).toContain(
      'This service installs runtime dependencies only; no model is downloaded or selected.',
    );
    expect(host.textContent).toContain('Choose the speech-recognition model in the Whisper service.');
    expect(host.textContent?.match(/[\u3400-\u9fff]/gu) ?? []).toEqual([]);
  });
});
