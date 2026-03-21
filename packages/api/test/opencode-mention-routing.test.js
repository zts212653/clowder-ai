import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';
import { OpenCodeAgentService } from '../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js';
import { parseA2AMentions } from '../dist/domains/cats/services/agents/routing/a2a-mentions.js';
import {
  buildInvocationContext,
  buildStaticIdentity,
  buildSystemPrompt,
} from '../dist/domains/cats/services/context/SystemPromptBuilder.js';
import { parseMentions } from '../dist/infrastructure/connectors/mention-parser.js';

// ── Shared fixtures ──────────────────────────────────────────────

/** Full pattern map including opencode — mirrors production catRegistry */
const allPatterns = new Map([
  ['opus', ['@opus', '@布偶猫', '@布偶', '@宪宪']],
  ['codex', ['@codex', '@缅因猫', '@缅因', '@砚砚']],
  ['gemini', ['@gemini', '@暹罗猫', '@暹罗', '@烁烁']],
  ['opencode', ['@opencode', '@金渐层', '@golden', '@golden-chinchilla']],
]);

/** Display names for realistic system prompt output */
const catDisplayNames = {
  opus: '布偶猫',
  codex: '缅因猫',
  gemini: '暹罗猫',
  opencode: '金渐层',
};

/** Minimal CatConfig stub for catRegistry tests */
function stubCatConfig(catId, mentionPatterns) {
  return {
    id: catId,
    name: catId,
    displayName: catDisplayNames[catId] || catId,
    avatar: `/avatars/${catId}.png`,
    color: { primary: '#000', secondary: '#fff' },
    mentionPatterns,
    provider: catId === 'opencode' ? 'opencode' : 'anthropic',
    defaultModel: 'test-model',
    mcpSupport: false,
    roleDescription: 'test role',
    personality: 'test personality',
  };
}

// ── Task 1: @mention parsing recognizes opencode patterns ────────

describe('parseMentions — opencode patterns', () => {
  it('resolves @opencode to opencode', () => {
    const result = parseMentions('@opencode hello', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'opencode');
  });

  it('resolves @金渐层 to opencode', () => {
    const result = parseMentions('@金渐层 帮我看看', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'opencode');
  });

  it('resolves @golden to opencode', () => {
    const result = parseMentions('@golden check this', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'opencode');
  });

  it('resolves @golden-chinchilla to opencode', () => {
    const result = parseMentions('@golden-chinchilla review', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'opencode');
  });

  it('does not match @goldenxyz (partial word)', () => {
    const result = parseMentions('@goldenxyz hello', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'opus'); // default
  });

  it('matches @opencode mid-text', () => {
    const result = parseMentions('hey @opencode check this', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'opencode');
  });

  it('returns first-in-text when multiple cats mentioned', () => {
    const result = parseMentions('@opencode @codex hello', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'opencode');
  });

  it('returns first-in-text: codex before opencode', () => {
    const result = parseMentions('@codex @opencode hello', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'codex');
  });

  it('is case-insensitive for @OPENCODE', () => {
    const result = parseMentions('@OPENCODE hello', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'opencode');
  });

  it('matches @金渐层 followed by CJK full-width comma', () => {
    const result = parseMentions('@金渐层，帮忙看下', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'opencode');
  });

  it('does not match @opencode inside email', () => {
    const result = parseMentions('send to foo@opencode.dev', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'opus'); // default
  });

  it('matches @golden-chinchilla over @golden (longest match)', () => {
    // Both patterns start with @golden, longest wins
    const result = parseMentions('@golden-chinchilla 来帮忙', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'opencode');
  });
});

// ── Task 2: A2A mention chain detection ──────────────────────────

describe('parseA2AMentions — opencode A2A chain', () => {
  before(() => {
    // Register all cats including opencode in catRegistry
    catRegistry.reset();
    for (const [catId, patterns] of allPatterns) {
      catRegistry.register(catId, stubCatConfig(catId, patterns));
    }
  });

  after(() => {
    catRegistry.reset();
  });

  it('detects @opencode at line start from opus response', () => {
    const text = '分析完了，交给金渐层\n@opencode 请继续分析';
    const result = parseA2AMentions(text, 'opus');
    assert.deepEqual(result, ['opencode']);
  });

  it('detects @opus at line start from opencode response', () => {
    const text = 'Done with analysis.\n@opus 结果在这里';
    const result = parseA2AMentions(text, 'opencode');
    assert.deepEqual(result, ['opus']);
  });

  it('filters self-mention: opencode mentioning @opencode', () => {
    const text = 'I will handle this\n@opencode 继续';
    const result = parseA2AMentions(text, 'opencode');
    assert.deepEqual(result, []); // self-mention filtered
  });

  it('detects @金渐层 at line start (CJK A2A)', () => {
    const text = '请金渐层接手\n@金渐层 帮忙看看这段代码';
    const result = parseA2AMentions(text, 'opus');
    assert.deepEqual(result, ['opencode']);
  });

  it('detects multi-target: @opencode and @codex', () => {
    const text = '请两位协助\n@opencode 看架构\n@codex 看安全';
    const result = parseA2AMentions(text, 'opus');
    assert.deepEqual(result, ['opencode', 'codex']);
  });

  it('ignores @opencode inside fenced code block', () => {
    const text = '示例：\n```\n@opencode run test\n```\n普通文本';
    const result = parseA2AMentions(text, 'opus');
    assert.deepEqual(result, []);
  });

  it('ignores non-line-start mentions', () => {
    const text = '请联系 @opencode 来帮忙';
    const result = parseA2AMentions(text, 'opus');
    assert.deepEqual(result, []); // not at line start
  });
});

// ── Task 3: System prompt context injection ──────────────────────

describe('System prompt — opencode context injection', () => {
  before(() => {
    catRegistry.reset();
    for (const [catId, patterns] of allPatterns) {
      catRegistry.register(catId, stubCatConfig(catId, patterns));
    }
  });

  after(() => {
    catRegistry.reset();
  });

  it('buildStaticIdentity produces identity for opencode', () => {
    const identity = buildStaticIdentity('opencode');
    assert.ok(identity.includes('金渐层'), 'should include displayName');
    assert.ok(identity.length > 10, 'should be non-trivial');
  });

  it('buildInvocationContext includes "Direct message from" for opus→opencode', () => {
    const ctx = buildInvocationContext({
      catId: 'opencode',
      mode: 'serial',
      teammates: ['opus'],
      mcpAvailable: false,
      directMessageFrom: 'opus',
    });
    assert.ok(ctx.includes('Direct message from'), 'should include direct message context');
    assert.ok(ctx.includes('布偶猫'), 'should include sender displayName');
  });

  it('buildInvocationContext includes opencode identity line', () => {
    const ctx = buildInvocationContext({
      catId: 'opencode',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(ctx.includes('金渐层'), 'should include opencode displayName');
    assert.ok(ctx.includes('opencode'), 'should include catId');
  });

  it('buildInvocationContext for reverse direction: opencode→opus', () => {
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'serial',
      teammates: ['opencode'],
      mcpAvailable: false,
      directMessageFrom: 'opencode',
    });
    assert.ok(ctx.includes('Direct message from'), 'should include DM context');
    assert.ok(ctx.includes('金渐层'), 'should include opencode displayName');
  });
});

// ── Task 4+5: Routed prompt delivery + E2E integration ──────────

/** Mock child_process for OpenCodeAgentService */
function createMockProcess(exitCode = 0) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const proc = {
    stdout,
    stderr,
    pid: 99999,
    kill: mock.fn(() => {
      process.nextTick(() => {
        if (!stdout.destroyed) stdout.end();
        emitter.emit('exit', exitCode, null);
      });
      return true;
    }),
    on: (event, listener) => {
      emitter.on(event, listener);
      return proc;
    },
    once: (event, listener) => {
      emitter.once(event, listener);
      return proc;
    },
    _emitter: emitter,
  };
  return proc;
}

function emitMinimalResponse(proc, text = 'OK') {
  const events = [
    {
      type: 'step_start',
      timestamp: Date.now(),
      sessionID: 'ses_e2e',
      part: { type: 'step_start', stepID: 's1', metadata: { title: 'Assistant' } },
    },
    {
      type: 'text',
      timestamp: Date.now(),
      sessionID: 'ses_e2e',
      part: { type: 'text', text, time: { start: Date.now(), end: Date.now() } },
    },
    {
      type: 'step_finish',
      timestamp: Date.now(),
      sessionID: 'ses_e2e',
      part: { type: 'step_finish', stepID: 's1', metadata: {} },
    },
  ];
  for (const event of events) {
    proc.stdout.write(`${JSON.stringify(event)}\n`);
  }
  proc.stdout.end();
  process.nextTick(() => proc._emitter.emit('exit', 0, null));
}

async function collect(iterable) {
  const messages = [];
  for await (const msg of iterable) messages.push(msg);
  return messages;
}

describe('OpenCodeAgentService — routed prompt with system context', () => {
  before(() => {
    catRegistry.reset();
    for (const [catId, patterns] of allPatterns) {
      catRegistry.register(catId, stubCatConfig(catId, patterns));
    }
  });

  after(() => {
    catRegistry.reset();
  });

  // ── P1 fix: mirror the real route-serial assembly path ────────
  // Production flow (route-serial.ts):
  //   1. staticIdentity = buildStaticIdentity(catId, { mcpAvailable })     → line 154
  //   2. invocationContext = buildInvocationContext({ catId, ... })         → line 171
  //   3. prompt = [invocationContext, ...parts, userMessage].join('---')    → line 265-268
  //   4. invokeSingleCat({ systemPrompt: staticIdentity, prompt })         → line 303
  //   5. effectivePrompt = systemPrompt + '---' + prompt                   → invoke-single-cat.ts:443
  //
  // Key difference from buildSystemPrompt(): staticIdentity and
  // invocationContext are assembled SEPARATELY and injected at
  // different positions in the final prompt.

  it('route-serial assembly: staticIdentity as systemPrompt, invocationContext in prompt body', () => {
    // Step 1: buildStaticIdentity (route-serial.ts:154)
    const staticIdentity = buildStaticIdentity('opencode', { mcpAvailable: false });

    // Step 2: buildInvocationContext (route-serial.ts:171)
    const invocationContext = buildInvocationContext({
      catId: 'opencode',
      mode: 'serial',
      teammates: ['opus'],
      mcpAvailable: false,
      directMessageFrom: 'opus',
    });

    // Step 3: assemble prompt body (route-serial.ts:265-268)
    const userMessage = '@opencode 请分析这段代码的架构';
    const parts = [invocationContext].filter(Boolean);
    const prompt = `${parts.join('\n\n---\n\n')}\n\n---\n\n${userMessage}`;

    // Step 4+5: invokeSingleCat prepends systemPrompt (invoke-single-cat.ts:443)
    const effectivePrompt = `${staticIdentity}\n\n---\n\n${prompt}`;

    // Verify structure matches production assembly
    assert.ok(staticIdentity.includes('金渐层'), 'staticIdentity includes opencode displayName');
    assert.ok(invocationContext.includes('Direct message from'), 'invocationContext includes DM context');
    assert.ok(invocationContext.includes('布偶猫'), 'invocationContext includes sender displayName');

    // Verify ordering: staticIdentity → invocationContext → userMessage
    const idxIdentity = effectivePrompt.indexOf('金渐层');
    const idxDM = effectivePrompt.indexOf('Direct message from');
    const idxUser = effectivePrompt.indexOf(userMessage);
    assert.ok(idxIdentity < idxDM, 'staticIdentity precedes invocationContext');
    assert.ok(idxDM < idxUser, 'invocationContext precedes user message');
  });

  it('staticIdentity ≠ buildSystemPrompt — production uses separate assembly', () => {
    // This test guards against the false assumption that buildSystemPrompt()
    // is what route-serial uses. It doesn't — it uses buildStaticIdentity + buildInvocationContext separately.
    const staticIdentity = buildStaticIdentity('opencode', { mcpAvailable: false });
    const systemPrompt = buildSystemPrompt({
      catId: 'opencode',
      mode: 'serial',
      teammates: ['opus'],
      mcpAvailable: false,
      directMessageFrom: 'opus',
    });

    // buildSystemPrompt combines both, so it should be longer
    assert.ok(
      systemPrompt.length > staticIdentity.length,
      'buildSystemPrompt is longer because it includes invocationContext',
    );
    // staticIdentity should NOT contain "Direct message from" — that's in invocationContext
    assert.ok(
      !staticIdentity.includes('Direct message from'),
      'staticIdentity does not contain DM context (that goes in invocationContext)',
    );
  });

  it('spawnFn receives route-serial-assembled prompt as CLI arg', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'claude-sonnet-4-6',
    });

    // Mirror real route-serial assembly (NOT buildSystemPrompt)
    const staticIdentity = buildStaticIdentity('opencode', { mcpAvailable: false });
    const invocationContext = buildInvocationContext({
      catId: 'opencode',
      mode: 'serial',
      teammates: ['opus'],
      mcpAvailable: false,
      directMessageFrom: 'opus',
    });
    const userMessage = '请帮忙 review 这个 PR';
    const prompt = `${invocationContext}\n\n---\n\n${userMessage}`;
    const effectivePrompt = `${staticIdentity}\n\n---\n\n${prompt}`;

    const promise = collect(service.invoke(effectivePrompt));
    emitMinimalResponse(proc);
    await promise;

    // Verify spawnFn received the correctly assembled prompt
    assert.equal(spawnFn.mock.calls.length, 1, 'spawnFn called once');
    const args = spawnFn.mock.calls[0].arguments[1];
    const lastArg = args[args.length - 1];
    assert.ok(lastArg.includes('金渐层'), 'CLI arg includes opencode identity');
    assert.ok(lastArg.includes('Direct message from'), 'CLI arg includes DM context');
    assert.ok(lastArg.includes(userMessage), 'CLI arg includes user message');
  });

  it('E2E: mention → route-serial assembly → service invoke (full chain)', async () => {
    // Step 1: Parse mention
    const userText = '@opencode 帮我看看这段代码';
    const mentionResult = parseMentions(userText, allPatterns, 'opus');
    assert.equal(mentionResult.targetCatId, 'opencode', 'mention resolved to opencode');

    // Step 2: Mirror route-serial assembly (NOT buildSystemPrompt)
    const staticIdentity = buildStaticIdentity(mentionResult.targetCatId, { mcpAvailable: false });
    const invocationContext = buildInvocationContext({
      catId: mentionResult.targetCatId,
      mode: 'serial',
      teammates: ['opus'],
      mcpAvailable: false,
      directMessageFrom: 'opus',
    });

    // Step 3: Assemble prompt body (route-serial.ts:265-268)
    const parts = [invocationContext].filter(Boolean);
    const prompt = `${parts.join('\n\n---\n\n')}\n\n---\n\n${userText}`;

    // Step 4: invokeSingleCat prepends staticIdentity (invoke-single-cat.ts:443)
    const effectivePrompt = `${staticIdentity}\n\n---\n\n${prompt}`;

    // Step 5: OpenCodeAgentService receives the assembled prompt
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'claude-sonnet-4-6',
    });

    const promise = collect(service.invoke(effectivePrompt));
    emitMinimalResponse(proc, '好的，我来看看代码');
    const messages = await promise;

    // Verify response
    const textMsg = messages.find((m) => m.type === 'text');
    assert.ok(textMsg, 'got text response');
    assert.equal(textMsg.content, '好的，我来看看代码');

    // Verify prompt was delivered matching route-serial assembly
    const cliArgs = spawnFn.mock.calls[0].arguments[1];
    const deliveredPrompt = cliArgs[cliArgs.length - 1];
    assert.ok(deliveredPrompt.includes('金渐层'), 'opencode identity injected');
    assert.ok(deliveredPrompt.includes('Direct message from'), 'DM context injected');
    assert.ok(deliveredPrompt.includes(userText), 'original user message preserved');

    // Verify structure: identity → DM → user message (matching production order)
    // Use the full userText to avoid matching @opencode in Identity line
    const idxId = deliveredPrompt.indexOf('金渐层');
    const idxDm = deliveredPrompt.indexOf('Direct message from');
    const idxUsr = deliveredPrompt.indexOf(userText);
    assert.ok(idxId < idxDm && idxDm < idxUsr, 'production ordering: identity → invocationContext → user message');
  });
});

// ── P2 fix: Guard test binding fixture to cat-template.json truth source ──

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(__dirname, '..', '..', '..', 'cat-template.json');

describe('Fixture guard — allPatterns matches cat-template.json truth source', () => {
  let catConfig;

  before(() => {
    const raw = readFileSync(configPath, 'utf-8');
    catConfig = JSON.parse(raw);
  });

  it('opencode mentionPatterns in fixture match cat-template.json', () => {
    const breed = catConfig.breeds.find((b) => b.id === 'golden-chinchilla');
    assert.ok(breed, 'golden-chinchilla breed exists in cat-template.json');
    const fixturePatterns = allPatterns.get('opencode');
    assert.ok(fixturePatterns, 'opencode exists in test fixture');
    assert.deepEqual(
      [...fixturePatterns].sort(),
      [...breed.mentionPatterns].sort(),
      'fixture mentionPatterns must match cat-template.json truth source',
    );
  });

  it('all fixture cats patterns are a subset of cat-template.json (no phantom patterns)', () => {
    // Guard: fixture patterns must exist in the truth source — prevents phantom patterns
    // that would make tests pass for patterns that were removed from production config.
    // Note: fixture may be a subset (e.g., opus fixture omits @ragdoll for simplicity)
    const catIdToBreed = { opus: 'ragdoll', codex: 'maine-coon', gemini: 'siamese', opencode: 'golden-chinchilla' };
    for (const [catId, fixturePatterns] of allPatterns) {
      const breedId = catIdToBreed[catId];
      const breed = catConfig.breeds.find((b) => b.id === breedId);
      assert.ok(breed, `breed ${breedId} exists in cat-template.json`);
      const configSet = new Set(breed.mentionPatterns.map((p) => p.toLowerCase()));
      for (const pattern of fixturePatterns) {
        assert.ok(
          configSet.has(pattern.toLowerCase()),
          `fixture pattern "${pattern}" for ${catId} must exist in cat-template.json`,
        );
      }
    }
  });
});
