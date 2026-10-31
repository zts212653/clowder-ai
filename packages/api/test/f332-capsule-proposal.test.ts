import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { SessionMutex } from '../src/domains/cats/services/agents/invocation/SessionMutex.js';
import { approveProfileUpdate } from '../src/domains/cats/services/profile/approveProfileUpdate.js';
import { FileProfileRepository } from '../src/domains/cats/services/profile/ProfileRepository.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { InMemoryProfileUpdateProposalStore } from '../src/domains/cats/services/stores/ports/ProfileUpdateProposalStore.js';
import { registerCallbackAuthHook } from '../src/routes/callback-auth-prehandler.js';
import { registerCallbackProposeProfileUpdateRoutes } from '../src/routes/callback-propose-profile-update-routes.js';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

let app: FastifyInstance;
let repository: FileProfileRepository;
let dataDir: string;
let registry: InvocationRegistry;
let store: InMemoryProfileUpdateProposalStore;
let messages: MessageStore;
let lock: SessionMutex;
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'f332-capsule-proposal-'));
  repository = new FileProfileRepository({ dataDir, relationshipKeyForCat: () => 'example-persona' });
  registry = new InvocationRegistry();
  store = new InMemoryProfileUpdateProposalStore();
  messages = new MessageStore();
  lock = new SessionMutex();
  app = Fastify();
  registerCallbackAuthHook(app, registry);
  registerCallbackProposeProfileUpdateRoutes(app, {
    registry,
    proposalStore: store,
    messageStore: messages,
    repository,
    socketManager: { emitToUser() {}, broadcastToRoom() {} },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});
async function propose(content: string, owner = 'capsule-owner') {
  const source = messages.append(
    canonicalTestMessageInput({
      userId: owner,
      catId: null,
      content: '请起草我的开场胶囊。',
      mentions: [],
      timestamp: 1,
      threadId: 'capsule-thread',
    }),
  );
  const auth = await registry.create(owner, 'opus', 'capsule-thread', undefined, source.id);
  return app.inject({
    method: 'POST',
    url: '/api/callbacks/propose-profile-update',
    headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
    payload: {
      targetLayer: 'capsule',
      afterContent: content,
      rationale: '来自这次对话的本人要求。',
      signalKind: 'cvo-instructed',
    },
  });
}
test('cat draft is owner-private and remains inactive until the existing approval flow commits it', async () => {
  const response = await propose('示例用户习惯先看图。');
  assert.equal(response.statusCode, 200, response.body);
  const proposal = store.get(response.json().proposalId)!;
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.targetPath, 'capsule.md');
  assert.ok(proposal.publication?.state === 'anchored');
  assert.equal(repository.readCapsule('capsule-owner'), null);
  assert.equal(repository.readCapsule('other-owner'), null);
  const result = await approveProfileUpdate(proposal.proposalId, 'capsule-owner', { store, lock, repository });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(repository.readCapsule('capsule-owner')?.content, proposal.afterContent);
  assert.equal(repository.readCapsule('other-owner'), null);
  assert.equal(readFileSync(repository.capsulePath('capsule-owner'), 'utf8'), proposal.afterContent);
});
test('legacy input pins the approval base; approval writes the neutral name and detects intervening edits', async () => {
  mkdirSync(repository.profileDir('capsule-owner'), { recursive: true });
  writeFileSync(join(repository.profileDir('capsule-owner'), 'operator-capsule.md'), '原胶囊。');
  const first = await propose('新版胶囊。');
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(store.get(first.json().proposalId)?.beforeContent, '原胶囊。');
  const result = await approveProfileUpdate(first.json().proposalId, 'capsule-owner', { store, lock, repository });
  assert.equal(result.ok, true, JSON.stringify(result));
  const stale = await propose('会过期的建议。');
  writeFileSync(repository.capsulePath('capsule-owner'), '本人刚修改的内容。');
  const blocked = await approveProfileUpdate(stale.json().proposalId, 'capsule-owner', { store, lock, repository });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.reason, 'stale_hash');
  assert.equal(repository.readCapsule('capsule-owner')?.content, '本人刚修改的内容。');
});
test('invalid or oversized drafts never create a pending approval; rejection never writes a capsule', async () => {
  for (const content of ['猫'.repeat(301), '  \n ']) {
    const response = await propose(content);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, 'invalid_content');
  }
  const response = await propose('可以拒绝的示例。');
  assert.equal(response.statusCode, 200, response.body);
  const id = response.json().proposalId;
  store.markRejected(id, 'capsule-owner', '这句不适合我。');
  const result = await approveProfileUpdate(id, 'capsule-owner', { store, lock, repository });
  assert.equal(result.ok, false);
  assert.equal(repository.readCapsule('capsule-owner'), null);
});
