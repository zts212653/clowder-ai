'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { apiFetch } from '@/utils/api-client';
import { useShellCopy } from '../shell/shell-copy';
import { useShellLanguage } from '../shell/shell-language';
import {
  type EnvironmentProfile,
  EnvSummary,
  type ModelOption,
  ModelSelector,
  type ServiceRecommendation,
  UnsupportedPanel,
} from './InstallPreviewModalParts';
import { installPreviewCopy } from './install-preview.shell-copy';

interface InstallPreviewModalProps {
  open: boolean;
  serviceId: string;
  serviceName: string;
  estimatedMinutes?: number;
  onConfirm: (opts: { model?: string; port?: number }) => void;
  onCancel: () => void;
  mode?: 'install' | 'reconfigure';
  initialModel?: string;
  initialPort?: number;
}

type PreviewError = { kind: 'forbidden' } | { kind: 'http'; status: number } | { kind: 'network' };

const OVERLAY_CLASS =
  'fixed inset-0 bg-[var(--console-overlay-backdrop)] backdrop-blur-sm flex items-center justify-center z-[100] p-4';
const PANEL_CLASS =
  'bg-cafe-surface rounded-2xl border border-[var(--cafe-border)] shadow-xl p-6 max-w-md w-full mx-4 max-h-[85vh] overflow-y-auto';

function InstallPreviewOverlay({
  isV2,
  onCancel,
  children,
}: {
  isV2: boolean;
  onCancel: () => void;
  children: ReactNode;
}) {
  if (isV2) {
    return (
      <div
        role="presentation"
        className={OVERLAY_CLASS}
        onClick={(event) => {
          if (event.target === event.currentTarget) onCancel();
        }}
      >
        {children}
      </div>
    );
  }
  return (
    <div className={OVERLAY_CLASS} onClick={onCancel}>
      {children}
    </div>
  );
}

function InstallPreviewPanel({ isV2, children }: { isV2: boolean; children: ReactNode }) {
  if (isV2) {
    return (
      <div role="dialog" aria-modal="true" aria-labelledby="install-preview-title" className={PANEL_CLASS}>
        {children}
      </div>
    );
  }
  return (
    <div className={PANEL_CLASS} onClick={(event) => event.stopPropagation()}>
      {children}
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
  const localizedCopy = useShellCopy(installPreviewCopy);
  const presentation = useShellPresentation();
  const isV2 = presentation === 'v2';
  const language = useShellLanguage();
  const readLocale = isV2 ? language : undefined;
  const initializedPreview = useRef<string | null>(null);
  // Classic is a compatibility surface: its original Chinese copy stays byte-for-byte regardless of the v2 language choice.
  const t = isV2 ? localizedCopy : installPreviewCopy.zh;
  const isReconfigure = mode === 'reconfigure';
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PreviewError | null>(null);
  const [recommendation, setRecommendation] = useState<ServiceRecommendation | null>(null);
  const [selectedModel, setSelectedModel] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [portInput, setPortInput] = useState('');
  const [suggestedPort, setSuggestedPort] = useState<number | null>(null);

  useEffect(() => {
    if (!open) {
      initializedPreview.current = null;
      return;
    }
    const identity = JSON.stringify([serviceId, initialModel, initialPort]);
    const preserveDraft = initializedPreview.current === identity;
    let current = true;
    setLoading(true);
    setError(null);
    setRecommendation(null);
    if (!preserveDraft) {
      initializedPreview.current = null;
      setUseCustom(false);
      setCustomModel('');
      setPortInput(typeof initialPort === 'number' ? String(initialPort) : '');
      setSuggestedPort(null);
    }
    apiFetch(`/api/services/${serviceId}/install-preview${readLocale ? `?locale=${readLocale}` : ''}`)
      .then(async (response) => {
        if (!current) return;
        if (!response.ok) {
          setError(response.status === 403 ? { kind: 'forbidden' } : { kind: 'http', status: response.status });
          return;
        }
        const data = (await response.json()) as {
          profile: EnvironmentProfile;
          recommendation: ServiceRecommendation;
          suggestedPort?: number;
        };
        if (!current) return;
        setRecommendation(data.recommendation);
        const firstModel = data.recommendation.models[0]?.name ?? '';
        if (!preserveDraft && initialModel) {
          const matchesPreset = data.recommendation.models.some((model) => model.name === initialModel);
          if (matchesPreset) {
            setSelectedModel(initialModel);
          } else {
            setSelectedModel(firstModel);
            setUseCustom(true);
            setCustomModel(initialModel);
          }
        } else if (!preserveDraft) {
          setSelectedModel(firstModel);
        }
        if (data.suggestedPort) {
          setSuggestedPort(data.suggestedPort);
          if (!preserveDraft && typeof initialPort !== 'number') setPortInput(String(data.suggestedPort));
        }
        initializedPreview.current = identity;
      })
      .catch(() => {
        if (current) setError({ kind: 'network' });
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [open, serviceId, initialModel, initialPort, readLocale]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  const allModels: ModelOption[] = recommendation?.models ?? [];
  const finalModel = useCustom ? customModel.trim() : selectedModel;
  const isUnsupported = !!recommendation?.unsupported;
  const renderedError =
    error?.kind === 'forbidden'
      ? t.errors.forbidden
      : error?.kind === 'http'
        ? t.errors.http(error.status)
        : error?.kind === 'network'
          ? t.errors.network
          : null;

  const trimmedPort = portInput.trim();
  let portValue: number | undefined;
  let portError: string | null = null;
  if (trimmedPort.length > 0) {
    const value = Number(trimmedPort);
    if (!Number.isInteger(value)) portError = t.errors.portInteger;
    else if (value < 1 || value > 65535) portError = t.errors.portRange;
    else portValue = value;
  }

  const displayService =
    isV2 && Object.hasOwn(t.services, serviceId) ? t.services[serviceId as keyof typeof t.services] : serviceName;

  const canConfirm =
    !loading && !error && !isUnsupported && !portError && (allModels.length === 0 || finalModel.length > 0);

  return (
    <InstallPreviewOverlay isV2={isV2} onCancel={onCancel}>
      <InstallPreviewPanel isV2={isV2}>
        <div className="flex items-center justify-between mb-4">
          <h3
            id={isV2 ? 'install-preview-title' : undefined}
            className="text-base font-semibold text-[var(--console-modal-title)]"
          >
            {isReconfigure ? t.dialog.reconfigureTitle(displayService) : t.dialog.installTitle(displayService)}
          </h3>
          <button
            type={isV2 ? 'button' : undefined}
            onClick={onCancel}
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--console-modal-close-bg)] text-[var(--console-modal-close-fg)] hover:opacity-80 transition-opacity"
            aria-label={t.dialog.close}
          >
            <svg aria-hidden={isV2 ? true : undefined} width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="space-y-3">
          {loading && (
            <div className="rounded-lg bg-[var(--console-field-bg)] px-4 py-6 text-center text-sm text-cafe-muted">
              {t.dialog.loading}
            </div>
          )}

          {renderedError && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-lg border border-cafe-subtle px-4 py-3 text-sm text-cafe-secondary"
            >
              <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-semantic-critical" />
              {renderedError}
            </div>
          )}

          {recommendation && <EnvSummary profile={recommendation.profile} copy={t} />}
          {recommendation?.unsupported && <UnsupportedPanel info={recommendation.unsupported} copy={t} />}

          {recommendation && !isUnsupported && allModels.length > 0 && (
            <ModelSelector
              models={allModels}
              recommendedName={allModels[0]?.name}
              selectedModel={selectedModel}
              useCustom={useCustom}
              customModel={customModel}
              customModelHint={recommendation.customModelHint}
              copy={t}
              onSelect={setSelectedModel}
              onToggleCustom={setUseCustom}
              onCustomChange={setCustomModel}
            />
          )}

          {recommendation && !isUnsupported && allModels.length === 0 && (
            <div className="rounded-lg bg-[var(--console-field-bg)] px-4 py-3 space-y-1.5">
              <p className="text-micro font-semibold uppercase tracking-wider text-cafe-muted">{t.model.title}</p>
              <p className="text-sm font-medium text-cafe">{t.model.none}</p>
              <p className="text-xs text-cafe-secondary">
                {serviceId === 'audio-capture' ? t.model.audioCaptureBody : t.model.noneBody}
              </p>
            </div>
          )}

          {recommendation && recommendation.notes.length > 0 && (
            <div className="rounded-lg border border-conn-amber-border bg-conn-amber-bg/40 px-4 py-3 space-y-1">
              <p className="text-micro font-semibold uppercase tracking-wider text-conn-amber-text">{t.notes}</p>
              {recommendation.notes.map((note) => (
                <p key={note} className="text-xs text-cafe-secondary">
                  · {note}
                </p>
              ))}
            </div>
          )}

          {!isUnsupported && (
            <div className="rounded-lg bg-[var(--console-field-bg)] px-4 py-3 space-y-1.5">
              <p className="text-micro font-semibold uppercase tracking-wider text-cafe-muted">{t.port.title}</p>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={portInput}
                  onChange={(event) => setPortInput(event.target.value)}
                  placeholder={suggestedPort ? String(suggestedPort) : t.port.automatic}
                  className="w-32 border border-[var(--console-border-soft)] rounded-md px-2 py-1 text-xs bg-[var(--console-card-bg)] focus:outline-none focus:ring-1 focus:ring-conn-sky-ring"
                />
                {suggestedPort && !portError && (
                  <span className="text-micro text-cafe-muted">{t.port.suggested(suggestedPort)}</span>
                )}
              </div>
              {portError && <p className="text-micro text-conn-rose-text">{portError}</p>}
            </div>
          )}

          {estimatedMinutes && !isUnsupported && !isReconfigure && (
            <p className="text-micro text-cafe-muted">{t.estimatedTime(estimatedMinutes)}</p>
          )}
          {isReconfigure && !isUnsupported && <p className="text-micro text-cafe-muted">{t.reconfigureNote}</p>}
          {!isUnsupported && (
            <p className="text-micro text-cafe-muted">
              {t.offline.lead}{' '}
              <a
                href="/api/services/docs/offline-install"
                target="_blank"
                rel="noopener noreferrer"
                className="text-conn-sky-text hover:underline"
              >
                ↗ {t.offline.guide}
              </a>
            </p>
          )}
        </div>

        <div className="flex justify-end pt-4">
          <button
            type={isV2 ? 'button' : undefined}
            onClick={() =>
              onConfirm({
                model: allModels.length > 0 ? finalModel : undefined,
                port: portValue ?? suggestedPort ?? undefined,
              })
            }
            disabled={!canConfirm}
            className="console-button-primary px-5 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isUnsupported ? t.actions.unsupported : isReconfigure ? t.actions.save : t.actions.install}
          </button>
        </div>
      </InstallPreviewPanel>
    </InstallPreviewOverlay>
  );
}
