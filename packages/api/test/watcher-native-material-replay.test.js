import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { estimateTokens } from '../dist/utils/token-counter.js';
import { nativeWatcherAvailable, watcherNativeFixture } from './helpers/watcher-native-fixture.js';
import { watcherWorld } from './helpers/watcher-world.js';

const unwrap = (result) => JSON.parse(result.content[0].text);

test(
  'the captured short reply, native reasoning and memory receipts recover without losing the original cursor',
  { timeout: 50000, skip: !nativeWatcherAvailable },
  async () => {
    const nativeCall = (input, i) => ({
      type: 'custom_tool_call',
      namespace: 'functions',
      name: 'exec',
      id: `item-${i}`,
      call_id: `read-${i}`,
      input,
      status: 'completed',
    });
    const captured = process.env.F335_FAILURE_CAPTURE_FILE
      ? JSON.parse(await readFile(process.env.F335_FAILURE_CAPTURE_FILE, 'utf8'))
      : {
          source: { messageId: 'original-short', content: 'RAW_INCREMENT_76 short source with memory context' },
          directory: {
            content: [
              { type: 'text', text: JSON.stringify({ items: [{ matterId: 'matter-context', title: 'Context' }] }) },
            ],
          },
          matters: [
            {
              content: [
                { type: 'text', text: JSON.stringify({ matter: { matterId: 'matter-context' }, entries: [] }) },
              ],
            },
          ],
          outputs: [
            [nativeCall('text(await tools.cat_cafe_list_memory_matters({limit:30}));', 1)],
            [nativeCall('text(await tools.cat_cafe_read_memory_matter({matterId:"matter-context",limit:30}));', 2)],
          ],
        };
    const w = await watcherWorld();
    const events = [],
      requests = [];
    const f = await watcherNativeFixture(w, {
      model: 'gpt-6.1-sol',
      async configure({ app }) {
        await app.register(async (scope) => {
          registerCallbackAuthHook(scope, w.registry);
          scope.get('/api/callbacks/memory-matters', async () => unwrap(captured.directory));
          scope.get('/api/callbacks/memory-matters/:id', async (request) => {
            return (
              captured.matters.map(unwrap).find((value) => value.matter?.matterId === request.params.id) ??
              unwrap(captured.matters[0])
            );
          });
        });
      },
      async respond({ reply, request }) {
        requests.push({
          inputUpperBound: estimateTokens(JSON.stringify(request.body)),
          maxOutputTokens: request.body.max_output_tokens,
        });
        const session = await w.sessions.getByChainKey(watcherSessionChainKey('watcher-owner', 'codex', w.thread.id));
        if (session.watcherState.attempt.retries) {
          f.state.toolPlan = undefined;
          f.state.tools = 0;
          return false;
        }
        const index = requests.length - 1;
        const output = captured.outputs[index] ?? [];
        const terminalType = index >= captured.outputs.length - 1 ? 'response.incomplete' : 'response.completed';
        const response = {
          id: `original-replay-${index}`,
          status: terminalType === 'response.completed' ? 'completed' : 'incomplete',
          model: request.body.model,
          output,
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 3 } },
        };
        reply.hijack();
        reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of [
          { type: 'response.created', response: { id: response.id, status: 'in_progress', output: [] } },
          ...output.flatMap((item, i) => [
            { type: 'response.output_item.added', output_index: i, item },
            { type: 'response.output_item.done', output_index: i, item },
          ]),
          { type: terminalType, response },
        ])
          reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        reply.raw.end();
        return true;
      },
    });
    const append = f.owners.transcript.appendDurableEvent.bind(f.owners.transcript);
    f.owners.transcript.appendDurableEvent = async (...args) => {
      await append(...args);
      events.push(args[1]);
    };
    f.state.codeMode = true;
    try {
      const [source] = await w.work(captured.source.content);
      const session = await f.run(source, AbortSignal.timeout(40000));
      assert.equal(session.watcherState.afterSequence, source.settledSequence);
      assert.equal(session.watcherState.consumedThrough, source.responseSettlement.messageId);
      assert.ok(
        events.some(
          (e) =>
            e.type === 'watcher_attempt_failure' &&
            e.origin === 'request_boundary' &&
            e.reason.startsWith('watcher_context_budget_exceeded'),
        ),
      );
      assert.ok(events.some((e) => e.type === 'watcher_checkpoint'));
      assert.equal(
        events.some((e) => e.type === 'watcher_window_skipped'),
        false,
      );
      for (const request of f.requests) assert.equal(request.body.max_output_tokens, 4096);
      if (process.env.F335_FAILURE_REPLAY_OUTPUT)
        await writeFile(
          process.env.F335_FAILURE_REPLAY_OUTPUT,
          JSON.stringify(
            {
              captured: Boolean(process.env.F335_FAILURE_CAPTURE_FILE),
              originalMessageId: captured.source.messageId,
              sourceUtf16Chars: captured.source.content.length,
              nativeCli: true,
              requests,
              modelUsageIsFixture: true,
              terminalReason: (await w.executions.listByParent(`watcher-source:codex:${source.invocationId}`))[0]
                .terminalReason,
              checkpoint: true,
              consumedOriginal: true,
              budgetFailures: events.filter((e) => e.type === 'watcher_attempt_failure').map((e) => e.reason),
            },
            null,
            2,
          ),
        );
    } finally {
      await f.close();
    }
  },
);
