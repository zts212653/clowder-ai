'use client';

import { useEffect, useRef, useState } from 'react';
import { getDemoDeliverableHtml } from '../onboarding-demo/demo-deliverable';
import type { DemoPreviewStage } from '../onboarding-demo/demo-story';
import { onboardingPlayerCopy } from '../onboarding-demo/onboarding-player.shell-copy';
import { useShellCopy } from '../shell/shell-copy';
import { useShellLanguage } from '../shell/shell-language';

/** Only a fixed, bundled page can enter this mode; it never probes local services. */
export function BundledDemoBrowser({ onReady, stage = 'final' }: { onReady?: () => void; stage?: DemoPreviewStage }) {
  const language = useShellLanguage();
  const t = useShellCopy(onboardingPlayerCopy);
  const frame = useRef<HTMLIFrameElement>(null);
  const readyCallback = useRef(onReady);
  readyCallback.current = onReady;
  const [attempt, setAttempt] = useState(() => ({ id: 0, html: getDemoDeliverableHtml(language) }));
  const [loaded, setLoaded] = useState(false);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const ackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => {
    setStatus('loading');
    setLoaded(false);
    const timeout = setTimeout(() => setStatus('failed'), 10_000);
    const receive = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (
        event.source !== frame.current?.contentWindow ||
        !data ||
        typeof data !== 'object' ||
        !('type' in data) ||
        !('version' in data) ||
        data.version !== 1
      )
        return;
      if (data.type === 'clowder-onboarding-stage-ready' && 'stage' in data && data.stage === stageRef.current) {
        if (ackTimer.current) clearTimeout(ackTimer.current);
        setStatus('ready');
        if (data.stage === 'final') readyCallback.current?.();
        return;
      }
      if (data.type !== 'clowder-onboarding-ready') return;
      clearTimeout(timeout);
      setLoaded(true);
    };
    window.addEventListener('message', receive);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener('message', receive);
    };
  }, [attempt.id]);
  useEffect(() => {
    if (!loaded) return;
    setStatus('loading');
    ackTimer.current = setTimeout(() => setStatus('failed'), 10_000);
    frame.current?.contentWindow?.postMessage({ type: 'clowder-onboarding-stage', version: 1, stage, language }, '*');
    return () => {
      if (ackTimer.current) clearTimeout(ackTimer.current);
    };
  }, [stage, loaded, attempt.id, language]);
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t.browser} data-preview-stage={stage}>
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--console-border-soft)] bg-[var(--console-panel-bg)] px-4 py-3 text-xs">
        <span className="font-semibold">{t.browserTitle}</span>
        <span className="min-w-0 flex-1 rounded px-2 py-1 text-cafe-secondary">{t.stages[stage]}</span>
        <button
          type="button"
          onClick={() => setAttempt((value) => ({ id: value.id + 1, html: getDemoDeliverableHtml(language) }))}
          className="rounded-lg border border-[var(--console-border-soft)] px-3 py-1.5"
        >
          {t.reopen}
        </button>
      </div>
      {status !== 'ready' && (
        <div
          role="status"
          className="bg-[var(--semantic-warning-surface)] px-4 py-2 text-sm text-[var(--semantic-warning)]"
        >
          {status === 'loading' ? t.opening : t.failed}
        </div>
      )}
      <iframe
        key={attempt.id}
        ref={frame}
        title={t.documentTitle}
        srcDoc={attempt.html}
        sandbox="allow-scripts"
        onError={() => setStatus('failed')}
        className="min-h-0 w-full flex-1 border-0 bg-[var(--console-card-bg)]"
      />
    </section>
  );
}
