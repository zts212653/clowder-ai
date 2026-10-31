import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContentActorV1 } from '../video-studio/content-owner/types.js';
import type { CollaborativeContentOperationV1 } from './patch-service.js';

export class SemanticOperationReuseError extends Error {}
interface SemanticIntent {
  readonly version: 1;
  readonly fingerprint: string;
  readonly timestamp: string;
}

/** Persists only semantic request identity/time. F138 remains the sole source of
 * candidate bytes, committed revisions and settlement receipts. No TTL or replay window.
 */
export class SemanticOperationStore {
  constructor(
    private readonly dataDir: string,
    private readonly now = () => new Date().toISOString(),
  ) {}

  async prepare(input: {
    readonly contentRef: string;
    readonly actor: ContentActorV1;
    readonly operationId: string;
    readonly expectedOwnerRevision: number;
    readonly operation: Exclude<CollaborativeContentOperationV1, { readonly kind: 'direct-settlement' }>;
  }): Promise<{ readonly operationId: string; readonly timestamp: string }> {
    if (
      !input.operationId ||
      input.operationId.length > 128 ||
      !Number.isSafeInteger(input.expectedOwnerRevision) ||
      input.expectedOwnerRevision < 1
    ) {
      throw new TypeError('Invalid semantic operation identity');
    }
    const op = input.operation;
    const key = hash([input.contentRef, input.actor.kind, input.actor.actorId, input.operationId]);
    const fingerprint = hash([
      input.expectedOwnerRevision,
      op.kind,
      op.target.paragraphId,
      op.target.textQuote,
      op.kind === 'comment' ? op.body : op.replacement,
    ]);
    const directory = join(this.dataDir, 'projects', 'collaborative-content-v1', 'semantic-intents');
    const target = join(directory, `${key}.json`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `${key}.${randomUUID()}.tmp`);
    const intent: SemanticIntent = { version: 1, fingerprint, timestamp: this.now() };
    if (!validIntent(intent)) throw new Error('Invalid semantic intent timestamp');
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(intent));
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const parent = await open(directory, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await unlink(temporary).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
    const stored: unknown = JSON.parse(await readFile(target, 'utf8'));
    if (!validIntent(stored)) throw new Error('Invalid durable semantic intent');
    if (stored.fingerprint !== fingerprint) throw new SemanticOperationReuseError('Semantic operation id reused');
    return { operationId: `semantic:${key}`, timestamp: stored.timestamp };
  }
}

function hash(value: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function validIntent(value: unknown): value is SemanticIntent {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    row.version === 1 &&
    typeof row.fingerprint === 'string' &&
    /^[a-f0-9]{64}$/.test(row.fingerprint) &&
    typeof row.timestamp === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.timestamp) &&
    Number.isFinite(Date.parse(row.timestamp))
  );
}
