import { type ExactAssetVersionRefV1, type OwnerTruthRefV1, refIdentity } from '@cat-cafe/shared';
import {
  type ControlSlotSnapshotV1,
  canonicalJson,
  exactSame,
  fingerprint,
  loadVersion,
  type MicroduckControlSlotVersionV1,
  receiptRef,
  sha256,
  storeVersion,
  targetRef,
} from './microduck-control-slot-state.js';
import type {
  MicroduckBlocked,
  MicroduckRollbackReceipt,
  MicroduckWritebackReceipt,
} from './microduck-owner-contract.js';
import { exactRef } from './microduck-owner-validation.js';

type TransitionResult<T> =
  | { readonly status: 'committed'; readonly snapshot: ControlSlotSnapshotV1; readonly receipt: T }
  | MicroduckBlocked;

function blocked(code: MicroduckBlocked['code']): MicroduckBlocked {
  return { status: 'blocked', code };
}

function replayedWriteback(
  snapshot: ControlSlotSnapshotV1,
  clientMessageId: string,
  operationFingerprint: string,
): MicroduckWritebackReceipt | MicroduckBlocked | undefined {
  const operation = snapshot.operations[clientMessageId];
  if (!operation) return undefined;
  if (operation.fingerprint !== operationFingerprint || operation.receipt.status !== 'deployed') {
    return blocked('writeback_failed');
  }
  return snapshot.currentOperationClientMessageId === clientMessageId &&
    snapshot.currentDeploymentReceiptRef &&
    refIdentity(snapshot.currentDeploymentReceiptRef) === refIdentity(operation.receipt.writebackReceiptRef) &&
    exactSame(targetRef(snapshot.currentVersion), operation.receipt.deployedVersionRef)
    ? operation.receipt
    : blocked('writeback_failed');
}

function replayedRollback(
  snapshot: ControlSlotSnapshotV1,
  clientMessageId: string,
  operationFingerprint: string,
): MicroduckRollbackReceipt | MicroduckBlocked | undefined {
  const operation = snapshot.operations[clientMessageId];
  if (!operation) return undefined;
  if (operation.fingerprint !== operationFingerprint || operation.receipt.status !== 'rolled_back') {
    return blocked('rollback_failed');
  }
  return snapshot.currentOperationClientMessageId === clientMessageId &&
    !snapshot.currentDeploymentReceiptRef &&
    exactSame(
      loadVersion(snapshot.versions[snapshot.currentVersion]).artifactVersionRef,
      operation.receipt.restoredVersionRef,
    )
    ? operation.receipt
    : blocked('rollback_failed');
}

export function transitionControlSlotWriteback(
  snapshot: ControlSlotSnapshotV1,
  input: {
    expectedTargetVersionRef: ExactAssetVersionRefV1;
    candidateVersion: MicroduckControlSlotVersionV1;
    clientMessageId: string;
    deployedAt: string;
  },
): TransitionResult<MicroduckWritebackReceipt> {
  const operationFingerprint = fingerprint({
    kind: 'writeback',
    expectedTargetVersionRef: input.expectedTargetVersionRef,
    candidateVersion: storeVersion(input.candidateVersion),
  });
  const replay = replayedWriteback(snapshot, input.clientMessageId, operationFingerprint);
  if (replay) {
    return replay.status === 'deployed' ? { status: 'committed', snapshot, receipt: replay } : replay;
  }
  if (!exactSame(input.expectedTargetVersionRef, targetRef(snapshot.currentVersion))) return blocked('target_drift');
  if (snapshot.currentVersion === input.candidateVersion.artifactVersionRef.version) {
    return blocked('writeback_failed');
  }
  const rollbackVersionRef = loadVersion(snapshot.versions[snapshot.currentVersion]).artifactVersionRef;
  const digest = sha256(
    canonicalJson({
      clientMessageId: input.clientMessageId,
      deployedArtifactVersionRef: input.candidateVersion.artifactVersionRef,
      deployedAt: input.deployedAt,
      expectedTargetVersionRef: input.expectedTargetVersionRef,
      operation: 'writeback',
      rollbackVersionRef,
      schemaVersion: 1,
    }),
  );
  const receipt: MicroduckWritebackReceipt = {
    status: 'deployed',
    writebackReceiptRef: receiptRef('deploy', digest),
    deployedVersionRef: targetRef(input.candidateVersion.artifactVersionRef.version),
    rollbackVersionRef,
    deployedArtifactSha256: input.candidateVersion.artifactVersionRef.version,
    deployedAt: input.deployedAt,
  };
  return {
    status: 'committed',
    receipt,
    snapshot: {
      schemaVersion: 1,
      currentVersion: input.candidateVersion.artifactVersionRef.version,
      currentOperationClientMessageId: input.clientMessageId,
      currentDeploymentReceiptRef: receipt.writebackReceiptRef,
      versions: {
        ...snapshot.versions,
        [input.candidateVersion.artifactVersionRef.version]: storeVersion(input.candidateVersion),
      },
      operations: {
        ...snapshot.operations,
        [input.clientMessageId]: { fingerprint: operationFingerprint, receipt },
      },
    },
  };
}

export function transitionControlSlotRollback(
  snapshot: ControlSlotSnapshotV1,
  input: {
    expectedTargetVersionRef: ExactAssetVersionRefV1;
    rollbackVersionRef: ExactAssetVersionRefV1;
    writebackReceiptRef: OwnerTruthRefV1;
    clientMessageId: string;
  },
): TransitionResult<MicroduckRollbackReceipt> {
  const operationFingerprint = fingerprint({
    kind: 'rollback',
    expectedTargetVersionRef: input.expectedTargetVersionRef,
    rollbackVersionRef: input.rollbackVersionRef,
    writebackReceiptRef: input.writebackReceiptRef,
  });
  const replay = replayedRollback(snapshot, input.clientMessageId, operationFingerprint);
  if (replay) {
    return replay.status === 'rolled_back' ? { status: 'committed', snapshot, receipt: replay } : replay;
  }
  const deployment = Object.values(snapshot.operations)
    .map(({ receipt }) => receipt)
    .find(
      (receipt) =>
        receipt.status === 'deployed' &&
        snapshot.currentDeploymentReceiptRef !== undefined &&
        refIdentity(receipt.writebackReceiptRef) === refIdentity(snapshot.currentDeploymentReceiptRef),
    );
  if (
    !snapshot.currentDeploymentReceiptRef ||
    refIdentity(snapshot.currentDeploymentReceiptRef) !== refIdentity(input.writebackReceiptRef) ||
    !deployment ||
    deployment.status !== 'deployed' ||
    !exactSame(deployment.deployedVersionRef, input.expectedTargetVersionRef) ||
    !exactSame(deployment.rollbackVersionRef, input.rollbackVersionRef) ||
    !exactSame(input.expectedTargetVersionRef, targetRef(snapshot.currentVersion))
  ) {
    return blocked('target_drift');
  }
  const restored = snapshot.versions[input.rollbackVersionRef.version];
  if (!restored || !exactSame(loadVersion(restored).artifactVersionRef, input.rollbackVersionRef)) {
    return blocked('rollback_failed');
  }
  const digest = sha256(
    canonicalJson({
      clientMessageId: input.clientMessageId,
      expectedTargetVersionRef: input.expectedTargetVersionRef,
      operation: 'rollback',
      restoredVersionRef: input.rollbackVersionRef,
      writebackReceiptRef: input.writebackReceiptRef,
      schemaVersion: 1,
    }),
  );
  const receipt: MicroduckRollbackReceipt = {
    status: 'rolled_back',
    rollbackReceiptRef: receiptRef('rollback-receipt', digest),
    restoredVersionRef: exactRef(input.rollbackVersionRef),
  };
  const { currentDeploymentReceiptRef: _currentDeploymentReceiptRef, ...rest } = snapshot;
  return {
    status: 'committed',
    receipt,
    snapshot: {
      ...rest,
      currentVersion: input.rollbackVersionRef.version,
      currentOperationClientMessageId: input.clientMessageId,
      operations: {
        ...snapshot.operations,
        [input.clientMessageId]: { fingerprint: operationFingerprint, receipt },
      },
    },
  };
}
