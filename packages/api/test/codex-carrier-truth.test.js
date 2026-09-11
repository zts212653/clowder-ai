import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const { resolveCatCarrier } = await import('../dist/config/cat-config-loader.js');

describe('resolveCatCarrier', () => {
  it('keeps legacy reads at one boundary and always returns the canonical vocabulary', () => {
    assert.equal(resolveCatCarrier({ carrier: 'app_server', transport: 'cli' }), 'app_server');
    assert.equal(resolveCatCarrier({ transport: 'acp' }), 'acp');
    assert.equal(resolveCatCarrier({}), 'cli');
  });
});

describe('production assembly carrier wiring', () => {
  it('index.ts routes Codex solely from canonical config.carrier', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const openaiCase = source.match(/case 'openai': \{[\s\S]*?break;\s*\}/);
    assert.ok(openaiCase, 'openai case not found in syncAgentRegistry');
    assert.match(openaiCase[0], /carrierMode:\s*config\.carrier === 'app_server' \? 'app_server' : 'exec_json'/);
    assert.doesNotMatch(openaiCase[0], /CAT_CAFE_CODEX_CARRIER|cli\?\.carrier/);
  });
});
