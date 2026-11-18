import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MatterMemoryService } from '../../dist/domains/memory/matters/MatterMemoryService.js';
import { matterOpeningDirectory } from '../../dist/domains/memory/matters/matter-opening-directory.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
export const actor = { userId: 'owner', viewer: { type: 'cat', catId: 'codex61-sol' } };
export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'f332-opening-cache-'));
  const evidence = new SqliteEvidenceStore(join(root, 'memory.sqlite'));
  await evidence.initialize();
  t.after(async () => {
    await evidence.close();
    await rm(root, { recursive: true, force: true });
  });
  const messages = new Map();
  const service = new MatterMemoryService({
    db: evidence.getDb(),
    runWrite: (op) => evidence.runExclusive(op),
    messageStore: { getById: async (id) => messages.get(id) ?? null },
    threadStore: { get: async (id) => ({ id, createdBy: 'owner' }), list: () => [] },
  });
  let sequence = 0;
  return {
    service,
    async create(title, description = 'original summary') {
      const message = {
        id: `source-${sequence++}`,
        threadId: 'here',
        userId: 'owner',
        from: { kind: 'user', userId: 'owner' },
        content: 'synthetic original',
        timestamp: 1,
        mentions: [],
      };
      messages.set(message.id, message);
      const receipt = await service.write(actor, {
        operation: 'create',
        requestId: message.id,
        title,
        description,
        sources: [
          {
            threadId: 'here',
            messageId: message.id,
            segment: 'body',
            start: 0,
            end: message.content.length,
            quote: message.content,
          },
        ],
      });
      return { message, matterId: receipt.matter.matterId };
    },
  };
}
export function failCatalog(t, service) {
  const error = new Error('fresh-directory-unavailable');
  t.mock.method(service, 'catalog', async () => {
    throw error;
  });
  return error;
}
export const read = (service, extra = {}) => matterOpeningDirectory(service, 'owner', 'codex61-sol', 'here', extra);
export const items = (text) =>
  JSON.parse(text.split('\n').find((line) => line.startsWith('{'))).groups.flatMap((group) => group.items);
