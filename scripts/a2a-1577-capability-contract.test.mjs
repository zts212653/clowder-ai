import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FRESHNESS_CARRIER_PROVIDERS,
  FRESHNESS_CARRIERS,
  parseFreshnessCarrierCapability,
  supportsActiveInvocationGuidance,
} from '../packages/shared/src/types/queue-receipt.ts';

test('merged freshness vocabulary retains fork opencode and public google/agy without implying append support', () => {
  for (const [provider, carrier] of [
    ['opencode', 'mcp_result_piggyback'],
    ['google', 'agy_stream_json'],
  ]) {
    assert.ok(FRESHNESS_CARRIER_PROVIDERS.includes(provider));
    assert.ok(FRESHNESS_CARRIERS.includes(carrier));
    assert.equal(parseFreshnessCarrierCapability({ provider, carrier, deliverySemantics: 'undeclared' }), undefined);
    const declared = parseFreshnessCarrierCapability({
      provider,
      carrier,
      deliverySemantics: 'mcp_result_piggyback',
      activeInvocationGuidance: 'unsupported',
    });
    assert.equal(declared?.provider, provider);
    assert.equal(supportsActiveInvocationGuidance(declared), false);
  }
});

test('unknown carriers and malformed guidance declarations still fail closed', () => {
  for (const change of [
    { carrier: 'prose_guessed' },
    { provider: 'unknown' },
    { activeInvocationGuidance: true },
    { deliverySemantics: 'accepted' },
  ]) {
    assert.equal(
      parseFreshnessCarrierCapability({
        provider: 'openai_codex',
        carrier: 'codex_app_server',
        deliverySemantics: 'exact_active_turn',
        activeInvocationGuidance: 'supported',
        ...change,
      }),
      undefined,
    );
  }
});
