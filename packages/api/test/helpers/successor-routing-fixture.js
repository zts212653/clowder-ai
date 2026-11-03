import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';
import {
  _resetCachedConfig,
  clearRuntimeDefaultCatId,
  loadCatConfig,
  toAllCatConfigs,
} from '../../dist/config/cat-config-loader.js';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InMemoryQueueLedgerStore } from '../../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { AgentRegistry } from '../../dist/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../../dist/domains/cats/services/agents/routing/AgentRouter.js';
import { InvocationRecordStore } from '../../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';

export function successorFixture(t, rosterOverrides = {}, ledger = new InMemoryQueueLedgerStore()) {
  const oldTemplate = process.env.CAT_TEMPLATE_PATH;
  const oldDefault = process.env.DEFAULT_CAT_ID;
  const oldConfigs = catRegistry.getAllConfigs();
  const template = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../../cat-template.json', import.meta.url)), 'utf8'),
  );
  const breed = template.breeds.find((entry) => entry.catId === 'opus');
  breed.variants.push({
    ...breed.variants[0],
    id: 'successor-fixture',
    catId: 'opus-5',
    mentionPatterns: ['@opus-5', '@opus5'],
  });
  template.roster.opus = { ...template.roster.opus, available: false, successor: 'opus-5' };
  template.roster['opus-5'] = { ...template.roster.opus, available: true, lead: false };
  delete template.roster['opus-5'].successor;
  Object.entries(rosterOverrides).forEach(([id, values]) => {
    template.roster[id] = { ...template.roster[id], ...values };
  });
  const root = mkdtempSync(join(tmpdir(), 'issue1292-'));
  const templatePath = join(root, 'cat-template.json');
  writeFileSync(templatePath, JSON.stringify(template));
  process.env.CAT_TEMPLATE_PATH = templatePath;
  process.env.DEFAULT_CAT_ID = 'opus';
  clearRuntimeDefaultCatId();
  _resetCachedConfig();
  const configs = toAllCatConfigs(loadCatConfig(templatePath));
  catRegistry.reset();
  Object.entries(configs).forEach(([id, config]) => catRegistry.register(id, config));
  t.after(() => {
    if (oldTemplate === undefined) delete process.env.CAT_TEMPLATE_PATH;
    else process.env.CAT_TEMPLATE_PATH = oldTemplate;
    if (oldDefault === undefined) delete process.env.DEFAULT_CAT_ID;
    else process.env.DEFAULT_CAT_ID = oldDefault;
    catRegistry.reset();
    Object.entries(oldConfigs).forEach(([id, config]) => catRegistry.register(id, config));
    _resetCachedConfig();
    clearRuntimeDefaultCatId();
  });
  const messages = new MessageStore();
  const threads = new ThreadStore();
  const thread = threads.create('owner');
  const calls = [];
  const agents = new AgentRegistry();
  const response = JSON.stringify({
    segments: [{ speaker: '宪宪', text: '脚本内容', durationEstimate: 3 }],
    totalDuration: 3,
  });
  ['opus', 'opus-5', 'codex'].forEach((catId) =>
    agents.register(catId, {
      async *invoke() {
        calls.push(catId);
        yield { type: 'session_init', catId, sessionId: `test-${catId}`, timestamp: Date.now() };
        yield { type: 'text', catId, content: response, timestamp: Date.now() };
        yield { type: 'done', catId, isFinal: true, timestamp: Date.now() };
      },
    }),
  );
  const router = new AgentRouter({
    agentRegistry: agents,
    registry: new InvocationRegistry(),
    messageStore: messages,
    threadStore: threads,
  });
  const queue = new InvocationQueue(ledger, {
    resolveTargets: (...args) => router.resolveSendTargets(...args),
    resolvePreResolvedTargets: (...args) => router.resolveAdmissionTargets(...args),
  });
  const socketManager = { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} };
  const processor = new QueueProcessor({
    queue,
    router,
    invocationTracker: new InvocationTracker(),
    invocationRecordStore: new InvocationRecordStore(),
    messageStore: messages,
    threadStore: threads,
    socketManager,
    log: { info() {}, warn() {}, error() {} },
  });
  return {
    template,
    templatePath,
    root,
    router,
    queue,
    ledger,
    processor,
    messages,
    threads,
    threadId: thread.id,
    calls,
  };
}

export function privateInput(threadId, overrides = {}) {
  return {
    threadId,
    userId: 'owner',
    from: { kind: 'system', service: 'test' },
    kind: 'private_input',
    ownerAuthProvenance: 'strict',
    content: 'work',
    targetCats: ['opus'],
    intent: 'execute',
    autoExecute: true,
    idempotencyKey: 'private-work',
    ...overrides,
  };
}
