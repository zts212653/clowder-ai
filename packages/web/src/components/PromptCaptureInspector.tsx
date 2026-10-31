'use client';

import { useState } from 'react';
import { useCatTechnicalLabelResolver } from '@/hooks/useCatNameResolver';

export interface PromptCaptureData {
  captureId: string;
  invocationId: string;
  catId: string;
  model: string;
  capturedAt: number;
  systemPrompt: string;
  missionPrefix?: string;
  userPrompt: string;
  effectivePrompt: string;
  injectionDecision: {
    isResume: boolean;
    canSkipOnResume: boolean;
    forceReinjection: boolean;
    injected: boolean;
  };
  promptBytes: number;
  tokenEstimate: number;
  nativeSystemPrompt?: string;
  nativeSystemPromptSource?: 'f203-l0';
  nativeSystemTokenEstimate?: number;
  totalTokenEstimate?: number;
  captureDiagnostics?: readonly string[];
}

type InspectorTab = 'system' | 'user' | 'effective' | 'meta';

const INSPECTOR_TABS: { key: InspectorTab; label: string; color: string }[] = [
  { key: 'system', label: 'System', color: 'text-conn-blue-text' },
  { key: 'user', label: 'User', color: 'text-conn-green-text' },
  { key: 'effective', label: 'Full Prompt', color: 'text-conn-purple-text' },
  { key: 'meta', label: 'Meta', color: 'text-conn-amber-text' },
];

function keyedDiagnostics(diagnostics: readonly string[]) {
  const occurrences = new Map<string, number>();
  return diagnostics.map((diagnostic) => {
    const occurrence = (occurrences.get(diagnostic) ?? 0) + 1;
    occurrences.set(diagnostic, occurrence);
    return { diagnostic, key: `${diagnostic}-${occurrence}` };
  });
}

export function PromptCaptureInspector({ capture }: { capture: PromptCaptureData }) {
  const [tab, setTab] = useState<InspectorTab>('system');

  return (
    <div
      className="mt-3 rounded-lg border border-conn-purple-ring bg-cafe-surface p-3"
      data-testid="prompt-capture-inspector"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-conn-purple-text">Prompt X-Ray</span>
        <div className="flex items-center gap-2 text-micro text-cafe-muted">
          <span>{capture.model}</span>
          <span>·</span>
          <span>{(capture.promptBytes / 1024).toFixed(1)} KB</span>
          <span>·</span>
          <span>~{capture.totalTokenEstimate ?? capture.tokenEstimate} tokens</span>
        </div>
      </div>

      <PromptTokenBar capture={capture} />

      <div className="mt-2 flex gap-1 border-b border-cafe-border pb-1">
        {INSPECTOR_TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={`rounded-t px-2 py-0.5 text-micro font-medium transition-colors ${
              tab === item.key ? `${item.color} bg-cafe-surface-elevated` : 'text-cafe-muted hover:text-cafe-secondary'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="mt-2 max-h-[300px] overflow-y-auto">
        <PromptCaptureTabContent tab={tab} capture={capture} />
      </div>
    </div>
  );
}

function PromptCaptureTabContent({ tab, capture }: { tab: InspectorTab; capture: PromptCaptureData }) {
  if (tab === 'system') return <PromptSystemContent capture={capture} />;
  if (tab === 'user') {
    return (
      <>
        {capture.missionPrefix && (
          <PromptSection content={capture.missionPrefix} label="Mission Prefix" className="mb-2" />
        )}
        <PromptSection content={capture.userPrompt} label="User Prompt" />
      </>
    );
  }
  if (tab === 'effective') return <PromptSection content={capture.effectivePrompt} label="Effective Prompt (Full)" />;
  return <PromptMeta capture={capture} />;
}

function PromptSystemContent({ capture }: { capture: PromptCaptureData }) {
  const systemLabel = capture.nativeSystemPrompt
    ? capture.injectionDecision.injected
      ? 'Message system prompt (pack appendix)'
      : 'Message system prompt (pack appendix · not sent this turn)'
    : capture.injectionDecision.injected
      ? 'System Prompt'
      : 'System Prompt (not sent)';
  return (
    <>
      {capture.nativeSystemPrompt && (
        <PromptSection
          content={capture.nativeSystemPrompt}
          label={`Native L0 (system role)${
            capture.nativeSystemPromptSource ? ` · ${capture.nativeSystemPromptSource}` : ''
          }`}
          className="mb-2"
        />
      )}
      {!capture.injectionDecision.injected && (
        <div className="mb-2 rounded bg-conn-amber-bg px-2 py-1 text-micro text-conn-amber-text">
          {capture.nativeSystemPrompt
            ? 'Resume — message-system pack not appended this turn (Native L0 still sent via system-role channel)'
            : 'Resume — system prompt was not injected this turn'}
        </div>
      )}
      <PromptSection content={capture.systemPrompt} label={systemLabel} />
      {capture.captureDiagnostics && capture.captureDiagnostics.length > 0 && (
        <div className="mt-2 rounded border border-conn-amber-ring bg-conn-amber-bg p-2 text-micro text-conn-amber-text">
          <div className="mb-1 font-medium">Capture diagnostics</div>
          <ul className="ml-3 list-disc space-y-0.5">
            {keyedDiagnostics(capture.captureDiagnostics).map(({ diagnostic, key }) => (
              <li key={key}>{diagnostic}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function PromptTokenBar({ capture }: { capture: PromptCaptureData }) {
  const nativeLength = capture.nativeSystemPrompt?.length ?? 0;
  const systemLength = capture.injectionDecision.injected ? capture.systemPrompt.length : 0;
  const missionLength = capture.missionPrefix?.length ?? 0;
  const userLength = capture.userPrompt.length;
  const total = nativeLength + capture.effectivePrompt.length || 1;
  const nativePercent = (nativeLength / total) * 100;
  const systemPercent = (systemLength / total) * 100;
  const missionPercent = (missionLength / total) * 100;
  const userPercent = (userLength / total) * 100;

  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-cafe-surface-elevated">
        {nativePercent > 0 && (
          <div
            className="bg-conn-purple-text"
            style={{ width: `${nativePercent}%` }}
            title={`Native L0: ${nativePercent.toFixed(0)}%`}
          />
        )}
        <div
          className="bg-conn-blue-text"
          style={{ width: `${systemPercent}%` }}
          title={`System: ${systemPercent.toFixed(0)}%`}
        />
        {missionPercent > 0 && (
          <div
            className="bg-conn-amber-text"
            style={{ width: `${missionPercent}%` }}
            title={`Mission: ${missionPercent.toFixed(0)}%`}
          />
        )}
        <div
          className="bg-conn-green-text"
          style={{ width: `${userPercent}%` }}
          title={`User: ${userPercent.toFixed(0)}%`}
        />
      </div>
      <div className="mt-0.5 flex gap-3 text-micro text-cafe-muted">
        {nativePercent > 0 && (
          <span>
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-conn-purple-text" /> Native L0{' '}
            {nativePercent.toFixed(0)}%
          </span>
        )}
        <span>
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-conn-blue-text" /> System {systemPercent.toFixed(0)}
          %
        </span>
        {missionPercent > 0 && (
          <span>
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-conn-amber-text" /> Mission{' '}
            {missionPercent.toFixed(0)}%
          </span>
        )}
        <span>
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-conn-green-text" /> User {userPercent.toFixed(0)}%
        </span>
      </div>
    </div>
  );
}

function PromptSection({ content, label, className = '' }: { content: string; label: string; className?: string }) {
  if (!content) return <div className="text-micro text-cafe-muted">Empty</div>;
  return (
    <div className={className}>
      <div className="mb-1 text-micro font-medium text-cafe-muted">{label}</div>
      <pre className="whitespace-pre-wrap break-words rounded bg-cafe-surface p-2 font-mono text-micro leading-relaxed text-cafe">
        {content}
      </pre>
    </div>
  );
}

function PromptMeta({ capture }: { capture: PromptCaptureData }) {
  const resolveCatTechnicalLabel = useCatTechnicalLabelResolver();
  const { injectionDecision } = capture;
  return (
    <div className="space-y-2 text-micro">
      <div>
        <div className="font-medium text-cafe-muted">Capture Info</div>
        <div className="ml-2 space-y-0.5">
          <div>
            <span className="text-cafe-muted">captureId:</span> <span className="font-mono">{capture.captureId}</span>
          </div>
          <div>
            <span className="text-cafe-muted">invocationId:</span>{' '}
            <span className="font-mono">{capture.invocationId}</span>
          </div>
          <div>
            <span className="text-cafe-muted">member:</span> {resolveCatTechnicalLabel(capture.catId)}
          </div>
          <div>
            <span className="text-cafe-muted">model:</span> {capture.model}
          </div>
          <div>
            <span className="text-cafe-muted">captured:</span> {new Date(capture.capturedAt).toLocaleString()}
          </div>
        </div>
      </div>
      <div>
        <div className="font-medium text-cafe-muted">Injection Decision</div>
        <div className="ml-2 space-y-0.5">
          <div>
            <span className="text-cafe-muted">injected:</span>{' '}
            <span className={injectionDecision.injected ? 'text-conn-green-text' : 'text-conn-red-text'}>
              {String(injectionDecision.injected)}
            </span>
          </div>
          <div>
            <span className="text-cafe-muted">isResume:</span> {String(injectionDecision.isResume)}
          </div>
          <div>
            <span className="text-cafe-muted">canSkipOnResume:</span> {String(injectionDecision.canSkipOnResume)}
          </div>
          <div>
            <span className="text-cafe-muted">forceReinjection:</span> {String(injectionDecision.forceReinjection)}
          </div>
        </div>
      </div>
      <div>
        <div className="font-medium text-cafe-muted">Size</div>
        <div className="ml-2 space-y-0.5">
          <div>
            <span className="text-cafe-muted">bytes:</span> {capture.promptBytes.toLocaleString()}
          </div>
          <div>
            <span className="text-cafe-muted">tokens · message (est):</span> ~{capture.tokenEstimate.toLocaleString()}
          </div>
          {capture.nativeSystemTokenEstimate !== undefined && (
            <div>
              <span className="text-cafe-muted">tokens · native L0 (est):</span> ~
              {capture.nativeSystemTokenEstimate.toLocaleString()}
              {capture.nativeSystemPromptSource ? (
                <span className="ml-1 text-cafe-muted">({capture.nativeSystemPromptSource})</span>
              ) : null}
            </div>
          )}
          {capture.totalTokenEstimate !== undefined && capture.totalTokenEstimate !== capture.tokenEstimate && (
            <div>
              <span className="text-cafe-muted">tokens · total (est):</span> ~
              {capture.totalTokenEstimate.toLocaleString()}
            </div>
          )}
        </div>
      </div>
      {capture.captureDiagnostics && capture.captureDiagnostics.length > 0 && (
        <div>
          <div className="font-medium text-cafe-muted">Capture Diagnostics</div>
          <ul className="ml-3 list-disc space-y-0.5">
            {keyedDiagnostics(capture.captureDiagnostics).map(({ diagnostic, key }) => (
              <li key={key}>{diagnostic}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
