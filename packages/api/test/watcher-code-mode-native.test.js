import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { watcherToolSurface } from '../dist/domains/concierge/watcher/watcher-surface.js';
import { nativeWatcherAvailable, watcherNativeFixture } from './helpers/watcher-native-fixture.js';
import { watcherWorld } from './helpers/watcher-world.js';

test(
  'native reasoning is retained verbatim while a verified append uses reported token accounting',
  { timeout: 40000, skip: !nativeWatcherAvailable },
  async () => {
    const w = await watcherWorld();
    const events = [];
    const f = await watcherNativeFixture(w, {
      model: 'gpt-6.1-sol',
      respond({ reply }) {
        const write = reply.raw.write.bind(reply.raw);
        reply.raw.write = (chunk, ...args) => {
          const wire = String(chunk)
            .split('\n')
            .map((line) => {
              if (!line.startsWith('data: ')) return line;
              const event = JSON.parse(line.slice(6));
              if (event.item?.type === 'reasoning') event.item.summary = [];
              for (const item of event.response?.output ?? []) if (item.type === 'reasoning') item.summary = [];
              if (event.type === 'response.completed') {
                event.response.usage = {
                  ...event.response.usage,
                  input_tokens: 10000,
                  output_tokens: 2048,
                  total_tokens: 12048,
                  output_tokens_details: { reasoning_tokens: 1500 },
                };
              }
              return 'data: ' + JSON.stringify(event);
            })
            .join('\n');
          return write(wire, ...args);
        };
        return false;
      },
    });
    const append = f.owners.transcript.appendDurableEvent.bind(f.owners.transcript);
    f.owners.transcript.appendDurableEvent = async (...args) => {
      await append(...args);
      events.push(args[1]);
    };
    try {
      const [source] = await w.work('RAW_INCREMENT_29 offline reasoning continuation');
      f.state.tools = 1;
      f.state.quiet = true;
      // Ciphertext is deliberately large; visible summaries stay empty. Usage is a declared fixture,
      // not a claim about the rendered size of any real provider's encrypted payload.
      f.state.reasoningPadding = 'OPAQUE_FIXTURE '.repeat(6000);
      const session = await f.run(source, AbortSignal.timeout(30000));
      const rows = events.filter((event) => event.type === 'watcher_context_bound');
      assert.ok(
        rows.some((row) => row.accountingBasis === 'reported_continuation' && row.serializedRequestTokens > 25904),
      );
      assert.ok(rows.every((row) => row.workingContextUpperBound <= 30000 && row.maxOutputTokens === 4096));
      assert.equal(
        events.some((event) => event.type === 'watcher_request_budget_rejected'),
        false,
      );
      assert.equal(f.requests.length, 2);
      assert.ok(
        f.requests[1].body.input.some((item) => item.type === 'reasoning' && item.encrypted_content.length > 50000),
      );
      assert.equal(session.watcherState.afterSequence, source.settledSequence);
      assert.equal(f.enqueues.length, 0);
      const wake = (await w.executions.listByParent(`watcher-source:codex:${source.invocationId}`))[0];
      assert.equal(wake.status, 'succeeded');
      assert.equal(wake.terminalReason, 'watcher_checkpoint_committed');
    } finally {
      await f.close();
    }
  },
);

test(
  'the native watcher can nudge through code mode without shell, host globals or delegation',
  { timeout: 45000, skip: !nativeWatcherAvailable },
  async () => {
    const w = await watcherWorld();
    const f = await watcherNativeFixture(w, { model: 'gpt-6.1-sol' });
    try {
      const [source] = await w.work('RAW_INCREMENT_21');
      f.state.tools = 1;
      f.state.codeMode = true;
      const forbidden = join(f.root, 'forbidden-code-mode-write');
      const patch = ['*** Begin Patch', `*** Add File: ${forbidden}`, '+forbidden', '*** End Patch'].join('\n');
      f.state.codeModeProbe = `try{text({patchResult:await tools.apply_patch(${JSON.stringify(patch)})});}catch(error){text({patchError:String(error)});}`;
      f.state.toolPlan = [
        {
          nativeCall: {
            type: 'function_call',
            namespace: 'collaboration',
            name: 'spawn_agent',
            arguments: JSON.stringify({
              task_name: 'forbidden_child',
              message: 'NATIVE_FORBIDDEN_CHILD',
              fork_turns: 'none',
            }),
          },
        },
        { name: 'cat_cafe_watcher_nudge' },
      ];
      const session = await f.run(source, AbortSignal.timeout(30000));
      const outputs = JSON.stringify(f.requests.at(-1).body.input);
      const trace = f.requests.map((request) =>
        request.body.input.filter((item) => item.type.includes('tool_call') || item.type.includes('function_call')),
      );
      assert.equal(f.requests.length, 3, JSON.stringify(trace));
      assert.equal(f.enqueues.length, 1, outputs);
      const message = await w.messages.getById(f.enqueues[0].id);
      assert.equal(message.extra.watcher.sourceInvocationId, source.invocationId);
      assert.match(message.content, /这里有一条具体先例/);
      assert.equal(await w.registry.watcherToolCallCount(message.extra.watcher.watcherInvocationId), 1);
      assert.equal(session.watcherState.afterSequence, source.settledSequence);
      const texts = f.requests
        .at(-1)
        .body.input.filter((item) => item.type === 'custom_tool_call_output')
        .flatMap((item) => item.output)
        .map((item) => item.text ?? item)
        .filter((item) => typeof item === 'string');
      const globalsText = texts.find((text) => text.startsWith('{"process"'));
      assert.ok(globalsText, JSON.stringify(trace));
      const globals = JSON.parse(globalsText);
      const inventory = JSON.parse(texts.find((text) => text.startsWith('{"toolNames"')));
      assert.deepEqual(
        inventory.toolNames,
        [
          ...watcherToolSurface({}).tools.map((tool) => tool.name),
          'apply_patch',
          'clock__curr_time',
          'list_mcp_resources',
          'list_mcp_resource_templates',
          'read_mcp_resource',
        ].sort(),
      );
      for (const name of ['process', 'require', 'fetch', 'shell', 'spawn'])
        assert.equal(globals[name], 'undefined', outputs);
      await assert.rejects(access(forbidden));
      assert.match(texts.join('\n'), /patch(?:Error|Result)/);
      assert.match(texts.join('\n'), /denied|read.only|not permitted|not allowed|outside.*project|sandbox|approval/i);
      const spawnResult = f.requests.at(-1).body.input.find((item) => item.type === 'function_call_output');
      assert.match(JSON.stringify(spawnResult), /unsupported|disabled|not allowed|not enabled/i);
      assert.equal(f.requests.length, 3, 'delegation must not create a child provider request');
      assert.doesNotMatch(outputs, /code-mode host is disabled/);
    } finally {
      await f.close();
    }
  },
);
