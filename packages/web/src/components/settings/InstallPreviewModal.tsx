'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface ResourceRequirement {
  ramGb: number;
  diskGb: number;
  gpu?: 'required' | 'recommended' | 'optional';
}

interface ModelOption {
  name: string;
  size: string;
  description: string;
  requirements: ResourceRequirement;
  performance?: string;
}

interface UnsupportedReason {
  reason: string;
  userAction: string;
  retryHint: string;
}

interface EnvironmentProfile {
  os: 'darwin' | 'win32' | 'linux';
  arch: 'arm64' | 'x64';
  gpu: 'apple' | 'cuda' | 'rocm' | 'none';
  gpuDetail?: string;
  pythonArch: 'native' | 'x86-emulated';
  pythonVersion?: string;
  ramGb: number;
  diskFreeGb: number;
  detectedAt: number;
}

interface CustomModelHint {
  // Three-line structured hint; see CustomModelHint in
  // packages/api/src/domains/services/recommendation-types.ts for the
  // contract behind each field.
  requirement: string;
  example: string;
  unsupported?: string;
  links?: Array<{ label: string; url: string }>;
}

interface ServiceRecommendation {
  serviceId: string;
  profile: EnvironmentProfile;
  models: ModelOption[];
  unsupported?: UnsupportedReason;
  notes: string[];
  customModelHint?: CustomModelHint;
}

interface InstallPreviewModalProps {
  open: boolean;
  serviceId: string;
  serviceName: string;
  estimatedMinutes?: number;
  onConfirm: (opts: { model?: string; port?: number }) => void;
  onCancel: () => void;
  // Edit mode reuses this modal for the post-install reconfigure flow.
  // When mode === 'reconfigure', the modal pre-fills with the persisted
  // model/port, swaps wording to "修改 / 保存修改", and skips the install
  // time estimate (reconfigure only redownloads the model when changed).
  mode?: 'install' | 'reconfigure';
  initialModel?: string;
  initialPort?: number;
}

const OS_LABEL: Record<EnvironmentProfile['os'], string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

const GPU_LABEL: Record<EnvironmentProfile['gpu'], string> = {
  apple: 'Apple Silicon',
  cuda: 'NVIDIA CUDA',
  rocm: 'AMD ROCm',
  none: '无 GPU 加速',
};

const PYTHON_ARCH_LABEL: Record<EnvironmentProfile['pythonArch'], string> = {
  native: '原生',
  'x86-emulated': 'x86 模拟',
};

function formatRequirement(req: ResourceRequirement): string {
  const parts = [`内存 ${req.ramGb}GB`, `磁盘 ${req.diskGb}GB`];
  if (req.gpu === 'required') parts.push('需 GPU');
  else if (req.gpu === 'recommended') parts.push('推荐 GPU');
  return parts.join(' · ');
}

function EnvSummary({ profile }: { profile: EnvironmentProfile }) {
  return (
    <div className="rounded-lg bg-[var(--console-field-bg)] px-4 py-3 space-y-1">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-cafe-muted">检测到的环境</p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[12px] text-cafe-secondary">
        <span>
          <span className="text-cafe font-medium">系统:</span> {OS_LABEL[profile.os]} {profile.arch}
        </span>
        <span>
          <span className="text-cafe font-medium">GPU:</span> {GPU_LABEL[profile.gpu]}
        </span>
        <span>
          <span className="text-cafe font-medium">内存:</span> {profile.ramGb}GB
        </span>
        <span>
          <span className="text-cafe font-medium">可用磁盘:</span> {profile.diskFreeGb}GB
        </span>
        <span className="col-span-2">
          <span className="text-cafe font-medium">Python:</span>{' '}
          {profile.pythonVersion ? `${profile.pythonVersion} (${PYTHON_ARCH_LABEL[profile.pythonArch]})` : '未检测到'}
        </span>
      </div>
    </div>
  );
}

function UnsupportedPanel({ info }: { info: UnsupportedReason }) {
  return (
    <div className="rounded-lg border border-conn-red-border bg-conn-red-bg/40 px-4 py-3 space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-conn-red-text">当前环境暂不支持</p>
      <p className="text-sm text-cafe">{info.reason}</p>
      <div className="rounded bg-cafe-surface px-3 py-2 space-y-1">
        <p className="text-[12px] text-cafe">
          <span className="font-medium">操作建议:</span> {info.userAction}
        </p>
        <p className="text-[11px] text-cafe-muted">{info.retryHint}</p>
      </div>
    </div>
  );
}

interface ModelSelectorProps {
  models: ModelOption[];
  recommendedName?: string;
  selectedModel: string;
  useCustom: boolean;
  customModel: string;
  customModelHint?: CustomModelHint;
  onSelect: (name: string) => void;
  onToggleCustom: (v: boolean) => void;
  onCustomChange: (v: string) => void;
}

function ModelSelector(props: ModelSelectorProps) {
  const { models, recommendedName, selectedModel, useCustom, customModel, customModelHint } = props;
  return (
    <div className="rounded-lg bg-[var(--console-field-bg)] px-4 py-3 space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-cafe-muted">模型选择</p>
      <div className="space-y-1.5">
        {models.map((m) => {
          const isRecommended = m.name === recommendedName;
          const checked = !useCustom && selectedModel === m.name;
          return (
            <label
              key={m.name}
              className={`flex items-start gap-2 rounded-lg px-3 py-2 cursor-pointer transition-colors ${
                checked ? 'bg-[var(--console-card-bg)] shadow-sm' : 'hover:bg-[var(--console-card-bg)]/50'
              }`}
            >
              <input
                type="radio"
                name="model"
                checked={checked}
                onChange={() => {
                  props.onSelect(m.name);
                  props.onToggleCustom(false);
                }}
                className="mt-1 accent-[var(--color-cafe-accent)]"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <p className="text-sm font-medium text-cafe truncate">{m.name.split('/').pop()}</p>
                  {isRecommended && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-conn-emerald-bg text-conn-emerald-text">
                      推荐
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-cafe-muted">
                  {m.size} · {formatRequirement(m.requirements)}
                </p>
                <p className="text-[11px] text-cafe-muted">{m.description}</p>
                {m.performance && <p className="text-[10px] text-cafe-muted italic">{m.performance}</p>}
              </div>
            </label>
          );
        })}
        <label
          className={`flex items-start gap-2 rounded-lg px-3 py-2 cursor-pointer transition-colors ${
            useCustom ? 'bg-[var(--console-card-bg)] shadow-sm' : 'hover:bg-[var(--console-card-bg)]/50'
          }`}
        >
          <input
            type="radio"
            name="model"
            checked={useCustom}
            onChange={() => props.onToggleCustom(true)}
            className="mt-1 accent-[var(--color-cafe-accent)]"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-cafe">自定义模型</p>
            {useCustom && (
              <>
                <input
                  type="text"
                  value={customModel}
                  onChange={(e) => props.onCustomChange(e.target.value)}
                  placeholder="org/model-name"
                  className="mt-1 w-full border border-[var(--console-border-soft)] rounded-md px-2 py-1 text-xs bg-[var(--console-card-bg)] focus:outline-none focus:ring-1 focus:ring-conn-sky-ring"
                />
                {customModelHint && (
                  <div className="mt-1 space-y-0.5">
                    <p className="text-[11px] text-cafe-muted leading-relaxed">
                      <span className="font-semibold text-cafe">格式要求：</span>
                      {customModelHint.requirement}
                    </p>
                    <p className="text-[11px] text-cafe-muted leading-relaxed">
                      <span className="font-semibold text-cafe">示例：</span>
                      {customModelHint.example}
                    </p>
                    {customModelHint.unsupported && (
                      <p className="text-[11px] leading-relaxed text-conn-amber-text">
                        <span className="font-semibold">不支持：</span>
                        {customModelHint.unsupported}（启动会失败）
                      </p>
                    )}
                    {customModelHint.links && customModelHint.links.length > 0 && (
                      <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                        {customModelHint.links.map((link) => (
                          <a
                            key={link.url}
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-[11px] text-conn-sky-text hover:underline"
                          >
                            ↗ {link.label}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </label>
      </div>
    </div>
  );
}

export function InstallPreviewModal({
  open,
  serviceId,
  serviceName,
  estimatedMinutes,
  onConfirm,
  onCancel,
  mode = 'install',
  initialModel,
  initialPort,
}: InstallPreviewModalProps) {
  const isReconfigure = mode === 'reconfigure';
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rec, setRec] = useState<ServiceRecommendation | null>(null);
  const [selectedModel, setSelectedModel] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [portInput, setPortInput] = useState('');
  const [suggestedPort, setSuggestedPort] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setRec(null);
    setUseCustom(false);
    setCustomModel('');
    setPortInput(typeof initialPort === 'number' ? String(initialPort) : '');
    setSuggestedPort(null);
    apiFetch(`/api/services/${serviceId}/install-preview`)
      .then(async (res) => {
        if (!res.ok) {
          setError(`检测失败 (HTTP ${res.status})`);
          return;
        }
        const data = (await res.json()) as {
          profile: EnvironmentProfile;
          recommendation: ServiceRecommendation;
          suggestedPort?: number;
        };
        setRec(data.recommendation);
        // In reconfigure mode, pre-fill the radio with the persisted model
        // when it matches one of the recommendation entries; otherwise
        // surface it through the custom-model input so the user sees what
        // is currently installed and can override it.
        const firstModel = data.recommendation.models[0]?.name ?? '';
        if (initialModel) {
          const matchesPreset = data.recommendation.models.some((m) => m.name === initialModel);
          if (matchesPreset) {
            setSelectedModel(initialModel);
          } else {
            setSelectedModel(firstModel);
            setUseCustom(true);
            setCustomModel(initialModel);
          }
        } else {
          setSelectedModel(firstModel);
        }
        // Only honor the server-suggested port when the caller didn't
        // already provide one (reconfigure: use the persisted port; fresh
        // install: use the scanned port).
        if (data.suggestedPort) {
          setSuggestedPort(data.suggestedPort);
          if (typeof initialPort !== 'number') {
            setPortInput(String(data.suggestedPort));
          }
        }
      })
      .catch(() => setError('检测失败：网络错误'))
      .finally(() => setLoading(false));
  }, [open, serviceId, initialModel, initialPort]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  const allModels: ModelOption[] = rec?.models ?? [];
  const finalModel = useCustom ? customModel.trim() : selectedModel;
  const isUnsupported = !!rec?.unsupported;

  // Parse and validate the port field. Number.parseInt silently truncates
  // "9876.5" → 9876 and "1e4" → 1, so use Number() + Number.isInteger to
  // reject any non-integer text and surface the error inline rather than
  // sending an unintended port through to bind/health/stop. Codex P2
  // 3252115599. Empty string means "auto" → undefined, falls back to
  // server suggestion.
  const trimmedPort = portInput.trim();
  let portValue: number | undefined;
  let portError: string | null = null;
  if (trimmedPort.length > 0) {
    const n = Number(trimmedPort);
    if (!Number.isInteger(n)) {
      portError = '端口必须是整数（1-65535）';
    } else if (n < 1 || n > 65535) {
      portError = '端口需在 1-65535 范围内';
    } else {
      portValue = n;
    }
  }

  const canConfirm =
    !loading && !error && !isUnsupported && !portError && (allModels.length === 0 || finalModel.length > 0);

  return (
    <div
      className="fixed inset-0 bg-[var(--console-overlay-backdrop)] flex items-center justify-center z-[100] p-4"
      onClick={onCancel}
    >
      <div
        className="bg-cafe-surface rounded-xl border border-[var(--cafe-border)] shadow-xl p-6 max-w-md w-full mx-4 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-[var(--console-modal-title)]">
            {isReconfigure ? `修改 ${serviceName}` : `安装 ${serviceName}`}
          </h3>
          <button
            onClick={onCancel}
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--console-modal-close-bg)] text-[var(--console-modal-close-fg)] hover:opacity-80 transition-opacity"
            aria-label="关闭"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="space-y-3">
          {loading && (
            <div className="rounded-lg bg-[var(--console-field-bg)] px-4 py-6 text-center text-sm text-cafe-muted">
              检测环境中…
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-conn-red-border bg-conn-red-bg/40 px-4 py-3 text-sm text-conn-red-text">
              {error}
            </div>
          )}

          {rec && <EnvSummary profile={rec.profile} />}

          {rec?.unsupported && <UnsupportedPanel info={rec.unsupported} />}

          {rec && !isUnsupported && allModels.length > 0 && (
            <ModelSelector
              models={allModels}
              recommendedName={allModels[0]?.name}
              selectedModel={selectedModel}
              useCustom={useCustom}
              customModel={customModel}
              customModelHint={rec.customModelHint}
              onSelect={setSelectedModel}
              onToggleCustom={setUseCustom}
              onCustomChange={setCustomModel}
            />
          )}

          {rec && !isUnsupported && allModels.length === 0 && (
            <div className="rounded-lg bg-[var(--console-field-bg)] px-4 py-3 space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-cafe-muted">模型选择</p>
              <p className="text-sm font-medium text-cafe">无需模型</p>
              <p className="text-[12px] text-cafe-secondary">
                此服务只安装运行时依赖，不下载或选择模型。
                {serviceId === 'audio-capture' ? '语音识别模型请在 Whisper 服务中选择。' : ''}
              </p>
            </div>
          )}

          {rec && rec.notes.length > 0 && (
            <div className="rounded-lg border border-conn-amber-border bg-conn-amber-bg/40 px-4 py-3 space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-conn-amber-text">注意事项</p>
              {rec.notes.map((c) => (
                <p key={c} className="text-[12px] text-cafe-secondary">
                  · {c}
                </p>
              ))}
            </div>
          )}

          {!isUnsupported && (
            <div className="rounded-lg bg-[var(--console-field-bg)] px-4 py-3 space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-cafe-muted">服务端口</p>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={portInput}
                  onChange={(e) => setPortInput(e.target.value)}
                  placeholder={suggestedPort ? String(suggestedPort) : '自动'}
                  className="w-32 border border-[var(--console-border-soft)] rounded-md px-2 py-1 text-xs bg-[var(--console-card-bg)] focus:outline-none focus:ring-1 focus:ring-conn-sky-ring"
                />
                {suggestedPort && !portError && (
                  <span className="text-[11px] text-cafe-muted">
                    系统已为你扫描到可用端口 {suggestedPort}，留空则使用该值
                  </span>
                )}
              </div>
              {portError && <p className="text-[11px] text-conn-rose-text">{portError}</p>}
            </div>
          )}

          {estimatedMinutes && !isUnsupported && !isReconfigure && (
            <p className="text-[11px] text-cafe-muted">预计耗时 ~{estimatedMinutes} 分钟（取决于网络速度）</p>
          )}

          {isReconfigure && !isUnsupported && (
            <p className="text-[11px] text-cafe-muted">
              修改不会重建虚拟环境；端口仅写入配置，下次启用生效；切换模型会重新下载，但不重装依赖。
            </p>
          )}

          {!isUnsupported && (
            <p className="text-[11px] text-cafe-muted">
              网络受限 / 内网 / 离线？{' '}
              <a
                href="/api/services/docs/offline-install"
                target="_blank"
                rel="noopener noreferrer"
                className="text-conn-sky-text hover:underline"
              >
                ↗ 查看离线安装指南
              </a>
            </p>
          )}
        </div>

        <div className="flex justify-end pt-4">
          <button
            onClick={() => {
              onConfirm({
                model: allModels.length > 0 ? finalModel : undefined,
                port: portValue ?? suggestedPort ?? undefined,
              });
            }}
            disabled={!canConfirm}
            className="console-button-primary px-5 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isUnsupported ? '暂不支持' : isReconfigure ? '保存修改' : '开始安装'}
          </button>
        </div>
      </div>
    </div>
  );
}
