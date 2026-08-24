'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface SourceOwnedLink {
  kind: 'prompt' | 'trace' | 'task';
  label: string;
  href: string;
}

async function resolvePromptLink(invocationId: string): Promise<SourceOwnedLink | undefined> {
  const query = encodeURIComponent(invocationId);
  const response = await apiFetch(`/api/debug/prompt-captures?invocationId=${query}`);
  if (!response.ok) return undefined;
  const captures = (await response.json()) as Array<{ captureId?: string }>;
  const captureId = captures[0]?.captureId;
  if (!captureId) return undefined;
  return {
    kind: 'prompt',
    label: 'Prompt X-Ray',
    href: `/api/debug/prompt-captures/${encodeURIComponent(captureId)}`,
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
  const [links, setLinks] = useState<SourceOwnedLink[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLinks([]);
    void Promise.allSettled([
      resolvePromptLink(invocationId),
      resolveTraceLink(invocationId),
      resolveTaskLink(invocationId),
    ]).then((results) => {
      if (cancelled) return;
      setLinks(results.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : [])));
    });
    return () => {
      cancelled = true;
    };
  }, [invocationId]);

  if (links.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5" data-testid="source-owned-evidence-links">
      <span className="text-micro text-cafe-muted">关联证据</span>
      {links.map((link) => (
        <a
          key={link.kind}
          href={link.href}
          className="rounded-md border border-cafe px-2 py-1 text-micro font-semibold text-cafe-secondary hover:text-cafe-accent"
          data-testid="source-owned-evidence-link"
          data-evidence-source={link.kind}
        >
          {link.label}
        </a>
      ))}
    </div>
  );
}
