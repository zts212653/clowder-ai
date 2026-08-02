import assert from 'node:assert/strict';
import test from 'node:test';
import {
  builtinAccountFamilyForClient,
  builtinAccountIdForClient,
  effectiveClientFamilyForCat,
  effectiveProtocolForCat,
  protocolForClient,
} from '../dist/index.js';

// ── Client-level default mapping (KD-24: PRESERVED unchanged, no catConfig) ──

test('catagent shares anthropic builtin account family', () => {
  assert.equal(builtinAccountFamilyForClient('catagent'), 'anthropic');
  assert.equal(builtinAccountIdForClient('catagent'), 'claude');
});

test('protocolForClient normalizes provider family routing', () => {
  // F159 Phase G G2 KD-24: this assertion is intentionally preserved AS-IS.
  // protocolForClient is the pure client-level default; the G2 catagent
  // protocol-aware answer lives on effectiveProtocolForCat below.
  assert.equal(protocolForClient('catagent'), 'anthropic');
  assert.equal(protocolForClient('opencode'), 'anthropic');
  assert.equal(protocolForClient('antigravity'), null);
});

// ── F159 Phase G G2 Axis 3 (AC-G18 / KD-24): member-level effective helpers ──

function catagentConfig(catAgentProtocol) {
  return { id: 'opus', clientId: 'catagent', catAgentProtocol };
}

test('effectiveProtocolForCat: catagent + no catAgentProtocol → anthropic (G1 backward-compat)', () => {
  assert.equal(effectiveProtocolForCat({ id: 'opus', clientId: 'catagent' }), 'anthropic');
});

test('effectiveProtocolForCat: catagent + anthropic-messages → anthropic', () => {
  assert.equal(effectiveProtocolForCat(catagentConfig('anthropic-messages')), 'anthropic');
});

test('effectiveProtocolForCat: catagent + openai-chat → openai (G2 wire protocol override)', () => {
  assert.equal(effectiveProtocolForCat(catagentConfig('openai-chat')), 'openai');
});

test('effectiveProtocolForCat: non-catagent falls through to protocolForClient', () => {
  assert.equal(effectiveProtocolForCat({ id: 'codex', clientId: 'openai' }), 'openai');
  assert.equal(effectiveProtocolForCat({ id: 'opus', clientId: 'anthropic' }), 'anthropic');
  assert.equal(effectiveProtocolForCat({ id: 'gemini', clientId: 'google' }), 'google');
  assert.equal(effectiveProtocolForCat({ id: 'agy', clientId: 'antigravity' }), null);
});

test('effectiveProtocolForCat: non-catagent ignores catAgentProtocol (only meaningful for catagent)', () => {
  // Even if catAgentProtocol leaks onto a non-catagent CatConfig (it shouldn't
  // per truth-source gating, but defense-in-depth at the routing helper), it
  // does NOT change the protocol — that's strictly a catagent-only switch.
  assert.equal(effectiveProtocolForCat({ id: 'codex', clientId: 'openai', catAgentProtocol: 'openai-chat' }), 'openai');
  assert.equal(
    effectiveProtocolForCat({ id: 'opus', clientId: 'anthropic', catAgentProtocol: 'openai-chat' }),
    'anthropic',
  );
});

test('effectiveClientFamilyForCat: catagent + openai-chat → openai (account family override)', () => {
  assert.equal(effectiveClientFamilyForCat(catagentConfig('openai-chat')), 'openai');
});

test('effectiveClientFamilyForCat: catagent default (no catAgentProtocol) → anthropic', () => {
  assert.equal(effectiveClientFamilyForCat({ id: 'opus', clientId: 'catagent' }), 'anthropic');
  assert.equal(effectiveClientFamilyForCat(catagentConfig('anthropic-messages')), 'anthropic');
});

test('effectiveClientFamilyForCat: non-catagent falls through to builtinAccountFamilyForClient', () => {
  assert.equal(effectiveClientFamilyForCat({ id: 'codex', clientId: 'openai' }), 'openai');
  assert.equal(effectiveClientFamilyForCat({ id: 'opus', clientId: 'anthropic' }), 'anthropic');
  assert.equal(effectiveClientFamilyForCat({ id: 'agy', clientId: 'antigravity' }), null);
});
