'use client';

import { useEffect, useRef, useState } from 'react';
import { DEMO_DELIVERABLE_HTML } from '../onboarding-demo/demo-deliverable';
import type { DemoPreviewStage } from '../onboarding-demo/demo-story';

const stages: Record<DemoPreviewStage, string> = {
  waiting: '等待设计',
  design: '设计草图',
  architecture: '方案整合',
  initial: '初版实现',
  review: '审查与修正',
  final: '已完善 · 可操作',
};

/** Only a fixed, bundled page can enter this mode; it never probes local services. */
export function BundledDemoBrowser({ onReady, stage = 'final' }: { onReady?: () => void; stage?: DemoPreviewStage }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const readyCallback = useRef(onReady);
  readyCallback.current = onReady;
  const [attempt, setAttempt] = useState(0);
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
  }, [attempt]);
  useEffect(() => {
    if (!loaded) return;
    setStatus('loading');
    ackTimer.current = setTimeout(() => setStatus('failed'), 10_000);
    frame.current?.contentWindow?.postMessage({ type: 'clowder-onboarding-stage', version: 1, stage }, '*');
    return () => {
      if (ackTimer.current) clearTimeout(ackTimer.current);
    };
  }, [stage, loaded, attempt]);
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="演示成果浏览器" data-preview-stage={stage}>
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--console-border-soft)] bg-[var(--console-panel-bg)] px-4 py-3 text-xs">
        <span className="font-semibold">浏览器 · 今天待办</span>
        <span className="min-w-0 flex-1 rounded px-2 py-1 text-cafe-secondary">{stages[stage]}</span>
        <button
          type="button"
          onClick={() => setAttempt((value) => value + 1)}
          className="rounded-lg border border-[var(--console-border-soft)] px-3 py-1.5"
        >
          重新打开
        </button>
      </div>
      {status !== 'ready' && (
        <div
          role="status"
          className="bg-[var(--semantic-warning-surface)] px-4 py-2 text-sm text-[var(--semantic-warning)]"
        >
          {status === 'loading' ? '正在打开成果…' : '成果暂时没有打开。请点击“重新打开”，无需安装或登录任何工具。'}
        </div>
      )}
      <iframe
        key={attempt}
        ref={frame}
        title="今天待办 · 演示成果"
        srcDoc={DEMO_DELIVERABLE_HTML}
        sandbox="allow-scripts"
        onError={() => setStatus('failed')}
        className="min-h-0 w-full flex-1 border-0 bg-[var(--console-card-bg)]"
      />
    </section>
  );
}
