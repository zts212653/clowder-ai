'use client';

import { useEffect, useState } from 'react';

interface ModelOption {
  name: string;
  size: string;
  autoDownload: boolean;
  isDefault?: boolean;
  description?: string;
}

interface ServicePrerequisites {
  runtime?: string;
  venvPath?: string;
  packages?: string[];
  models?: ModelOption[];
  estimatedMinutes?: number;
}

interface InstallPreviewModalProps {
  open: boolean;
  serviceName: string;
  prerequisites: ServicePrerequisites;
  onConfirm: (selectedModel?: string) => void;
  onCancel: () => void;
}

export function InstallPreviewModal({
  open,
  serviceName,
  prerequisites,
  onConfirm,
  onCancel,
}: InstallPreviewModalProps) {
  const models = prerequisites.models ?? [];
  const defaultModel = models.find((m) => m.isDefault) ?? models[0];
  const [selectedModel, setSelectedModel] = useState(defaultModel?.name ?? '');
  const [customModel, setCustomModel] = useState('');
  const [useCustom, setUseCustom] = useState(false);

  useEffect(() => {
    if (open) {
      setSelectedModel(defaultModel?.name ?? '');
      setCustomModel('');
      setUseCustom(false);
    }
  }, [open, defaultModel?.name]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  const finalModel = useCustom ? customModel.trim() : selectedModel;
  const canConfirm = !models.length || finalModel.length > 0;
  const selectedInfo = models.find((m) => m.name === selectedModel);
  const estimatedMinutes = prerequisites.estimatedMinutes;

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
          <h3 className="text-base font-semibold text-[var(--console-modal-title)]">安装 {serviceName}</h3>
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
          <div className="rounded-lg bg-[var(--console-field-bg)] px-4 py-3 space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-cafe-muted">环境要求</p>
            {prerequisites.runtime && (
              <p className="text-sm text-cafe-secondary">
                <span className="text-cafe font-medium">运行时:</span> {prerequisites.runtime}
              </p>
            )}
            {prerequisites.packages && prerequisites.packages.length > 0 && (
              <p className="text-sm text-cafe-secondary">
                <span className="text-cafe font-medium">依赖包:</span> {prerequisites.packages.join(', ')}
              </p>
            )}
          </div>

          {models.length > 0 && (
            <div className="rounded-lg bg-[var(--console-field-bg)] px-4 py-3 space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-cafe-muted">模型选择</p>
              <div className="space-y-1.5">
                {models.map((m) => (
                  <label
                    key={m.name}
                    className={`flex items-start gap-2 rounded-lg px-3 py-2 cursor-pointer transition-colors ${
                      !useCustom && selectedModel === m.name
                        ? 'bg-[var(--console-card-bg)] shadow-sm'
                        : 'hover:bg-[var(--console-card-bg)]/50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="model"
                      checked={!useCustom && selectedModel === m.name}
                      onChange={() => {
                        setSelectedModel(m.name);
                        setUseCustom(false);
                      }}
                      className="mt-1 accent-[var(--color-cafe-accent)]"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-cafe truncate">{m.name.split('/').pop()}</p>
                      <p className="text-[11px] text-cafe-muted">
                        {m.size}
                        {m.description && ` · ${m.description}`}
                      </p>
                    </div>
                  </label>
                ))}
                <label
                  className={`flex items-start gap-2 rounded-lg px-3 py-2 cursor-pointer transition-colors ${
                    useCustom ? 'bg-[var(--console-card-bg)] shadow-sm' : 'hover:bg-[var(--console-card-bg)]/50'
                  }`}
                >
                  <input
                    type="radio"
                    name="model"
                    checked={useCustom}
                    onChange={() => setUseCustom(true)}
                    className="mt-1 accent-[var(--color-cafe-accent)]"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-cafe">自定义模型</p>
                    {useCustom && (
                      <input
                        type="text"
                        value={customModel}
                        onChange={(e) => setCustomModel(e.target.value)}
                        placeholder="org/model-name"
                        className="mt-1 w-full border border-[var(--console-border-soft)] rounded-md px-2 py-1 text-xs bg-[var(--console-card-bg)] focus:outline-none focus:ring-1 focus:ring-conn-sky-ring"
                      />
                    )}
                  </div>
                </label>
              </div>
            </div>
          )}

          {(estimatedMinutes || (selectedInfo && selectedInfo.size)) && (
            <div className="rounded-lg bg-[var(--console-field-bg)] px-4 py-3 space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-cafe-muted">预计信息</p>
              {selectedInfo && !useCustom && (
                <p className="text-sm text-cafe-secondary">
                  <span className="text-cafe font-medium">模型大小:</span> {selectedInfo.size}
                </p>
              )}
              {estimatedMinutes && (
                <p className="text-sm text-cafe-secondary">
                  <span className="text-cafe font-medium">预计耗时:</span> ~{estimatedMinutes} 分钟（取决于网络速度）
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end pt-4">
          <button
            onClick={() => onConfirm(models.length > 0 ? finalModel : undefined)}
            disabled={!canConfirm}
            className="console-button-primary px-5 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            开始安装
          </button>
        </div>
      </div>
    </div>
  );
}
