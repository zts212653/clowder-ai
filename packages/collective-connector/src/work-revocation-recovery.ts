import { createHash } from 'node:crypto';
import type { CollectiveWorkPolicy } from '@cat-cafe/shared';
import type { ConnectorPersistence } from './persistence.js';
import { ConnectorTransportError } from './service-client.js';
import type { ConnectorConnectionState } from './state.js';
import type { CollectiveWorkAuthorityClient } from './work-authority-client.js';
import type { ConnectorWorkCustody } from './work-custody-state.js';

type Revocation = ConnectorWorkCustody['revocations'][number];

/** Confirm contractions without adopting any response policy. CAS retries retain their exact grant versions. */
export async function flushWorkRevocations(
  persistence: ConnectorPersistence,
  service: CollectiveWorkAuthorityClient,
  connection: ConnectorConnectionState & { endpointCredential: string },
  recoverConflicts: boolean,
) {
  const coordinates = {
    serviceInstanceId: connection.serviceInstanceId,
    collectiveId: connection.collectiveId,
    connectionId: connection.connectionId,
  };
  let conflicts = 0;
  while (true) {
    const custody = persistence.snapshot().connections[connection.connectionId].workCustody;
    const operation = custody?.revocations.find((item) => item.status === 'pending');
    if (!custody || !operation) return;
    const conflict = await sendRevocation(persistence, service, connection, operation);
    if (!conflict) continue;
    if (!recoverConflicts) throw conflict;
    // Another policy edit may race every retry; local contraction stays effective without wedging other recovery.
    if (conflicts++ === 3) return;
    const policy = await service.readPolicy(connection.serviceUrl, connection.endpointCredential, coordinates);
    if (!policy || policy.ownerHumanId !== connection.authorizedHumanId) throw conflict;
    await supersedeRevocation(persistence, connection.connectionId, operation, custody, policy);
  }
}

async function sendRevocation(
  persistence: ConnectorPersistence,
  service: CollectiveWorkAuthorityClient,
  connection: ConnectorConnectionState & { endpointCredential: string },
  operation: Revocation,
) {
  try {
    await service.revokePolicy(connection.serviceUrl, connection.endpointCredential, {
      serviceInstanceId: connection.serviceInstanceId,
      collectiveId: connection.collectiveId,
      connectionId: connection.connectionId,
      requestId: operation.requestId,
      expectedRevision: operation.expectedRevision,
      grantRefs: operation.grantRefs,
    });
  } catch (error) {
    if (error instanceof ConnectorTransportError && error.causeCode === 'WORK_POLICY_REVISION_CONFLICT') return error;
    throw error;
  }
  await persistence.transaction((state) => {
    const current = state.connections[connection.connectionId].workCustody?.revocations.find(
      (item) => item.requestId === operation.requestId,
    );
    if (current) current.status = 'confirmed';
  });
  return undefined;
}

function legacyTargets(custody: ConnectorWorkCustody, operation: Revocation) {
  const adopted = custody.adoptedPolicy;
  if (adopted?.revision !== operation.expectedRevision) return undefined;
  const grants = adopted.grants.filter((grant) => operation.grantRefs.includes(grant.grantRef));
  if (grants.length !== operation.grantRefs.length) return undefined;
  return grants.map(({ grantRef, grantRevision }) => ({ grantRef, grantRevision }));
}

async function supersedeRevocation(
  persistence: ConnectorPersistence,
  connectionId: string,
  operation: Revocation,
  custody: ConnectorWorkCustody,
  policy: CollectiveWorkPolicy,
) {
  const targets = operation.targets ?? legacyTargets(custody, operation);
  const remaining = targets?.filter((target) =>
    policy.grants.some(
      (grant) =>
        grant.grantRef === target.grantRef && grant.grantRevision === target.grantRevision && grant.status === 'active',
    ),
  );
  const replacement: Revocation | undefined = remaining?.length
    ? {
        requestId: `host-revoke:retry:${createHash('sha256')
          .update(JSON.stringify([operation.requestId, policy.revision, remaining]))
          .digest('hex')}`,
        expectedRevision: policy.revision,
        grantRefs: remaining.map((target) => target.grantRef),
        targets: remaining,
        status: 'pending',
      }
    : undefined;
  await persistence.transaction((state) => {
    const currentCustody = state.connections[connectionId].workCustody;
    if (!currentCustody) return;
    const current = currentCustody.revocations.find((item) => item.requestId === operation.requestId);
    if (!current || current.status !== 'pending') return;
    current.status = targets ? 'superseded' : 'blocked';
    current.failureCode = targets ? 'WORK_POLICY_REVISION_CONFLICT' : 'WORK_REVOCATION_TARGET_UNAVAILABLE';
    if (!replacement) return;
    current.replacementRequestId = replacement.requestId;
    if (!currentCustody.revocations.some((item) => item.requestId === replacement.requestId))
      currentCustody.revocations.push(replacement);
  });
}
