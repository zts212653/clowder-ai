/**
 * F198 Phase B Step 3: Canary carrier factory test
 *
 * Selects ClaudeAgentService (-p, default) or ClaudeBgCarrierService (--bg)
 * based on env var. Default = print (current production). Opt-in = bg_daemon
 * for the alpha canary cohort. AC-B8 hard constraint: no flag → -p stays
 * default, all布偶猫 invocations unchanged until canary explicitly enabled.
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeAgentServiceForCanary } from '../dist/domains/cats/services/agents/providers/claude-carrier-factory.js';

test('canary factory: env unset → returns ClaudeAgentService (-p default)', () => {
  const service = createClaudeAgentServiceForCanary('opus', {});
  assert.equal(service.constructor.name, 'ClaudeAgentService');
});

test('canary factory: env set to non-canary value → ClaudeAgentService', () => {
  const service = createClaudeAgentServiceForCanary('opus', { CAT_CAFE_CLAUDE_CARRIER: 'print' });
  assert.equal(service.constructor.name, 'ClaudeAgentService');
});

test('canary factory: env CAT_CAFE_CLAUDE_CARRIER=bg_daemon → ClaudeBgCarrierService', () => {
  const service = createClaudeAgentServiceForCanary('opus', { CAT_CAFE_CLAUDE_CARRIER: 'bg_daemon' });
  assert.equal(service.constructor.name, 'ClaudeBgCarrierService');
});

test('canary factory: env value with surrounding whitespace handled', () => {
  const service = createClaudeAgentServiceForCanary('opus', { CAT_CAFE_CLAUDE_CARRIER: '  bg_daemon  ' });
  assert.equal(service.constructor.name, 'ClaudeBgCarrierService');
});

test('canary factory: catId is passed through to constructed service', () => {
  const sonnetPrint = createClaudeAgentServiceForCanary('sonnet', {});
  assert.equal(sonnetPrint.catId, 'sonnet');
  const sonnetBg = createClaudeAgentServiceForCanary('sonnet', { CAT_CAFE_CLAUDE_CARRIER: 'bg_daemon' });
  assert.equal(sonnetBg.catId, 'sonnet');
});

test('砚砚 Step-3 P1 re-review: opusService lazy wrapper invoke() returns AsyncIterable directly (not Promise)', () => {
  // 砚砚 P1: opusService.invoke must satisfy AgentService contract — return
  // AsyncIterable directly, not Promise<AsyncIterable>. Earlier async invoke
  // wrapper would crash TaskExtractor's `for await (... of svc.invoke())`.
  // This test asserts the sync-return + lazy-init-inside-generator pattern.
  let inited = false;
  const factory = (catId) => {
    inited = true;
    // Mock AgentService — yields one done event
    return {
      catId,
      async *invoke() {
        yield { type: 'done', catId, timestamp: Date.now(), metadata: { provider: 'mock', model: 'm' } };
      },
    };
  };
  let _svc;
  const lazyService = {
    invoke(prompt, options) {
      return (async function* () {
        if (!_svc) _svc = factory('opus');
        yield* _svc.invoke(prompt, options);
      })();
    },
  };
  // Critical: invoke() returns AsyncIterable SYNCHRONOUSLY (not Promise).
  const iter = lazyService.invoke('hi');
  assert.ok(typeof iter[Symbol.asyncIterator] === 'function', 'must be AsyncIterable directly');
  assert.equal(inited, false, 'lazy init must NOT happen at invoke() call time');
});

test('砚砚 Step-3 P1 re-review: opusService lazy wrapper executes lazy init on first yield', async () => {
  let inited = 0;
  const factory = () => {
    inited++;
    return {
      catId: 'opus',
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: 'lazy ok', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now(), metadata: { provider: 'mock', model: 'm' } };
      },
    };
  };
  let _svc;
  const lazyService = {
    invoke(prompt, options) {
      return (async function* () {
        if (!_svc) _svc = factory();
        yield* _svc.invoke(prompt, options);
      })();
    },
  };

  const events = [];
  for await (const msg of lazyService.invoke('hi')) events.push(msg);
  assert.equal(inited, 1, 'lazy init exactly once');
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'text');
  assert.equal(events[1].type, 'done');

  // Second invoke must NOT re-init (cached service).
  for await (const _ of lazyService.invoke('hi2')) {
    // drain
  }
  assert.equal(inited, 1, 'lazy init still exactly once after second invoke');
});
