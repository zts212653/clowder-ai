import type {
  AgentContextCapability,
  ContextContinuityHandshake,
  ContextCoordinate,
  ContinuityDisposition,
  InvocationOrigin,
  ProviderCarrier,
  ProviderContinuityEvidence,
  RouteTopology,
} from '../../types.js';
import type { HumanDispositionInvocationOrigin } from '../routing/human-disposition-invocation-origin.js';

function unknownCarrier(capability: AgentContextCapability): ProviderCarrier {
  return {
    provider: 'unknown',
    carrier: 'unknown',
    ...(capability.provider ? { rawProvider: capability.provider } : {}),
    ...(capability.carrier ? { rawCarrier: capability.carrier } : {}),
  };
}

const PROVIDER_CARRIERS: Readonly<Record<string, ProviderCarrier>> = Object.freeze({
  'anthropic\0print_sdk': { provider: 'claude', carrier: 'print_sdk' },
  'anthropic\0bg': { provider: 'claude', carrier: 'bg_daemon' },
  'anthropic\0interactive_pty': { provider: 'claude', carrier: 'interactive_pty' },
  'anthropic\0api_key': { provider: 'claude', carrier: 'api_key' },
  'openai\0exec_json': { provider: 'codex', carrier: 'exec_json' },
  'openai\0app_server': { provider: 'codex', carrier: 'app_server' },
  'google\0gemini_cli': { provider: 'gemini', carrier: 'gemini_cli' },
  'google\0antigravity': { provider: 'gemini', carrier: 'antigravity_adapter' },
  'google\0antigravity-cli': { provider: 'gemini', carrier: 'antigravity_adapter' },
  'antigravity\0cdp_bridge': { provider: 'antigravity', carrier: 'cdp_bridge' },
  'kimi\0stream_json': { provider: 'kimi', carrier: 'stream_json' },
  'opencode\0run_json': { provider: 'opencode', carrier: 'run_json' },
  'catagent\0direct_api': { provider: 'catagent', carrier: 'direct_api' },
  'a2a\0a2a': { provider: 'a2a', carrier: 'remote' },
});

export function resolveProviderCarrier(capability: AgentContextCapability): ProviderCarrier {
  const { provider, carrier } = capability;
  if (carrier === 'acp') {
    return { provider: 'acp', carrier: 'acp', backend: provider === 'opencode' ? 'opencode' : 'unknown' };
  }
  return PROVIDER_CARRIERS[`${provider}\0${carrier}`] ?? unknownCarrier(capability);
}

export function resolveInvocationOrigin(origin: HumanDispositionInvocationOrigin | undefined): InvocationOrigin {
  if (origin === 'direct_owner') return 'interactive';
  if (origin === 'connector') return 'connector';
  return 'unknown';
}

function evidenceRef(
  invocationId: string,
  providerCarrier: ProviderCarrier,
  state: 'fresh' | 'unknown',
  reason: 'no_prior_session' | 'signal_unavailable' | 'carrier_unsupported',
): string {
  return ['context-continuity', invocationId, providerCarrier.provider, providerCarrier.carrier, state, reason].join(
    ':',
  );
}

export function resolveContextContinuity(input: {
  readonly capability: AgentContextCapability;
  readonly invocationId: string;
  readonly requestedRuntimeSessionId?: string;
  readonly freshReason?: 'no_prior_session' | 'resume_rejected' | 'resume_failed' | 'carrier_forces_fresh';
  readonly invocationOrigin: InvocationOrigin;
  readonly routeTopology: RouteTopology;
  /**
   * F296 B4a: the invocation will route this call through the adapter's
   * provider-owned preflight seam, so the real verdict arrives later. Without
   * it, a preflight-capable carrier stays `carrier_unsupported` — declaring the
   * seam is not the same as using it.
   */
  readonly providerPreflightAvailable?: boolean;
}): ContextContinuityHandshake {
  const providerCarrier = resolveProviderCarrier(input.capability);
  const coordinate = {
    providerCarrier,
    invocationOrigin: input.invocationOrigin,
    routeTopology: input.routeTopology,
  } as const;

  if (input.providerPreflightAvailable && carrierHasProviderContinuityPreflight(providerCarrier)) {
    // The provider has not spoken yet. Claiming anything here would be exactly
    // the "binding equality means resumed" mistake; the adapter mints the real
    // disposition in `settle`.
    return {
      coordinate,
      disposition: {
        state: 'unknown',
        reason: 'signal_unavailable',
        evidenceRef: evidenceRef(input.invocationId, providerCarrier, 'unknown', 'signal_unavailable'),
      },
    };
  }

  if (providerCarrier.provider !== 'codex' || providerCarrier.carrier !== 'exec_json') {
    return {
      coordinate,
      disposition: {
        state: 'unknown',
        reason: 'carrier_unsupported',
        evidenceRef: evidenceRef(input.invocationId, providerCarrier, 'unknown', 'carrier_unsupported'),
      },
    };
  }

  if (!input.requestedRuntimeSessionId) {
    const reason = input.freshReason ?? 'no_prior_session';
    return {
      coordinate,
      disposition: {
        state: 'fresh',
        reason,
        evidenceRef: [
          'context-continuity',
          input.invocationId,
          providerCarrier.provider,
          providerCarrier.carrier,
          'fresh',
          reason,
        ].join(':'),
      },
    };
  }

  // exec_json only reports the actual runtime after the prompt has crossed the
  // provider boundary. A persisted binding proves what we intend to request,
  // not that the provider resumed it, so this carrier must remain cold-first.
  return {
    coordinate,
    disposition: {
      state: 'unknown',
      reason: 'signal_unavailable',
      evidenceRef: evidenceRef(input.invocationId, providerCarrier, 'unknown', 'signal_unavailable'),
    },
  };
}

/**
 * F296 B4a: carriers with a dynamically proven pre-prompt continuity seam.
 *
 * `codex/app_server` qualifies because Gate 0 (2026-08-20, codex-cli 0.147.0)
 * observed on a real app-server that `thread/start` and `thread/resume` return
 * a trustworthy runtime id strictly before `turn/start`, and that a stale
 * resume is rejected outright rather than silently substituted.
 */
export function carrierHasProviderContinuityPreflight(providerCarrier: ProviderCarrier): boolean {
  return providerCarrier.provider === 'codex' && providerCarrier.carrier === 'app_server';
}

export function supportsProviderContinuityPreflight(handshake: ContextContinuityHandshake): boolean {
  return carrierHasProviderContinuityPreflight(handshake.coordinate.providerCarrier);
}

/**
 * F296 B4a: normalize adapter-observed provider evidence into a disposition.
 *
 * This is the ONLY way `resumed` or `replaced` enter the system. It reads the
 * evidence and nothing else — not a persisted binding, not a token drop, not a
 * scratchpad. A resume response for a different id becomes
 * `unknown/binding_mismatch`, never `resumed`.
 */
export function continuityDispositionFromProviderEvidence(input: {
  readonly evidence: ProviderContinuityEvidence;
  readonly coordinate: ContextCoordinate;
  readonly invocationId: string;
  readonly freshReason?: 'no_prior_session' | 'resume_rejected' | 'resume_failed' | 'carrier_forces_fresh';
}): ContinuityDisposition {
  const { evidence } = input;
  const { providerCarrier } = input.coordinate;
  const ref = (state: string, reason: string): string =>
    ['context-continuity', input.invocationId, providerCarrier.provider, providerCarrier.carrier, state, reason].join(
      ':',
    );

  switch (evidence.kind) {
    case 'started': {
      const reason = input.freshReason ?? 'no_prior_session';
      return {
        state: 'fresh',
        reason,
        evidenceRef: ref('fresh', reason),
        runtimeSessionId: evidence.runtimeSessionId,
      };
    }
    case 'resumed':
      return {
        state: 'resumed',
        reason: 'resume_confirmed',
        evidenceRef: ref('resumed', 'resume_confirmed'),
        runtimeSessionId: evidence.runtimeSessionId,
      };
    case 'replaced':
      return {
        state: 'replaced',
        reason: 'runtime_replaced',
        evidenceRef: ref('replaced', 'runtime_replaced'),
        previousRuntimeSessionId: evidence.requestedRuntimeSessionId,
        runtimeSessionId: evidence.runtimeSessionId,
      };
    case 'mismatched':
      return {
        state: 'unknown',
        reason: 'binding_mismatch',
        evidenceRef: ref('unknown', 'binding_mismatch'),
      };
    case 'unavailable':
      return {
        state: 'unknown',
        reason: evidence.reason,
        evidenceRef: ref('unknown', evidence.reason),
      };
  }
}

export function supportsPreProviderContinuityHandshake(handshake: ContextContinuityHandshake): boolean {
  const providerCarrier = handshake.coordinate.providerCarrier;
  return providerCarrier.provider === 'codex' && providerCarrier.carrier === 'exec_json';
}

/** Whether F296 can make its pre-provider continuity decision on this concrete carrier. */
export function supportsPreProviderContinuityCapability(capability: AgentContextCapability): boolean {
  const providerCarrier = resolveProviderCarrier(capability);
  return providerCarrier.provider === 'codex' && providerCarrier.carrier === 'exec_json';
}
