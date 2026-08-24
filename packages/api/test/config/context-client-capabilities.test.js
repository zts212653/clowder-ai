/** #1208 concrete-carrier capability and authoritative-usage coverage. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { resolveAuthoritativeContextUsage } = await import(
  '../../dist/domains/cats/services/agents/invocation/invocation-capacity-snapshot.js'
);
const { resolveContextLifecycleSupport, resolveSessionExecutionStatus } = await import(
  '../../dist/domains/cats/services/agents/context-lifecycle-capability.js'
);
const [
  { A2AAgentService },
  { ClaudeAgentService },
  { ClaudeBgCarrierService },
  { ClaudeInteractivePtyCarrierService },
  { CodexAgentService },
  { GeminiAgentService },
  { KimiAgentService },
  { OpenCodeAgentService },
  { AntigravityAgentService },
  { CatAgentService },
  { AcpAgentService },
] = await Promise.all([
  import('../../dist/domains/cats/services/agents/providers/A2AAgentService.js'),
  import('../../dist/domains/cats/services/agents/providers/ClaudeAgentService.js'),
  import('../../dist/domains/cats/services/agents/providers/ClaudeBgCarrierService.js'),
  import('../../dist/domains/cats/services/agents/providers/ClaudeInteractivePtyCarrierService.js'),
  import('../../dist/domains/cats/services/agents/providers/CodexAgentService.js'),
  import('../../dist/domains/cats/services/agents/providers/GeminiAgentService.js'),
  import('../../dist/domains/cats/services/agents/providers/KimiAgentService.js'),
  import('../../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js'),
  import('../../dist/domains/cats/services/agents/providers/antigravity/AntigravityAgentService.js'),
  import('../../dist/domains/cats/services/agents/providers/catagent/CatAgentService.js'),
  import('../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js'),
]);

const baseCapability = {
  provider: 'test',
  carrier: 'test_carrier',
  reportsRuntimeWindow: true,
  authoritativeUsage: true,
  usageTelemetry: 'available',
  nativeWindowControl: false,
  nativeCompressionControl: false,
  observesCompression: false,
  reason: 'test',
};

describe('#1208 concrete carrier usage authority', () => {
  it('prefers the carrier current-context counter', () => {
    assert.deepEqual(
      resolveAuthoritativeContextUsage(
        { contextUsedTokens: 85_000, lastTurnInputTokens: 80_000, inputTokens: 500_000 },
        baseCapability,
      ),
      { usedTokens: 85_000, usedFrom: 'context' },
    );
  });

  it('accepts non-cumulative last-turn input from a capable carrier', () => {
    assert.deepEqual(resolveAuthoritativeContextUsage({ lastTurnInputTokens: 85_000 }, baseCapability), {
      usedTokens: 85_000,
      usedFrom: 'last_turn',
    });
  });

  it('rejects aggregate inputTokens and totalTokens as context health', () => {
    assert.equal(
      resolveAuthoritativeContextUsage(
        { inputTokens: 85_000, totalTokens: 90_000, isCumulativeUsage: true },
        baseCapability,
      ),
      undefined,
    );
  });

  it('rejects usage when the concrete carrier does not declare authority', () => {
    assert.equal(
      resolveAuthoritativeContextUsage({ contextUsedTokens: 85_000 }, { ...baseCapability, authoritativeUsage: false }),
      undefined,
    );
  });

  it('accepts separately extracted last-turn input when aggregate counters are cumulative', () => {
    assert.deepEqual(
      resolveAuthoritativeContextUsage(
        { inputTokens: 500_000, totalTokens: 510_000, lastTurnInputTokens: 85_000, isCumulativeUsage: true },
        baseCapability,
      ),
      { usedTokens: 85_000, usedFrom: 'last_turn' },
    );
  });
});

describe('#1208 lifecycle prerequisites', () => {
  it('usage without a compression setter permits handoff only', () => {
    const capability = { ...baseCapability, nativeCompressionControl: false };
    assert.equal(resolveContextLifecycleSupport(capability, 'handoff').supported, true);
    assert.equal(resolveContextLifecycleSupport(capability, 'compress').supported, false);
    assert.equal(resolveContextLifecycleSupport(capability, 'hybrid').supported, false);
  });

  it('a setter without proven usage cannot permit percentage lifecycle actions', () => {
    const capability = {
      ...baseCapability,
      authoritativeUsage: false,
      usageTelemetry: 'unavailable',
      nativeCompressionControl: true,
      observesCompression: true,
    };
    assert.equal(resolveContextLifecycleSupport(capability, 'handoff').supported, false);
    assert.equal(resolveContextLifecycleSupport(capability, 'compress').supported, false);
    assert.equal(resolveContextLifecycleSupport(capability, 'hybrid').supported, false);
  });

  it('hybrid additionally requires observable native compression events', () => {
    const capability = { ...baseCapability, nativeCompressionControl: true, observesCompression: false };
    assert.equal(resolveContextLifecycleSupport(capability, 'compress').supported, true);
    assert.equal(resolveContextLifecycleSupport(capability, 'hybrid').supported, false);
  });
});

describe('#1329 policy-preserving execution status', () => {
  const completeHandoffEvidence = {
    managedInvocationBoundary: true,
    effectiveInputCeiling: true,
    carrierBinding: true,
    authoritativeUsage: true,
    sessionRotation: true,
    continuityBootstrap: true,
    observesCompression: true,
  };

  it('reports every missing handoff proof with stable reason codes', () => {
    assert.deepEqual(
      resolveSessionExecutionStatus('handoff', {
        ...completeHandoffEvidence,
        carrierBinding: false,
        authoritativeUsage: false,
        continuityBootstrap: false,
      }),
      {
        status: 'unavailable',
        missingCapabilities: ['carrier_binding', 'authoritative_usage', 'continuity_bootstrap'],
      },
    );
  });

  it('keeps hybrid executable as compress-only degradation when compression events are missing', () => {
    assert.deepEqual(
      resolveSessionExecutionStatus('hybrid', {
        ...completeHandoffEvidence,
        observesCompression: false,
      }),
      {
        status: 'degraded',
        missingCapabilities: ['compression_signal'],
      },
    );
  });

  it('does not require authoritative usage for an active compress policy', () => {
    assert.deepEqual(
      resolveSessionExecutionStatus('compress', {
        ...completeHandoffEvidence,
        authoritativeUsage: false,
      }),
      { status: 'active', missingCapabilities: [] },
    );
  });

  it('keeps compress active at a managed boundary with no lifecycle capabilities', () => {
    assert.deepEqual(
      resolveSessionExecutionStatus('compress', {
        managedInvocationBoundary: true,
        effectiveInputCeiling: false,
        carrierBinding: false,
        authoritativeUsage: false,
        sessionRotation: false,
        continuityBootstrap: false,
        observesCompression: false,
      }),
      { status: 'active', missingCapabilities: [] },
    );
  });

  it('makes an unmanaged external boundary unavailable without changing policy', () => {
    assert.deepEqual(
      resolveSessionExecutionStatus('hybrid', {
        ...completeHandoffEvidence,
        managedInvocationBoundary: false,
      }),
      {
        status: 'unavailable',
        missingCapabilities: ['managed_invocation_boundary'],
      },
    );
  });
});

describe('#1208 concrete Client/carrier capability matrix', () => {
  const call = (Service, state = {}) => Service.prototype.contextCapability.call(state);
  const rows = [
    ['anthropic/print', call(ClaudeAgentService), 'available', true, false, false, true],
    ['anthropic/bg', call(ClaudeBgCarrierService), 'available', true, false, false, true],
    ['anthropic/pty', call(ClaudeInteractivePtyCarrierService), 'unavailable', false, false, false, false],
    ['openai/exec_json', call(CodexAgentService, { carrierMode: 'exec_json' }), 'available', true, true, true, true],
    [
      // F296 B4b: observesCompression flipped to true. Earned by the Gate 0
      // dynamic probe against a real codex app-server (codex-cli 0.147.0,
      // 2026-08-20), which observed an actual `contextCompaction` item, its
      // `(threadId, turnId, item.id)` envelope binding, and a consumable window
      // before the next `turn/start`. Usage telemetry is still unproven, so
      // every other column stays false.
      // See docs/features/evidence/F296/gate0-app-server-dynamic-probe.md
      'openai/app_server',
      call(CodexAgentService, { carrierMode: 'app_server' }),
      'unavailable',
      false,
      false,
      false,
      true,
    ],
    ['google/cli', call(GeminiAgentService, { adapter: 'gemini-cli' }), 'available', true, false, false, true],
    [
      'google/antigravity',
      call(GeminiAgentService, { adapter: 'antigravity' }),
      'unavailable',
      false,
      false,
      false,
      false,
    ],
    ['kimi/cli', call(KimiAgentService), 'available', true, false, false, true],
    ['opencode/cli', call(OpenCodeAgentService), 'available', true, true, true, false],
    ['antigravity/bridge', call(AntigravityAgentService), 'unavailable', false, false, false, false],
    ['catagent/direct', call(CatAgentService), 'available', true, false, false, false],
    ['a2a/remote', call(A2AAgentService), 'unavailable', false, false, false, false],
    [
      'generic/acp-before-usage',
      call(AcpAgentService, { providerName: 'acp', observedUsageUpdate: false }),
      'conditional',
      true,
      false,
      false,
      false,
    ],
    [
      'generic/acp-after-usage',
      call(AcpAgentService, { providerName: 'acp', observedUsageUpdate: true }),
      'available',
      true,
      false,
      false,
      false,
    ],
    [
      'kimi/acp-after-usage',
      call(AcpAgentService, { providerName: 'kimi', observedUsageUpdate: true }),
      'available',
      true,
      true,
      false,
      false,
    ],
    [
      'opencode/acp-after-usage',
      call(AcpAgentService, { providerName: 'opencode', observedUsageUpdate: true }),
      'available',
      true,
      true,
      false,
      false,
    ],
  ];

  for (const [
    name,
    capability,
    usageTelemetry,
    authoritativeUsage,
    nativeWindowControl,
    nativeCompressionControl,
    observesCompression,
  ] of rows) {
    it(name, () => {
      assert.equal(capability.usageTelemetry, usageTelemetry);
      assert.equal(capability.authoritativeUsage, authoritativeUsage);
      assert.equal(capability.nativeWindowControl, nativeWindowControl);
      assert.equal(capability.nativeCompressionControl, nativeCompressionControl);
      assert.equal(capability.observesCompression, observesCompression);
      assert.ok(capability.provider);
      assert.ok(capability.carrier);
      assert.ok(capability.reason);
    });
  }
});
