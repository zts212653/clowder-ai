'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { readPromptCapture } from '../../InvocationPromptCaptureInspector';
import { type PromptCaptureData, PromptCaptureInspector } from '../../PromptCaptureInspector';

interface SourceOwnedLink {
  kind: 'trace' | 'task';
  label: string;
  href: string;
}

interface SourceOwnedPrompt {
  kind: 'prompt';
  label: string;
  capture: PromptCaptureData;
}

type SourceOwnedEvidence = SourceOwnedLink | SourceOwnedPrompt;

async function resolvePromptEvidence(invocationId: string): Promise<SourceOwnedPrompt | undefined> {
  const query = encodeURIComponent(invocationId);
  const response = await apiFetch(`/api/debug/prompt-captures?invocationId=${query}`);
  if (!response.ok) return undefined;
  const captures = (await response.json()) as Array<{ captureId?: string }>;
  const captureId = captures[0]?.captureId;
  if (!captureId) return undefined;
  const capture = await readPromptCapture(captureId);
  if (!capture || capture.captureId !== captureId || capture.invocationId !== invocationId) return undefined;
  return {
    kind: 'prompt',
    label: 'Legacy Prompt X-Ray',
    capture,
  };
}

async function resolveTraceLink(invocationId: string): Promise<SourceOwnedLink | undefined> {
  const query = encodeURIComponent(invocationId);
  const response = await apiFetch(`/api/telemetry/traces?invocationId=${query}&limit=1`);
  if (!response.ok) return undefined;
  const result = (await response.json()) as { spans?: unknown[] };
  if (!result.spans?.length) return undefined;
  return {
    kind: 'trace',
    label: 'Trace',
    href: `/settings?ops=observability&obs=traces&invocationId=${query}`,
  };
}

async function resolveTaskLink(invocationId: string): Promise<SourceOwnedLink | undefined> {
  const query = encodeURIComponent(invocationId);
  const href = `/api/recall/trajectories?invocationId=${query}&limit=1`;
  const response = await apiFetch(href);
  if (!response.ok) return undefined;
  const result = (await response.json()) as { trajectories?: unknown[] };
  if (!result.trajectories?.length) return undefined;
  return { kind: 'task', label: 'Task trajectory', href };
}

export function InvocationEvidenceLinks({ invocationId }: { invocationId: string }) {
  const [evidence, setEvidence] = useState<SourceOwnedEvidence[]>([]);
  const [openPromptCaptureId, setOpenPromptCaptureId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEvidence([]);
    setOpenPromptCaptureId(null);
    void Promise.allSettled([
      resolvePromptEvidence(invocationId),
      resolveTraceLink(invocationId),
      resolveTaskLink(invocationId),
    ]).then((results) => {
      if (cancelled) return;
      setEvidence(results.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : [])));
    });
    return () => {
      cancelled = true;
    };
  }, [invocationId]);

  if (evidence.length === 0) return null;
  const prompt = evidence.find((item): item is SourceOwnedPrompt => item.kind === 'prompt');
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-1.5" data-testid="source-owned-evidence-links">
        <span className="text-micro text-cafe-muted">关联证据</span>
        {evidence.map((item) =>
          item.kind === 'prompt' ? (
            <button
              key={item.kind}
              type="button"
              aria-expanded={openPromptCaptureId === item.capture.captureId}
              onClick={() =>
                setOpenPromptCaptureId((current) =>
                  current === item.capture.captureId ? null : item.capture.captureId,
                )
              }
              className="rounded-md border border-cafe px-2 py-1 text-micro font-semibold text-cafe-secondary hover:text-cafe-accent"
              data-testid="source-owned-evidence-link"
              data-evidence-source={item.kind}
            >
              {item.label}
            </button>
          ) : (
            <a
              key={item.kind}
              href={item.href}
              className="rounded-md border border-cafe px-2 py-1 text-micro font-semibold text-cafe-secondary hover:text-cafe-accent"
              data-testid="source-owned-evidence-link"
              data-evidence-source={item.kind}
            >
              {item.label}
            </a>
          ),
        )}
      </div>
      {prompt && openPromptCaptureId === prompt.capture.captureId && (
        <PromptCaptureInspector capture={prompt.capture} />
      )}
    </div>
  );
}
