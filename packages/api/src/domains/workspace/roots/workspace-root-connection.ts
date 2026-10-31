import { realpathSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  canonicalLinkedRootId,
  findLinkedRootAt,
  mutateLinkedRootState,
  type RootConnectionReceipt,
  type RootConnectionSource,
  readLinkedRootState,
  rootConnectionReceiptRef,
} from './workspace-linked-root-store.js';
import { removedWorkspaceAncestor } from './workspace-root-history.js';

export class WorkspaceRootConnectionConflict extends Error {
  constructor(
    readonly code:
      | 'operation_reused'
      | 'root_changed'
      | 'connection_changed'
      | 'root_not_canonical'
      | 'ancestor_connection_removed',
    message: string,
    readonly currentEpoch?: number,
  ) {
    super(message);
  }
}

function result(
  receipt: RootConnectionReceipt,
  roots: Array<{ id?: string; name: string; path: string }>,
  currentEpoch: number,
) {
  const connected = roots.some((entry) => entry.id === receipt.rootId && entry.path === receipt.root);
  return {
    receiptRef: receipt.receiptRef,
    ownerUserId: receipt.userId,
    operationId: receipt.operationId,
    currentEpoch,
    connected,
    root: receipt.root,
    ...(receipt.source ? { source: receipt.source } : {}),
    linked: { id: receipt.rootId, root: receipt.root, branch: basename(receipt.root), head: 'linked' },
  };
}

export async function readRootConnection(userId: string, operationId: string) {
  const state = await readLinkedRootState();
  const receipt = state.operations.find((entry) => entry.receiptRef === rootConnectionReceiptRef(userId, operationId));
  return receipt ? result(receipt, state.roots, state.rootEpochs[receipt.rootId] ?? 0) : null;
}

export async function connectWorkspaceRoot(
  userId: string,
  operationId: string,
  requestedRoot: string,
  expectedEpoch: number,
  source: RootConnectionSource = { kind: 'directory-selection' },
) {
  const admission = source.kind === 'absolute-file' ? 'absolute-file-directory' : undefined;
  return mutateLinkedRootState((state) => {
    const receiptRef = rootConnectionReceiptRef(userId, operationId);
    const previous = state.operations.find((entry) => entry.receiptRef === receiptRef);
    if (previous) {
      if (
        previous.userId !== userId ||
        previous.operationId !== operationId ||
        previous.requestedRoot !== requestedRoot ||
        previous.expectedEpoch !== expectedEpoch ||
        previous.admission !== admission ||
        JSON.stringify(previous.source) !== JSON.stringify(source)
      )
        throw new WorkspaceRootConnectionConflict(
          'operation_reused',
          'Connection operation was already used for another root',
        );
      return { value: result(previous, state.roots, state.rootEpochs[previous.rootId] ?? 0), changed: false };
    }
    if (resolve(requestedRoot) !== requestedRoot)
      throw new WorkspaceRootConnectionConflict('root_not_canonical', 'Use the exact directory shown by Workspace');
    const root = realpathSync(requestedRoot);
    if (root !== requestedRoot || !statSync(root).isDirectory())
      throw new WorkspaceRootConnectionConflict('root_changed', 'Selected root changed; select the location again');
    const rootId = canonicalLinkedRootId(root);
    const existing = findLinkedRootAt(state, root);
    if (!existing && admission === 'absolute-file-directory' && removedWorkspaceAncestor(state, root))
      throw new WorkspaceRootConnectionConflict(
        'ancestor_connection_removed',
        'A containing directory was disconnected; reopen the original file location',
      );
    if (!existing && (state.rootEpochs[rootId] ?? 0) !== expectedEpoch)
      throw new WorkspaceRootConnectionConflict(
        'connection_changed',
        'The connection changed after this choice; confirm it again',
        state.rootEpochs[rootId] ?? 0,
      );
    const name = existing?.name ?? (basename(root) || root);
    if (!existing) {
      state.roots.push({ id: rootId, name, path: root });
      state.rootEpochs[rootId] = expectedEpoch + 1;
    } else {
      if (!existing.id) existing.legacyAliases = [`linked_${existing.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`];
      existing.id = rootId;
      existing.path = root;
    }
    const receipt: RootConnectionReceipt = {
      receiptRef,
      userId,
      operationId,
      requestedRoot,
      root,
      rootId,
      name,
      expectedEpoch,
      source,
      ...(admission ? { admission } : {}),
    };
    state.operations.push(receipt);
    return { value: result(receipt, state.roots, state.rootEpochs[rootId] ?? 0), changed: true };
  });
}
