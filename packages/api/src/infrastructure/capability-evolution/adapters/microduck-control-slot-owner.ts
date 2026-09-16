import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { type ExactAssetVersionRefV1, type OwnerTruthRefV1, refIdentity } from '@cat-cafe/shared';
import {
  type ControlSlotSnapshotV1,
  exactSame,
  isErrno,
  loadVersion,
  type MicroduckControlSlotVersionV1,
  normalizeVersion,
  parseSnapshot,
  storeVersion,
  targetRef,
  validClientMessageId,
} from './microduck-control-slot-state.js';
import { transitionControlSlotRollback, transitionControlSlotWriteback } from './microduck-control-slot-transitions.js';
import type {
  MicroduckBlocked,
  MicroduckRollbackReceipt,
  MicroduckWritebackReceipt,
} from './microduck-owner-contract.js';

export type { MicroduckControlSlotVersionV1 } from './microduck-control-slot-state.js';

export interface MicroduckControlSlotOwnerOptions {
  readonly dataDir: string;
  readonly initialVersion?: MicroduckControlSlotVersionV1;
  readonly now?: () => string;
}

export interface MicroduckControlSlotRead {
  readonly status: 'resolved';
  readonly targetVersionRef: ExactAssetVersionRefV1;
  readonly version: MicroduckControlSlotVersionV1;
}

export interface MicroduckControlSlotDeploymentRead extends MicroduckControlSlotRead {
  readonly writebackReceiptRef: OwnerTruthRefV1;
  readonly rollbackVersionRef: ExactAssetVersionRefV1;
}

interface WritebackInput {
  readonly expectedTargetVersionRef: ExactAssetVersionRefV1;
  readonly candidateVersion: MicroduckControlSlotVersionV1;
  readonly clientMessageId: string;
}

interface RollbackInput {
  readonly expectedTargetVersionRef: ExactAssetVersionRefV1;
  readonly rollbackVersionRef: ExactAssetVersionRefV1;
  readonly writebackReceiptRef: OwnerTruthRefV1;
  readonly clientMessageId: string;
}

class TransactionQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolveTail) => {
      release = resolveTail;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const queues = new Map<string, TransactionQueue>();
const queueFor = (path: string): TransactionQueue => {
  let queue = queues.get(path);
  if (!queue) {
    queue = new TransactionQueue();
    queues.set(path, queue);
  }
  return queue;
};

const blocked = (code: MicroduckBlocked['code']): MicroduckBlocked => ({ status: 'blocked', code });

export function createMicroduckControlSlotOwner(options: MicroduckControlSlotOwnerOptions) {
  const snapshotPath = resolve(options.dataDir, 'capability-evolution', 'microduck-owner-v1', 'control-slot.json');
  const queue = queueFor(snapshotPath);
  const initialVersion = options.initialVersion ? normalizeVersion(options.initialVersion) : undefined;
  const now = options.now ?? (() => new Date().toISOString());

  const readSnapshot = async (): Promise<ControlSlotSnapshotV1 | undefined> => {
    try {
      return parseSnapshot(await readFile(snapshotPath, 'utf8'));
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) return undefined;
      throw error;
    }
  };

  const writeSnapshot = async (snapshot: ControlSlotSnapshotV1): Promise<void> => {
    const directory = dirname(snapshotPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.control-slot-${process.pid}-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, snapshotPath);
    } catch (error: unknown) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  };

  const baselineSnapshot = (): ControlSlotSnapshotV1 | undefined => {
    if (!initialVersion) return undefined;
    const version = initialVersion.artifactVersionRef.version;
    return {
      schemaVersion: 1,
      currentVersion: version,
      versions: { [version]: storeVersion(initialVersion) },
      operations: {},
    };
  };

  const currentSnapshot = async (): Promise<ControlSlotSnapshotV1 | undefined> =>
    (await readSnapshot()) ?? baselineSnapshot();

  const readCurrent = (): Promise<MicroduckControlSlotRead | MicroduckBlocked> =>
    queue.run(async () => {
      const snapshot = await currentSnapshot();
      if (!snapshot) return blocked('owner_route_unavailable');
      const version = loadVersion(snapshot.versions[snapshot.currentVersion]);
      return { status: 'resolved', targetVersionRef: targetRef(snapshot.currentVersion), version };
    });

  const readDeployment = (input: {
    deployedVersionRef: ExactAssetVersionRefV1;
    writebackReceiptRef: OwnerTruthRefV1;
  }): Promise<MicroduckControlSlotDeploymentRead | undefined> =>
    queue.run(async () => {
      const snapshot = await currentSnapshot();
      if (
        !snapshot?.currentDeploymentReceiptRef ||
        !exactSame(targetRef(snapshot.currentVersion), input.deployedVersionRef) ||
        refIdentity(snapshot.currentDeploymentReceiptRef) !== refIdentity(input.writebackReceiptRef)
      ) {
        return undefined;
      }
      const deployment = Object.values(snapshot.operations)
        .map(({ receipt }) => receipt)
        .find(
          (receipt) =>
            receipt.status === 'deployed' &&
            refIdentity(receipt.writebackReceiptRef) === refIdentity(input.writebackReceiptRef) &&
            exactSame(receipt.deployedVersionRef, input.deployedVersionRef),
        );
      if (!deployment || deployment.status !== 'deployed') return undefined;
      return {
        status: 'resolved',
        targetVersionRef: targetRef(snapshot.currentVersion),
        version: loadVersion(snapshot.versions[snapshot.currentVersion]),
        writebackReceiptRef: deployment.writebackReceiptRef,
        rollbackVersionRef: deployment.rollbackVersionRef,
      };
    });

  const writeback = (input: WritebackInput): Promise<MicroduckWritebackReceipt | MicroduckBlocked> =>
    queue.run(async () => {
      if (!validClientMessageId(input.clientMessageId)) return blocked('writeback_failed');
      let candidateVersion: MicroduckControlSlotVersionV1;
      try {
        candidateVersion = normalizeVersion(input.candidateVersion);
      } catch {
        return blocked('artifact_hash_mismatch');
      }
      const snapshot = await currentSnapshot();
      if (!snapshot) return blocked('owner_route_unavailable');
      const transition = transitionControlSlotWriteback(snapshot, {
        ...input,
        candidateVersion,
        deployedAt: now(),
      });
      if (transition.status === 'blocked') return transition;
      if (transition.snapshot !== snapshot) await writeSnapshot(transition.snapshot);
      return transition.receipt;
    });

  const rollback = (input: RollbackInput): Promise<MicroduckRollbackReceipt | MicroduckBlocked> =>
    queue.run(async () => {
      if (!validClientMessageId(input.clientMessageId)) return blocked('rollback_failed');
      const snapshot = await currentSnapshot();
      if (!snapshot) return blocked('owner_route_unavailable');
      const transition = transitionControlSlotRollback(snapshot, input);
      if (transition.status === 'blocked') return transition;
      if (transition.snapshot !== snapshot) await writeSnapshot(transition.snapshot);
      return transition.receipt;
    });

  return { readCurrent, readDeployment, writeback, rollback };
}

export type MicroduckControlSlotOwner = ReturnType<typeof createMicroduckControlSlotOwner>;
