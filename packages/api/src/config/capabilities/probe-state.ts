import type { ProbeState } from '@cat-cafe/shared';

interface ProbeResult {
  connectionStatus: 'connected' | 'disconnected' | 'unknown';
  tools?: Array<{ name: string; description?: string }>;
  error?: string;
}

interface ProbeContext {
  declaredTools?: string[];
}

export interface ToolDiff {
  hasMismatch: boolean;
  missing: string[];
  extra: string[];
}

export function computeToolDiff(declared: string[], probed: string[]): ToolDiff {
  if (declared.length === 0) {
    return { hasMismatch: false, missing: [], extra: [] };
  }
  const declaredSet = new Set(declared);
  const probedSet = new Set(probed);
  const missing = declared.filter((t) => !probedSet.has(t));
  const extra = probed.filter((t) => !declaredSet.has(t));
  return {
    hasMismatch: missing.length > 0 || extra.length > 0,
    missing,
    extra,
  };
}

export function buildProbeState(result: ProbeResult, context?: ProbeContext): ProbeState {
  const now = new Date().toISOString();

  if (result.connectionStatus === 'unknown') {
    return { status: 'not_probed', lastProbed: now };
  }

  if (result.connectionStatus === 'disconnected') {
    return {
      status: 'probe_failed',
      lastProbed: now,
      failureReason: result.error || 'connection failed',
    };
  }

  const probedTools = (result.tools ?? []).map((t) => t.name);

  if (context?.declaredTools && context.declaredTools.length > 0) {
    const diff = computeToolDiff(context.declaredTools, probedTools);
    if (diff.hasMismatch) {
      return {
        status: 'probe_failed',
        lastProbed: now,
        failureReason: `tool mismatch: missing=[${diff.missing.join(',')}] extra=[${diff.extra.join(',')}]`,
        declaredTools: context.declaredTools,
        probedTools,
      };
    }
  }

  return {
    status: 'ready',
    lastProbed: now,
    probedTools,
    ...(context?.declaredTools ? { declaredTools: context.declaredTools } : {}),
  };
}
