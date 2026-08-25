'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { type PromptCaptureData, PromptCaptureInspector } from './PromptCaptureInspector';

interface PromptCaptureLoadResult {
  capture?: PromptCaptureData;
  error?: string;
}

export async function readPromptCapture(captureId: string): Promise<PromptCaptureData | undefined> {
  const response = await apiFetch(`/api/debug/prompt-captures/${encodeURIComponent(captureId)}`);
  if (!response.ok) return undefined;
  return (await response.json()) as PromptCaptureData;
}

async function loadInvocationPromptCapture(invocationId?: string, catId?: string): Promise<PromptCaptureLoadResult> {
  try {
    const query = new URLSearchParams();
    if (invocationId) query.set('invocationId', invocationId);
    const response = await apiFetch(`/api/debug/prompt-captures?${query}`);
    if (!response.ok) {
      return { error: response.status === 404 ? 'No captures found' : `Error ${response.status}` };
    }
    const index = (await response.json()) as Array<{ captureId: string; catId: string }>;
    const matching = catId ? index.filter((entry) => entry.catId === catId) : index;
    if (matching.length === 0) {
      return { error: 'No prompt captures for this span. Enable with PROMPT_CAPTURE=on' };
    }
    const capture = await readPromptCapture(matching[0].captureId);
    return capture ? { capture } : { error: 'Prompt capture is not readable' };
  } catch {
    return { error: 'Failed to load prompt capture' };
  }
}

export function InvocationPromptCaptureInspector({ invocationId, catId }: { invocationId?: string; catId?: string }) {
  const [result, setResult] = useState<PromptCaptureLoadResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    void loadInvocationPromptCapture(invocationId, catId).then((next) => {
      if (!cancelled) setResult(next);
    });
    return () => {
      cancelled = true;
    };
  }, [invocationId, catId]);

  if (!result) return <div className="mt-2 text-micro text-cafe-muted">Loading prompt capture...</div>;
  if (result.error) return <div className="mt-2 text-micro text-cafe-secondary">{result.error}</div>;
  if (!result.capture) return null;
  return <PromptCaptureInspector capture={result.capture} />;
}
