import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resolveContextContinuity,
  resolveInvocationOrigin,
  supportsPreProviderContinuityCapability,
} from '../dist/domains/cats/services/agents/invocation/context-continuity.js';

const CODEX_EXEC = {
  provider: 'openai',
  carrier: 'exec_json',
  reportsRuntimeWindow: true,
  authoritativeUsage: true,
  usageTelemetry: 'available',
  nativeWindowControl: true,
  nativeCompressionControl: true,
  observesCompression: true,
  reason: 'fixture',
};

describe('F296 B0 context continuity handshake', () => {
  it('keeps provider carrier, invocation origin and route topology independent', () => {
    const result = resolveContextContinuity({
      capability: CODEX_EXEC,
      invocationId: 'invocation-coordinate',
      invocationOrigin: 'scheduled',
      routeTopology: 'parallel',
    });

    assert.deepEqual(result.coordinate, {
      providerCarrier: { provider: 'codex', carrier: 'exec_json' },
      invocationOrigin: 'scheduled',
      routeTopology: 'parallel',
    });
    assert.deepEqual(result.disposition, {
      state: 'fresh',
      reason: 'no_prior_session',
      evidenceRef: 'context-continuity:invocation-coordinate:codex:exec_json:fresh:no_prior_session',
    });
  });

  it('does not treat a requested Codex exec_json session as resume proof', () => {
    const result = resolveContextContinuity({
      capability: CODEX_EXEC,
      invocationId: 'invocation-resume-request',
      requestedRuntimeSessionId: 'secret-runtime-session',
      invocationOrigin: 'interactive',
      routeTopology: 'serial',
    });

    assert.deepEqual(result.disposition, {
      state: 'unknown',
      reason: 'signal_unavailable',
      evidenceRef: 'context-continuity:invocation-resume-request:codex:exec_json:unknown:signal_unavailable',
    });
    assert.equal(result.disposition.evidenceRef.includes('secret-runtime-session'), false);
  });

  it('fails an unregistered carrier closed without borrowing a nearby provider identity', () => {
    const result = resolveContextContinuity({
      capability: { ...CODEX_EXEC, provider: 'future-openai', carrier: 'mystery' },
      invocationId: 'invocation-unknown',
      requestedRuntimeSessionId: 'runtime-1',
      invocationOrigin: 'unknown',
      routeTopology: 'independent',
    });

    assert.deepEqual(result.coordinate.providerCarrier, {
      provider: 'unknown',
      carrier: 'unknown',
      rawProvider: 'future-openai',
      rawCarrier: 'mystery',
    });
    assert.equal(result.disposition.state, 'unknown');
    assert.equal(result.disposition.reason, 'carrier_unsupported');
  });

  it('maps only provenance that the existing ingress contract can prove', () => {
    assert.equal(resolveInvocationOrigin('direct_owner'), 'interactive');
    assert.equal(resolveInvocationOrigin('connector'), 'connector');
    assert.equal(resolveInvocationOrigin('queue_replay'), 'unknown');
    assert.equal(resolveInvocationOrigin('system'), 'unknown');
  });

  it('exposes the same exact carrier support predicate used by presentation retry admission', () => {
    assert.equal(supportsPreProviderContinuityCapability(CODEX_EXEC), true);
    assert.equal(supportsPreProviderContinuityCapability({ ...CODEX_EXEC, carrier: 'app_server' }), false);
    assert.equal(
      supportsPreProviderContinuityCapability({ ...CODEX_EXEC, provider: 'anthropic', carrier: 'print_sdk' }),
      false,
    );
  });
});
