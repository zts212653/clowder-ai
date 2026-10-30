import {
  collectiveArtifactManagementSchema,
  offerCollectiveArtifactCustodySchema,
  updateCollectiveArtifactAccessSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { type ClientReadPolicy, type ClientRequest, CollectiveClientRequestError } from './client-request.js';
import type { SharedArtifact } from './collective-artifact-client.js';

const pendingSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('access'), input: updateCollectiveArtifactAccessSchema }).strict(),
  z.object({ action: z.literal('offer'), input: offerCollectiveArtifactCustodySchema }).strict(),
]);

export function sharedArtifactManagementClient(
  request: ClientRequest,
  coordinates: { serviceInstanceId: string; collectiveId: string },
  namespace: string,
) {
  const post = (path: string, input: unknown, policy?: ClientReadPolicy) =>
    request<unknown>(`/api/artifacts/${path}`, { method: 'POST', body: JSON.stringify(input) }, policy);
  const key = (artifact: SharedArtifact) => `collective-management:${namespace}:${artifact.artifactId}`;
  const read = async (artifact: SharedArtifact, page: { offset?: number; snapshot?: string } = {}) => {
    const result = z
      .object({ management: collectiveArtifactManagementSchema })
      .parse(
        await post('management/read', { ...coordinates, artifactId: artifact.artifactId, ...page }, { readOnly: true }),
      ).management;
    if (
      result.artifactId !== artifact.artifactId ||
      result.serviceInstanceId !== coordinates.serviceInstanceId ||
      result.collectiveId !== coordinates.collectiveId
    )
      throw new Error('管理引用已改变，请重新读取。');
    return result;
  };
  const execute = async (artifact: SharedArtifact, pending: z.infer<typeof pendingSchema>) => {
    const { input, action } = pending;
    if (
      input.artifactId !== artifact.artifactId ||
      input.serviceInstanceId !== coordinates.serviceInstanceId ||
      input.collectiveId !== coordinates.collectiveId
    )
      throw new Error('管理引用已改变，请重新读取。');
    let result: unknown;
    try {
      result = await post(action === 'access' ? 'access/update' : 'custody/offer', input);
    } catch (error) {
      // These transactions replay a committed request before CAS; a 409 proves this intent did not commit.
      if (error instanceof CollectiveClientRequestError && error.status === 409) localStorage.removeItem(key(artifact));
      throw error;
    }
    if (action === 'access')
      z.object({
        artifact: z.object({
          artifactId: z.literal(artifact.artifactId),
          serviceInstanceId: z.literal(coordinates.serviceInstanceId),
          collectiveId: z.literal(coordinates.collectiveId),
        }),
      }).parse(result);
    else z.object({ handoffRef: z.string().min(1) }).parse(result);
    localStorage.removeItem(key(artifact));
  };
  const send = async (artifact: SharedArtifact, unsafe: unknown) => {
    if (localStorage.getItem(key(artifact))) throw new Error('上次操作尚未确认，请先核对原操作。');
    const pending = pendingSchema.parse(unsafe);
    localStorage.setItem(key(artifact), JSON.stringify(pending));
    await execute(artifact, pending);
  };
  return {
    read,
    hasPending: (artifact: SharedArtifact) => Boolean(localStorage.getItem(key(artifact))),
    recover: async (artifact: SharedArtifact) => {
      const saved = localStorage.getItem(key(artifact));
      if (saved) await execute(artifact, pendingSchema.parse(JSON.parse(saved)));
    },
    setAccess: (
      artifact: SharedArtifact,
      humanId: string,
      access: 'read' | 'apply' | 'revoked',
      expectedAccessRevision: number,
    ) =>
      send(artifact, {
        action: 'access',
        input: {
          ...coordinates,
          artifactId: artifact.artifactId,
          humanId,
          access,
          expectedAccessRevision,
          requestId: crypto.randomUUID(),
        },
      }),
    offer: (
      artifact: SharedArtifact,
      targetHumanId: string,
      expectedCustodyRevision: number,
      targetConnectionId?: string,
    ) =>
      send(artifact, {
        action: 'offer',
        input: {
          ...coordinates,
          artifactId: artifact.artifactId,
          targetHumanId,
          ...(targetConnectionId ? { targetConnectionId } : {}),
          expectedCustodyRevision,
          requestId: crypto.randomUUID(),
        },
      }),
    cancel: async (artifact: SharedArtifact, transferId: string) => {
      z.object({ transfer: z.object({ transferId: z.literal(transferId), state: z.literal('cancelled') }) }).parse(
        await post('custody/cancel', { ...coordinates, artifactId: artifact.artifactId, transferId }),
      );
    },
  };
}
