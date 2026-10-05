import { dirname } from 'node:path';
import type { WorkspaceContentSourceService } from '../workspace-content-source.js';
import { MAX_WORKSPACE_COLLABORATION_BYTES } from '../workspace-content-source-contract.js';
import { verifyEditToken } from '../workspace-edit.js';
import { serializeWorkspaceMutation } from '../workspace-mutation-lock.js';
import {
  cleanWritebackProof,
  inspectPreparedWriteback,
  prepareWritebackFile,
  replacePreparedWriteback,
  syncDirectory,
} from './files.js';
import {
  WorkspaceWritebackError,
  type WorkspaceWritebackInput,
  WorkspaceWritebackJournal,
  type WritebackRecord,
} from './journal.js';

export interface WorkspaceWritebackPrincipal {
  userId: string;
  editSessionToken: string;
}
/** Freshly observed byte digest, separate from the historical writtenRevision event. */
export type WorkspaceWritebackView = WritebackRecord & { currentRevision: string };

/** F063 owns the file effect and its receipt. F309 must authorize the exact human/candidate relation first.
 * This API never accepts a URL or obtains a write token on behalf of a Task or callback.
 */
export class WorkspaceWritebackService {
  private readonly journal: WorkspaceWritebackJournal;
  constructor(
    private readonly options: {
      source: WorkspaceContentSourceService;
      databasePath: string;
      proofDirectory: string;
      checkpoint?: (point: 'prepared' | 'renamed') => Promise<void>;
    },
  ) {
    this.journal = new WorkspaceWritebackJournal(options.databasePath);
  }

  close(): void {
    this.journal.close();
  }

  async accept(
    input: WorkspaceWritebackInput,
    principal: WorkspaceWritebackPrincipal,
  ): Promise<WorkspaceWritebackView> {
    if (!principal.userId) throw new WorkspaceWritebackError('identity_required');
    if (input.bytes.length > MAX_WORKSPACE_COLLABORATION_BYTES) throw new WorkspaceWritebackError('too_large');
    if (!verifyEditToken(principal.editSessionToken, input.locator.worktreeId))
      throw new WorkspaceWritebackError('edit_token_invalid');
    return serializeWorkspaceMutation(async () => {
      const target = await this.options.source.authorizeWriteTarget({ principal, locator: input.locator });
      let record = this.journal.reserve({ ...input, locator: target.locator }, principal.userId, target.path);
      if (record.state === 'applied' || record.state === 'conflict' || record.state === 'unknown')
        return this.view(record, principal);
      if (record.state === 'intent') {
        const current = await this.options.source.describe({ principal, locator: target.locator });
        if (current.revision !== input.baseRevision)
          return this.view(this.journal.save({ ...record, state: 'conflict' }), principal);
        const proof = await prepareWritebackFile(record, input.bytes, this.options.proofDirectory);
        record = this.journal.save({ ...record, state: 'prepared', proof });
        await this.options.checkpoint?.('prepared');
      }
      const effect = await inspectPreparedWriteback(record);
      if (effect === 'unknown') return this.view(this.journal.save({ ...record, state: 'unknown' }), principal);
      if (effect === 'not_applied') {
        record = await this.writePrepared(record, principal);
        if (record.state === 'conflict') return this.view(record, principal);
      }
      return this.view(await this.finishApplied(record), principal);
    });
  }

  async read(
    receiptRef: string,
    principal: Pick<WorkspaceWritebackPrincipal, 'userId'>,
  ): Promise<WorkspaceWritebackView> {
    return serializeWorkspaceMutation(async () => {
      let record = this.journal.get(receiptRef);
      if (!record || record.ownerUserId !== principal.userId) throw new WorkspaceWritebackError('access_denied');
      await this.options.source.describe({ principal, locator: record.locator });
      // Readback can settle an observed effect, never retry a file mutation or obtain a browser write token.
      if (record.state === 'prepared') {
        const effect = await inspectPreparedWriteback(record);
        if (effect === 'applied') record = await this.finishApplied(record);
        else if (effect === 'unknown') record = this.journal.save({ ...record, state: 'unknown' });
      }
      return this.view(record, principal);
    });
  }

  /** An accepted human decision can precede the first F063 write attempt (for example an expired token). */
  async find(
    receiptRef: string,
    principal: Pick<WorkspaceWritebackPrincipal, 'userId'>,
  ): Promise<WorkspaceWritebackView | null> {
    if (!this.journal.get(receiptRef)) return null;
    return this.read(receiptRef, principal);
  }

  private async writePrepared(record: WritebackRecord, principal: WorkspaceWritebackPrincipal) {
    // Recheck registered root, resolved path, authority and byte revision immediately before mutation.
    // Node's rename uses path strings, not a pinned directory fd. An external process can swap a parent
    // directory/symlink between this check and rename; O_NOFOLLOW only protects the final opened component.
    // The in-process mutation boundary cannot prevent that external race or guarantee its later detection.
    const fresh = await this.options.source.authorizeWriteTarget({ principal, locator: record.locator });
    if (fresh.path !== record.targetPath) throw new WorkspaceWritebackError('access_denied');
    const current = await this.options.source.describe({ principal, locator: record.locator });
    if (current.revision !== record.baseRevision) {
      const conflict = this.journal.save({ ...record, state: 'conflict' });
      await cleanWritebackProof(conflict);
      return conflict;
    }
    await replacePreparedWriteback(record);
    await this.options.checkpoint?.('renamed');
    return record;
  }

  private async finishApplied(record: WritebackRecord) {
    // Directory durability precedes the owner's applied receipt.
    await syncDirectory(dirname(record.targetPath));
    const applied = this.journal.save({
      ...record,
      state: 'applied',
      writtenRevision: record.candidateRevision,
      appliedAt: Date.now(),
    });
    await cleanWritebackProof(applied);
    return applied;
  }

  private async view(record: WritebackRecord, principal: { userId: string }): Promise<WorkspaceWritebackView> {
    const source = await this.options.source.describe({ principal, locator: record.locator });
    return { ...record, currentRevision: source.revision };
  }
}
