import type { CollectiveHumanMessageRequest } from '@cat-cafe/shared';
import { type Dispatch, type MutableRefObject, type SetStateAction, useCallback, useRef } from 'react';
import type { ClientRequest } from './client-request.js';
import type { ClientSnapshot, ClientTarget } from './client-types.js';
import { acknowledgeHumanSend, collectiveClientNamespace, prepareHumanSend } from './human-send-custody.js';
import { collectiveClientErrorMessage } from './use-human-auth-session.js';

function humanSendPayload(
  snapshot: ClientSnapshot,
  body: string,
  destination: ClientTarget,
): Omit<CollectiveHumanMessageRequest, 'clientEventId'> | undefined {
  const { collective, meta } = snapshot;
  if (!collective || !meta) return undefined;
  return {
    serviceInstanceId: meta.serviceInstanceId,
    collectiveId: collective.collectiveId,
    ...destination,
    body,
  };
}

function acceptedDeliveryLabel(destination: ClientTarget) {
  return destination.attentionRequest === 'response_requested'
    ? '回应请求已送达；是否有人接住会显示在原消息上'
    : '已进入共同现场；这不代表某只猫已经接住';
}

export function useCollectiveSend(input: {
  readonly snapshot: ClientSnapshot;
  readonly setSnapshot: Dispatch<SetStateAction<ClientSnapshot>>;
  readonly currentNamespace: MutableRefObject<string | undefined>;
  readonly request: ClientRequest;
  readonly refresh: () => Promise<void>;
}) {
  const sending = useRef<{ fingerprint: string; promise: Promise<void> }>();
  return useCallback(
    (body: string, destination: ClientTarget) => {
      const namespace = collectiveClientNamespace(input.snapshot);
      const payload = humanSendPayload(input.snapshot, body, destination);
      if (!payload || !namespace) return Promise.reject(new Error('请先登录并选择 Collective'));
      const fingerprint = JSON.stringify([namespace, body, destination]);
      if (sending.current) {
        return sending.current.fingerprint === fingerprint
          ? sending.current.promise
          : Promise.reject(new Error('上一条消息仍在送达，请稍后再发。'));
      }
      const operation = prepareHumanSend(localStorage, namespace, payload);
      const send = async () => {
        input.setSnapshot((current) => ({
          ...current,
          delivery: { kind: 'requesting', label: '正在送往共同现场…' },
        }));
        try {
          await input.request('/api/events/human', { method: 'POST', body: JSON.stringify(operation) });
          acknowledgeHumanSend(localStorage, namespace, operation.clientEventId);
          if (namespace !== input.currentNamespace.current) return;
          input.setSnapshot((current) => ({
            ...current,
            delivery: {
              kind: 'accepted',
              label: acceptedDeliveryLabel(destination),
            },
          }));
          await input.refresh();
        } catch (error) {
          if (namespace !== input.currentNamespace.current) throw error;
          input.setSnapshot((current) => ({
            ...current,
            delivery: { kind: 'failed', label: '尚未确认送达，可以重试' },
            error: collectiveClientErrorMessage(error),
          }));
          throw error;
        }
      };
      const promise = send().finally(() => {
        sending.current = undefined;
      });
      sending.current = { fingerprint, promise };
      return promise;
    },
    [input],
  );
}
