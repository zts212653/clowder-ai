import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';
import { RoutingMessageOutputProjection } from '../../dist/domains/cats/services/agents/routing/message-output-projection.js';
import { projectSessionEvent } from '../../dist/domains/cats/services/agents/session-contract/event-projection.js';
import {
  SessionImplementationRegistry,
  sessionImplementationKey,
} from '../../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { collect, fixture, options, session, turn } from './fake-session-provider.js';

const dir = new URL('../../src/domains/cats/services/agents/session-contract/', import.meta.url);
test('projected sequence, shallow metadata snapshots and both textMode layers', async () => {
  const { bridge, provider } = fixture({ metadata: { provider: 'test-provider', model: 'initial' } });
  const usage = { inputTokens: 42 };
  const nativeMessage = {
    nativeId: 'output',
    channel: 'final',
    complete: false,
    textMode: 'replace',
    displayPrefixLength: 2,
  };
  provider.events = [
    turn('status', { phase: 'starting' }),
    session('context', { model: 'reported', usage }),
    session('native_bound', { nativeSessionId: 'bound' }),
    turn('output', { text: '\n\nhello', textMode: 'replace', message: nativeMessage }),
    turn('output', { text: '\n\nhello world', textMode: 'replace', message: { ...nativeMessage, complete: true } }),
    turn('tool_call', { name: 'read', callId: 'call', input: { path: '/x' } }),
    turn('tool_result', { name: 'read', callId: 'call', status: 'ok', output: { value: 1 } }),
    session('continuity', { evidence: { kind: 'started', runtimeSessionId: 'bound' } }),
    turn('error', { code: 'notice', message: 'retry', disposition: 'transient' }),
    turn('done', { outcome: 'completed' }),
  ];
  const messages = await collect(bridge.invoke('x', options()));
  assert.deepEqual(
    messages.map((m) => m.type),
    ['status', 'session_init', 'text', 'text', 'tool_use', 'tool_result', 'error', 'done'],
  );
  assert.equal(messages[0].metadata.model, 'initial');
  assert.equal(messages[0].metadata.sessionId, 'native');
  assert.equal(messages[0].metadata.usage, undefined);
  assert.equal(messages[2].metadata.model, 'reported');
  assert.equal(messages[2].metadata.usage, usage);
  assert.notEqual(messages[1].metadata, messages[2].metadata);
  assert.deepEqual(messages[2].outputMessage, {
    ...nativeMessage,
    provider: 'test-provider',
    runtimeSessionId: 'bound',
    turnId: 'native-turn',
  });
  const projection = new RoutingMessageOutputProjection({
    threadId: 'thread',
    catId: 'codex',
    turnInvocationId: 'inv',
  });
  for (const message of messages.filter((m) => m.type === 'text')) {
    assert.equal(message.textMode, 'replace');
    assert.equal(message.outputMessage.textMode, 'replace');
    projection.text(message);
  }
  assert.equal(projection.snapshot().content, 'hello world');
  assert.equal(messages[4].toolUseId, 'call');
  assert.deepEqual(messages[4].toolInput, { path: '/x' });
  assert.equal(messages[5].content, '{"value":1}');
  assert.equal(messages[5].toolResultStatus, 'ok');
  assert.equal(messages[6].errorDisposition, 'transient');
  for (const message of messages) {
    assert.equal(message.catId, 'codex');
    assert.equal(typeof message.timestamp, 'number');
    assert.ok(message.metadata);
  }
});

test('projection: append, primitive tools, status fallback and silent session facts', () => {
  const ctx = { catId: 'codex', metadata: { provider: 'p', model: 'm' } };
  const project = (event) => projectSessionEvent(event, ctx);
  assert.equal(project(turn('output', { text: 'suffix', textMode: 'append' }))[0].textMode, 'append');
  for (const input of [undefined, null, 'string', 1, ['array']])
    assert.deepEqual(
      project(turn('tool_call', { name: 'tool', input }))[0].toolInput,
      input === undefined ? undefined : { value: input },
    );
  assert.equal(project(turn('tool_result', { name: 'tool', output: 'raw', status: 'error' }))[0].content, 'raw');
  assert.equal(project(turn('status', { phase: 'fallback' }))[0].content, 'fallback');
  assert.equal(project(turn('status', { phase: 'fallback', detail: '' }))[0].content, '');
  assert.deepEqual(project(turn('input_read', { deliveryId: 'd' })), []);
  assert.deepEqual(
    project(session('continuity', { evidence: { kind: 'unavailable', reason: 'signal_unavailable' } })),
    [],
  );
  assert.deepEqual(project(session('compaction_observed', { observation: {} })), []);
  project(session('context', { windowTokens: 100 }));
  assert.equal(ctx.metadata.model, 'm');
});

test('registry: exact keys, duplicate rejection, factory context and idempotent unregister', () => {
  const registry = new SessionImplementationRegistry();
  const ctx = { catId: 'codex' };
  for (const ref of [{ builtin: 'test' }, { pluginId: 'plugin', contributionId: 'test' }]) {
    assert.equal(sessionImplementationKey(ref), 'builtin' in ref ? 'builtin:test' : 'plugin:plugin/test');
    const provider = {};
    const factory = (actual) => {
      assert.equal(actual, ctx);
      return provider;
    };
    const unregister = registry.register(ref, factory);
    assert.equal(registry.has(ref), true);
    assert.throws(() => registry.register(ref, factory), /Duplicate session implementation/);
    assert.equal(registry.resolve(ref, ctx), provider);
    unregister();
    assert.equal(registry.has(ref), false);
    assert.equal(registry.resolve(ref, ctx), undefined);
    const removeNew = registry.register(ref, factory);
    unregister();
    assert.equal(registry.has(ref), true);
    removeNew();
  }
});

test('Support has exactly the two agreed literals', async () => {
  const source = ts.createSourceFile(
    'types.ts',
    await readFile(new URL('types.ts', dir), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const support = source.statements.find((node) => ts.isTypeAliasDeclaration(node) && node.name.text === 'Support');
  assert.ok(ts.isUnionTypeNode(support.type));
  assert.deepEqual(
    support.type.types.map((node) => node.literal.text),
    ['supported', 'unsupported'],
  );
});

test('new production directory contains no vendor comparisons or vendor-name string literals', async () => {
  const comparison =
    /\b(?:provider|clientId|carrier)\s*(?:===|!==|==|!=)\s*['"`]|['"`][^'"`]+['"`]\s*(?:===|!==|==|!=)\s*(?:\w+\.)?(?:provider|clientId|carrier)\b/;
  assert.ok(comparison.test("provider === 'vendor'"));
  assert.ok(comparison.test("'vendor' === config.carrier"));
  const vendors = /^(?:claude|codex|openai|anthropic|gemini|antigravity|kimi|opencode|catagent)$/i;
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.ts')) continue;
    const text = await readFile(new URL(file, dir), 'utf8');
    assert.equal(comparison.test(text), false, file);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isStringLiteral(node)) assert.equal(vendors.test(node.text), false, `${file}: ${node.text}`);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});
