import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mock, test } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import { ClaudeAgentService } from '../dist/domains/cats/services/agents/providers/ClaudeAgentService.js';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';
import {
  buildFakeL0Compiler,
  collect,
  createMockArchive,
  createMockProcess,
  emitEvents,
} from './helpers/provider-archive-test-helpers.js';

test(
  'native Claude print inheritance reaches the CLI without an empty schema model family',
  {
    skip: process.platform === 'win32' ? 'Owned version witness uses a POSIX CLI script' : false,
  },
  async () => {
    const command = ensureFakeCliOnPath('claude');
    writeFileSync(command, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.302 (Claude Code)"; fi\n');
    const base = catRegistry.tryGet('opus');
    assert.ok(base);
    const id = createCatId('native-print-inherit');
    catRegistry.register(id, {
      ...base.config,
      id,
      configurationSource: 'native_tool',
      defaultModel: '',
      cli: { command: 'claude', outputFormat: 'stream-json' },
    });
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => {
      setImmediate(
        () =>
          void emitEvents(proc, [
            { type: 'assistant', message: { content: [{ type: 'text', text: 'native reply' }] } },
            { type: 'result', subtype: 'success' },
          ]),
      );
      return proc;
    });
    const service = new ClaudeAgentService({
      catId: id,
      model: '',
      spawnFn,
      l0CompilerFn: buildFakeL0Compiler(),
      rawArchive: createMockArchive(),
    });
    let prepared;
    const messages = await collect(
      service.invoke('small goal', {
        beforeProviderLaunch: async (request) => {
          prepared = request;
        },
      }),
    );
    assert.deepEqual(
      messages.filter((m) => m.type === 'error'),
      [],
    );
    assert.equal(spawnFn.mock.calls.length, 1);
    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(!args.includes('--model'), 'native CLI must inherit its own configured model');
    assert.ok(!args.includes('--effort'), 'native CLI must inherit its own configured effort');
    assert.equal(prepared.tools.schemaDelivery.hostVersion, '2.1.302', 'exercise the validated capability path');
    assert.equal(prepared.runtime.model, undefined, 'provider-default must not become a requested model');
    assert.ok(messages.some((m) => m.type === 'text' && m.content === 'native reply'));
    assert.equal(messages.at(-1)?.type, 'done');
  },
);
