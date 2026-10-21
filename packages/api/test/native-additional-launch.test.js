import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { KimiAgentService } from '../dist/domains/cats/services/agents/providers/KimiAgentService.js';
import { OpenCodeAgentService } from '../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';
import {
  buildFakeL0Compiler,
  collect,
  createMockArchive,
  createMockProcess,
  createMockSpawnFn,
  emitEvents,
} from './helpers/provider-archive-test-helpers.js';

for (const clientId of ['kimi', 'opencode']) {
  test(`native ${clientId} launch leaves the model with the CLI and retains an explicit override`, async () => {
    ensureFakeCliOnPath(clientId);
    const root = mkdtempSync(join(tmpdir(), 'native-additional-launch-'));
    const config = join(root, 'kimi.toml');
    writeFileSync(config, 'default_model="native-user-selected-model"\n[models.selected-fast]\nprovider="native"\n');
    const id = `native-${clientId}-launch`;
    catRegistry.register(id, {
      ...catRegistry.tryGet('opus').config,
      id,
      clientId,
      configurationSource: 'native_tool',
      defaultModel: '',
      cli: { command: clientId, outputFormat: 'stream-json' },
    });
    const Service = clientId === 'kimi' ? KimiAgentService : OpenCodeAgentService;
    for (const model of ['', 'selected-fast', 'fixture/explicit']) {
      const proc = createMockProcess();
      const spawnFn = createMockSpawnFn(proc);
      const service = new Service({
        catId: id,
        model,
        spawnFn,
        mcpServerPath: '',
        l0CompilerFn: buildFakeL0Compiler(),
        rawArchive: createMockArchive(),
      });
      const pending = collect(
        service.invoke('test-owned prompt', {
          workingDirectory: root,
          callbackEnv: { KIMI_CONFIG_FILE: config, KIMI_SHARE_DIR: root },
        }),
      );
      await emitEvents(
        proc,
        clientId === 'kimi'
          ? [{ role: 'assistant', content: [{ type: 'text', text: '42' }] }]
          : [{ type: 'text', sessionID: 'fixture-native', part: { type: 'text', text: '42' } }],
      );
      const messages = await pending;
      assert.ok(messages.some((message) => message.type === 'done'));
      const [, args] = spawnFn.mock.calls[0].arguments;
      const modelIndex = args.findIndex((arg) => arg === '--model' || arg === '-m');
      if (model) assert.equal(args[modelIndex + 1], model);
      else assert.equal(modelIndex, -1, `native ${clientId} must not replace the CLI default`);
    }
  });
}
