'use client';

import { useCallback, useEffect, useState } from 'react';

interface ModelOption {
  name: string;
  size: string;
  autoDownload: boolean;
  isDefault?: boolean;
  description?: string;
}

interface ServicePrerequisites {
  runtime?: string;
  packages?: string[];
  models?: ModelOption[];
  estimatedMinutes?: number;
}

interface InstallPreviewModalProps {
  serviceName: string;
  prerequisites: ServicePrerequisites;
  onConfirm: (selectedModel?: string) => void;
  onCancel: () => void;
}

export function InstallPreviewModal({ serviceName, prerequisites, onConfirm, onCancel }: InstallPreviewModalProps) {
  const models = prerequisites.models ?? [];
  const defaultModel = models.find((m) => m.isDefault) ?? models[0];
  const [selectedModel, setSelectedModel] = useState(defaultModel?.name ?? '');
  const [customModel, setCustomModel] = useState('');
  const [useCustom, setUseCustom] = useState(false);

  const handleBackdrop = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onCancel();
    },
    [onCancel],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  function handleConfirm() {
    const model = useCustom ? customModel.trim() : selectedModel;
    onConfirm(model || undefined);
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm"
      onClick={handleBackdrop}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-preview-title"
        className="relative flex max-h-[calc(100vh-32px)] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl bg-[var(--console-card-bg)] p-[26px] shadow-[0_20px_48px_rgba(43,33,26,0.14)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-[14px]">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--console-active-bg)] text-lg font-bold text-[var(--console-modal-title)]">
            +
          </div>
          <h2 id="install-preview-title" className="min-w-0 flex-1 text-xl font-extrabold text-cafe">
            Install {serviceName}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="关闭"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-base text-cafe-muted transition hover:bg-[var(--console-modal-close-bg)] hover:text-[var(--console-modal-close-fg)]"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto">
          {prerequisites.runtime && (
            <div className="rounded-2xl bg-[var(--console-panel-bg)] px-4 py-3">
              <p className="text-label font-semibold uppercase tracking-[0.22em] text-cafe-muted">Runtime</p>
              <p className="mt-1 text-sm text-cafe-secondary">{prerequisites.runtime}</p>
            </div>
          )}

          {prerequisites.packages && prerequisites.packages.length > 0 && (
            <div className="rounded-2xl bg-[var(--console-panel-bg)] px-4 py-3">
              <p className="text-label font-semibold uppercase tracking-[0.22em] text-cafe-muted">Packages</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {prerequisites.packages.map((pkg) => (
                  <span
                    key={pkg}
                    className="rounded-full bg-[var(--console-card-bg)] px-2.5 py-0.5 text-xs font-semibold text-cafe-secondary"
                  >
                    {pkg}
                  </span>
                ))}
              </div>
            </div>
          )}

          {models.length > 0 && (
            <div className="rounded-2xl bg-[var(--console-panel-bg)] px-4 py-3">
              <p className="text-label font-semibold uppercase tracking-[0.22em] text-cafe-muted">Model</p>
              <div className="mt-2 space-y-2">
                {models.map((model) => (
                  <label
                    key={model.name}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl px-3 py-2.5 transition-colors ${
                      !useCustom && selectedModel === model.name
                        ? 'bg-[var(--console-active-bg)]'
                        : 'hover:bg-[var(--console-card-bg)]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="model"
                      checked={!useCustom && selectedModel === model.name}
                      onChange={() => {
                        setUseCustom(false);
                        setSelectedModel(model.name);
                      }}
                      className="mt-0.5 shrink-0 accent-cafe-interactive"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-cafe">{model.name}</p>
                      <p className="mt-0.5 text-xs text-cafe-muted">
                        {model.size}
                        {model.description ? ` · ${model.description}` : ''}
                        {model.isDefault ? ' · default' : ''}
                      </p>
                    </div>
                  </label>
                ))}
                <label
                  className={`flex cursor-pointer items-start gap-3 rounded-xl px-3 py-2.5 transition-colors ${
                    useCustom ? 'bg-[var(--console-active-bg)]' : 'hover:bg-[var(--console-card-bg)]'
                  }`}
                >
                  <input
                    type="radio"
                    name="model"
                    checked={useCustom}
                    onChange={() => setUseCustom(true)}
                    className="mt-0.5 shrink-0 accent-cafe-interactive"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-cafe">Custom model</p>
                    {useCustom && (
                      <input
                        value={customModel}
                        onChange={(e) => setCustomModel(e.target.value)}
                        placeholder="org/model-name"
                        className="mt-1.5 w-full rounded-lg border border-cafe bg-[var(--console-card-bg)] px-2.5 py-1.5 text-xs text-cafe-secondary outline-none placeholder:text-cafe-muted"
                      />
                    )}
                  </div>
                </label>
              </div>
            </div>
          )}

          {prerequisites.estimatedMinutes != null && (
            <p className="text-xs text-cafe-muted">Estimated time: ~{prerequisites.estimatedMinutes} min</p>
          )}
        </div>

        <div className="mt-5 flex shrink-0 justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-sm font-semibold text-cafe-muted transition-colors hover:bg-[var(--console-panel-bg)] hover:text-cafe"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={useCustom && !customModel.trim()}
            className="rounded-xl bg-cafe-interactive px-4 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50"
          >
            Install
          </button>
        </div>
      </div>
    </div>
  );
}
