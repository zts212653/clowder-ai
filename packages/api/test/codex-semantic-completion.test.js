import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { isCliError, isCliTimeout, SEMANTIC_COMPLETION_GRACE_MS, spawnCli } from '../dist/utils/cli-spawn.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

const firstTurn = [
  { type: 'thread.started', thread_id: 'fixture-1260' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'Complete answer' } },
  { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
];
const failed = { type: 'turn.failed', error: { message: 'Fixture turn failed' } };

for (const scenario of [
  { name: 'settles and reaps a child with open stdout', probe: true },
  { name: 'settles when the response watchdog is omitted', defaultTimeout: true },
  { name: 'wakes an already pending read without a probe', deferSignal: 'pending-read' },
  { name: 'wakes the exit wait when the signal follows stdout EOF', deferSignal: 'stdout-eof' },
  { name: 'reports a late turn.failed even when stdout stays open', tail: [failed], failure: true },
  { name: 'reports a late turn.failed after a clean process exit', tail: [failed], failure: true, naturalExit: true },
  {
    name: 'keeps multi-turn order and drains stderr on natural exit',
    tail: [failed, { type: 'turn.started' }, firstTurn[2]],
    naturalExit: true,
  },
  { name: 'honors cancellation during the drain', tail: [failed], cancel: true },
]) {
  test(`Issue #1260: Codex ${scenario.name}`, { timeout: 30_000 }, async (t) => {
    const fixture = `
      const writeEvents = events => {
        for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');
      };
      process.stdin.resume();
      process.stdin.on('end', () => {
        writeEvents(${JSON.stringify(firstTurn)});
        setTimeout(() => {
          writeEvents(${JSON.stringify(scenario.tail ?? [])});
          if (${scenario.naturalExit === true}) {
            process.stdout.end();
            setTimeout(() => process.stderr.write('trailing stderr'), 100);
          } else {
            setInterval(() => {}, 1000);
          }
        }, 200);
      });
    `;
    const cancellation = new AbortController();
    const deferredCompletion = scenario.deferSignal ? new AbortController() : undefined;
    let child;
    let closed;
    let semanticAt;
    let cleanupFallback;
    const trace = [];
    const stderrLines = [];
    t.after(async () => {
      clearTimeout(cleanupFallback);
      if (!child) return;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    });

    const service = new CodexAgentService({ cliCommand: process.execPath, l0CompilerFn: fakeL0Compiler });
    const messages = [];
    for await (const message of service.invoke('fixture', {
      signal: cancellation.signal,
      ...(scenario.probe ? { livenessProbe: { sampleIntervalMs: 100 } } : {}),
      spawnCliOverride: async function* (options) {
        options.semanticCompletionSignal.addEventListener(
          'abort',
          () => {
            semanticAt = performance.now();
            if (scenario.defaultTimeout) {
              cleanupFallback = setTimeout(() => cancellation.abort(), SEMANTIC_COMPLETION_GRACE_MS + 2_000);
            }
            trace.push('semantic completion');
            assert.equal(child.stdout.readableEnded, false);
            assert.equal(child.exitCode, null);
            assert.equal(child.signalCode, null);
            // Let the iterator enter its next read before delivering this signal.
            if (scenario.deferSignal === 'pending-read') setImmediate(() => deferredCompletion.abort());
            if (scenario.deferSignal === 'stdout-eof') child.stdout.end();
          },
          { once: true },
        );
        for await (const event of spawnCli(
          {
            ...options,
            ...(deferredCompletion ? { semanticCompletionSignal: deferredCompletion.signal } : {}),
            ...(scenario.defaultTimeout ? {} : { timeoutMs: 1_500 }),
            onStderrLine: (line) => stderrLines.push(line),
          },
          {
            spawnFn: (command, _args, spawnOptions) => {
              child = spawn(command, ['-e', fixture], spawnOptions);
              if (scenario.deferSignal === 'stdout-eof') {
                // The Windows child keeps its stdio handle until exit. Inject EOF at
                // the transport boundary while keeping the owned child alive.
                child.stdout = child.stdout.pipe(new PassThrough());
              }
              closed = once(child, 'close');
              child.once('spawn', () => trace.push('spawn'));
              child.once('exit', () => trace.push('exit'));
              child.stdout.once('end', () => {
                trace.push('stdout EOF');
                if (scenario.deferSignal === 'stdout-eof') {
                  setImmediate(() => {
                    trace.push('semantic wake after EOF');
                    deferredCompletion.abort();
                  });
                  cleanupFallback = setTimeout(() => cancellation.abort(), SEMANTIC_COMPLETION_GRACE_MS + 2_000);
                }
              });
              return child;
            },
          },
        )) {
          trace.push(isCliTimeout(event) ? '__cliTimeout' : isCliError(event) ? '__cliError' : event.type);
          if (scenario.cancel && event.type === 'turn.failed') {
            trace.push('cancel');
            cancellation.abort();
          }
          yield event;
        }
      },
    })) {
      messages.push(message);
    }

    const elapsed = Math.round(performance.now() - semanticAt);
    const exitAtSettlement = child.signalCode ?? child.exitCode;
    t.diagnostic(`pid=${child.pid}, exit=${exitAtSettlement}, semantic-to-settle=${elapsed}ms | ${trace.join(' → ')}`);
    assert.ok(semanticAt !== undefined);
    assert.equal(
      cancellation.signal.aborted,
      scenario.cancel === true,
      'the fixture must not need fallback cancellation',
    );
    assert.ok(messages.some((message) => message.type === 'text' && message.content === 'Complete answer'));
    assert.deepEqual(
      trace.filter((event) => event?.startsWith('turn.')),
      ['turn.completed', ...(scenario.tail ?? []).map((event) => event.type)],
    );
    assert.equal(trace.includes('__cliTimeout'), false);
    assert.equal(trace.filter((event) => event === '__cliError').length, scenario.failure ? 1 : 0);
    assert.equal(messages.filter((message) => message.type === 'error').length, scenario.failure ? 1 : 0);
    if (!scenario.cancel) assert.equal(messages.at(-1)?.type, 'done');
    assert.equal(exitAtSettlement, scenario.naturalExit ? 0 : 'SIGTERM');
    if (scenario.naturalExit) assert.deepEqual(stderrLines, ['trailing stderr']);
    if (scenario.naturalExit || scenario.cancel) {
      assert.ok(elapsed < SEMANTIC_COMPLETION_GRACE_MS, 'should settle before the semantic deadline');
    } else {
      assert.ok(elapsed >= SEMANTIC_COMPLETION_GRACE_MS - 10, 'tail drain should get the full grace period');
      assert.ok(elapsed < SEMANTIC_COMPLETION_GRACE_MS + 3_000, 'cleanup should reuse the same deadline');
    }
  });
}
