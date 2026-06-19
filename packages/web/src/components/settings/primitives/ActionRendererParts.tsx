/**
 * ActionRendererParts — pure render sub-components for ActionRenderer (AC-A26).
 * Extracted to keep ActionRenderer.tsx under 350 lines.
 */

import Image from 'next/image';

import { CheckCircleIcon, type PlatformActionDef, QrCodeIcon, SpinnerIcon } from '../../HubConfigIcons';

// Re-export types used by ActionRenderer for its internal state
export type ActionPhase = 'idle' | 'loading' | 'result' | 'polling' | 'connected' | 'error' | 'disconnecting';
export type ResultState = { render: string; data: unknown; label?: string };

export function ConnectedBanner({
  connectorId,
  label,
  disconnectLabel,
  disconnecting,
  onDisconnect,
}: {
  connectorId: string;
  label: string;
  disconnectLabel?: string;
  disconnecting: boolean;
  onDisconnect?: () => void;
}) {
  return (
    <div className="space-y-2" data-testid={`${connectorId}-connected`}>
      <div className="flex items-center justify-between bg-conn-green-bg border border-conn-green-ring rounded-lg px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-conn-green-text">
            <CheckCircleIcon />
          </span>
          <span className="text-sm font-medium text-conn-green-text">{label}</span>
        </div>
        {onDisconnect && (
          <button
            type="button"
            onClick={onDisconnect}
            disabled={disconnecting}
            className="text-xs text-cafe-secondary hover:text-conn-red-text transition-colors disabled:opacity-50"
            data-testid={`${connectorId}-disconnect`}
          >
            {disconnecting ? 'Disconnecting...' : (disconnectLabel ?? 'Disconnect')}
          </button>
        )}
      </div>
    </div>
  );
}

export function QrImagePanel({
  connectorId,
  url,
  statusLabel,
  showSpinner,
}: {
  connectorId: string;
  url: string;
  statusLabel?: string;
  showSpinner: boolean;
}) {
  return (
    <div className="console-list-card flex flex-col items-center gap-3 rounded-xl p-4 shadow-[var(--console-shadow-soft)]">
      <Image
        src={url}
        alt={`${connectorId} QR code`}
        width={192}
        height={192}
        unoptimized
        className="h-48 w-48 rounded-lg"
        data-testid={`${connectorId}-qr-image`}
      />
      {showSpinner && (
        <div className="flex items-center gap-2 text-cafe-secondary text-xs">
          <SpinnerIcon />
          <span>{statusLabel ?? 'Waiting for scan...'}</span>
        </div>
      )}
    </div>
  );
}

export function ActionPanelBody({
  connectorId,
  phase,
  currentAction,
  lastResult,
  errorMsg,
  themeColor,
  onAction,
}: {
  connectorId: string;
  phase: ActionPhase;
  currentAction: PlatformActionDef | undefined;
  lastResult: ResultState | undefined;
  errorMsg: string | null;
  themeColor?: string;
  onAction: (id: string) => void;
}) {
  const isButtonAction = currentAction?.render === 'button';
  const canTrigger = phase === 'idle' || phase === 'error' || phase === 'result';
  const imgData = lastResult?.render === 'img' ? (lastResult.data as { url?: string }) : null;
  const statusLabel =
    phase === 'result' && lastResult?.render === 'status'
      ? (lastResult.label ?? (typeof lastResult.data === 'string' ? lastResult.data : null))
      : null;

  return (
    <div className="space-y-3" data-testid={`${connectorId}-action-panel`}>
      {errorMsg && (
        <p className="text-xs text-conn-red-text bg-conn-red-bg rounded-lg px-3 py-2 border border-conn-red-ring">
          {errorMsg}
        </p>
      )}

      {isButtonAction && canTrigger && currentAction && (
        <button
          type="button"
          onClick={() => onAction(currentAction.id)}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-[var(--cafe-surface)] rounded-lg transition-colors hover:opacity-90"
          style={{ backgroundColor: themeColor ?? 'var(--conn-blue-text)' }}
          data-testid={`${connectorId}-action-${currentAction.id}`}
        >
          {currentAction.resultRender === 'img' && <QrCodeIcon />}
          {currentAction.label}
        </button>
      )}

      {phase === 'loading' && (
        <div className="flex items-center gap-2 text-cafe-secondary text-sm">
          <SpinnerIcon />
          <span>{currentAction?.label ?? 'Processing...'}...</span>
        </div>
      )}

      {statusLabel && (
        <div
          className="flex items-center gap-2 rounded-lg border border-conn-green-ring bg-conn-green-bg px-3 py-2 text-sm font-medium text-conn-green-text"
          data-testid={`${connectorId}-status-result`}
        >
          <CheckCircleIcon />
          <span>{statusLabel}</span>
        </div>
      )}

      {imgData?.url && (
        <QrImagePanel
          connectorId={connectorId}
          url={imgData.url}
          statusLabel={lastResult?.label}
          showSpinner={phase === 'polling'}
        />
      )}

      {phase === 'polling' && !imgData?.url && (
        <div className="flex items-center gap-2 text-cafe-secondary text-sm">
          <SpinnerIcon />
          <span>{lastResult?.label ?? 'Processing...'}</span>
        </div>
      )}
    </div>
  );
}
