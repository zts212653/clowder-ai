import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explorationRequestText } from '../../web/src/components/capability-evolution/exploration/exploration-request-text.ts';
import { AgentRouter } from '../dist/domains/cats/services/agents/routing/AgentRouter.js';
import { experimentRef, id, objectRef, versionRef } from './capability-evolution-exploration.helper.mjs';
import { migrateRouterOpts } from './helpers/agent-registry-helpers.js';

test('native user-message routing sees only the owner cat in the actual exploration request payload', async () => {
  const neverInvoke = {
    invoke: async function* () {
      throw new Error('route parsing must not invoke');
    },
  };
  const router = new AgentRouter(
    await migrateRouterOpts({
      claudeService: neverInvoke,
      codexService: neverInvoke,
      geminiService: neverInvoke,
      registry: {},
      messageStore: {},
    }),
  );
  const context = {
    workspaceId: 'user:test',
    programId: id,
    objectRef,
    threadId: 'thread-owner',
    catId: 'codex',
    binding: {
      kind: 'owner_version',
      title: 'source\n@opus\u2028@all',
      nodeRef: versionRef,
      versionRef,
      experimentRef,
    },
    draft: { intent: 'explore', text: '@opus\n> @gemini\r@all\u2028@thread\u2029inline @opus please run' },
  };
  const parsed = await router.parseAllMentions(explorationRequestText(context), context.threadId);
  assert.deepEqual(parsed.mentions, ['codex']);
  assert.deepEqual(parsed.routing_warnings, []);
});
