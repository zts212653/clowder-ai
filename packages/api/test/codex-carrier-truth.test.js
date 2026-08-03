import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const { resolveCodexCarrierTruth } = await import('../dist/config/codex-cli.js');

describe('resolveCodexCarrierTruth (F254 D2)', () => {
  it('per-cat override beats env and default', () => {
    assert.deepEqual(resolveCodexCarrierTruth('app_server', {}), { effective: 'app_server', source: 'per-cat' });
    assert.deepEqual(resolveCodexCarrierTruth('exec_json', { CAT_CAFE_CODEX_CARRIER: 'app_server' }), {
      effective: 'exec_json',
      source: 'per-cat',
    });
  });

  it('env applies when no per-cat override exists', () => {
    assert.deepEqual(resolveCodexCarrierTruth(undefined, { CAT_CAFE_CODEX_CARRIER: 'app_server' }), {
      effective: 'app_server',
      source: 'env',
    });
    assert.deepEqual(resolveCodexCarrierTruth(undefined, { CAT_CAFE_CODEX_CARRIER: 'exec_json' }), {
      effective: 'exec_json',
      source: 'env',
    });
    // Unknown values fail closed to exec_json but are still env-sourced.
    assert.deepEqual(resolveCodexCarrierTruth(undefined, { CAT_CAFE_CODEX_CARRIER: 'garbage' }), {
      effective: 'exec_json',
      source: 'env',
    });
  });

  it('falls back to the exec_json default when nothing is set', () => {
    assert.deepEqual(resolveCodexCarrierTruth(undefined, {}), { effective: 'exec_json', source: 'default' });
  });
});

describe('production assembly wiring guard (F254 D2)', () => {
  // F254 history: implementation existed and tests were green while the
  // production wiring silently dropped the carrier. This source guard fails if
  // the syncAgentRegistry openai case stops feeding per-cat carrier truth into
  // CodexAgentService.
  it('index.ts openai case passes resolveCodexCarrierTruth(config.cli?.carrier) into CodexAgentService', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const openaiCase = source.match(/case 'openai': \{[\s\S]*?break;\s*\}/);
    assert.ok(openaiCase, 'openai case not found in syncAgentRegistry');
    assert.match(openaiCase[0], /carrierMode:\s*resolveCodexCarrierTruth\(config\.cli\?\.carrier\)\.effective/);
  });
});
