import type {
  AgentContextCapability,
  ContextContinuityHandshake,
  InvocationOrigin,
  ProviderCarrier,
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
}): ContextContinuityHandshake {
  const providerCarrier = resolveProviderCarrier(input.capability);
  const coordinate = {
    providerCarrier,
    invocationOrigin: input.invocationOrigin,
    routeTopology: input.routeTopology,
  } as const;

  if (providerCarrier.provider !== 'codex' || providerCarrier.carrier !== 'exec_json') {
    return {
      coordinate,
      disposition: {
        state: 'unknown',
        reason: 'carrier_unsupported',
        evidenceRef: evidenceRef(input.invocationId, providerCarrier, 'unknown', 'carrier_unsupported'),
      },
      contextMode: 'cold',
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
      contextMode: 'cold',
    };
  }

  return {
    coordinate,
    disposition: {
      state: 'unknown',
      reason: 'signal_unavailable',
      evidenceRef: evidenceRef(input.invocationId, providerCarrier, 'unknown', 'signal_unavailable'),
    },
    contextMode: 'cold',
  };
}

export function supportsPreProviderContinuityHandshake(handshake: ContextContinuityHandshake): boolean {
  return (
    handshake.coordinate.providerCarrier.provider === 'codex' &&
    handshake.coordinate.providerCarrier.carrier === 'exec_json'
  );
}
