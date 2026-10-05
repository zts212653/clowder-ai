'use client';
import type { CollectiveClientContext } from '@cat-cafe/shared';
import { type ComponentProps, useEffect, useRef } from 'react';
import { CatAvatar } from '@/components/CatAvatar';
import { CollectiveCafePanel } from './CollectiveCafePanel';
import { CollectiveWorkPermission } from './CollectiveWorkPermission';
import { requestStatus } from './CollectiveWorkRequests';
import styles from './collective-cafe-host.module.css';
import { useCollectiveAutoReconcile, useCollectiveParticipation } from './use-collective-participation';
import { useCollectiveWorkPolicy } from './use-collective-work-policy';

export function CollectiveCafeHost({
  context,
  onOpen,
  onParticipationReady,
  policyBridge,
  ...props
}: Omit<ComponentProps<typeof CollectiveCafePanel>, 'state' | 'channelId' | 'channels'> & {
  readonly context: CollectiveClientContext;
  readonly onOpen: () => void;
  readonly onParticipationReady?: (value: { readonly revision: number; readonly catCount: number }) => void;
}) {
  const state = useCollectiveParticipation(props.connection.connectionId);
  const workPolicy = useCollectiveWorkPolicy(props.connection.connectionId, policyBridge);
  useCollectiveAutoReconcile(state, context.channelIds, props.connection.authorityStatus === 'connected');
  const sentPublication = useRef<string>();
  useEffect(() => {
    const view = state.view;
    const general = view?.channelRoutes.general;
    if (!view?.published || view.reconcileRequired || !general || !onParticipationReady) return;
    const catCount = Object.keys(general.participants).length;
    const key = `${context.bridgeId}:${props.connection.connectionId}:${view.revision}:${catCount}`;
    if (sentPublication.current === key) return;
    sentPublication.current = key;
    onParticipationReady({ revision: view.revision, catCount });
  }, [context.bridgeId, onParticipationReady, props.connection.connectionId, state.view]);
  const requests = state.view?.requests.filter((item) => item.event.location?.channelId === context.channelId) ?? [];
  const latestNamedRequest = [...requests].reverse().find((item) => item.event.recipient?.kind === 'agent');
  const latestNamedCatId =
    latestNamedRequest?.event.recipient?.kind === 'agent' ? latestNamedRequest.event.recipient.agentId : undefined;
  const work =
    state.view?.tasks.filter((task) =>
      requests.some((request) => task.sourceRefs.includes(`message:${request.messageId}`)),
    ) ?? [];
  const cats =
    state.view?.cats.filter((cat) => state.view?.channelRoutes[context.channelId]?.participants[cat.id]) ?? [];
  return (
    <>
      {policyBridge && <CollectiveWorkPermission bridge={policyBridge} state={workPolicy} view={state.view} />}
      <section className={styles.activity} aria-label="家里近况">
        <h3>猫猫动态</h3>
        {latestNamedRequest && latestNamedCatId ? (
          <button type="button" onClick={onOpen}>
            <CatAvatar catId={latestNamedCatId} size={30} />
            <span>
              <strong>
                点名 {state.view?.cats.find((cat) => cat.id === latestNamedCatId)?.displayName ?? latestNamedCatId}
              </strong>
              <small>{requestStatus(latestNamedRequest)} · 点开查看</small>
            </span>
          </button>
        ) : work.length ? (
          work.slice(-2).map((task) => {
            const request = requests.find((item) => task.sourceRefs.includes(`message:${item.messageId}`));
            const catId = request?.event.recipient?.kind === 'agent' ? request.event.recipient.agentId : undefined;
            return (
              <button key={task.id} type="button" onClick={onOpen}>
                {catId && <CatAvatar catId={catId} size={30} />}
                <span>
                  <strong>{task.title}</strong>
                  <small>{task.closure === 'open' ? '私人工作有后续' : '私人工作已收口'} · 点开查看</small>
                </span>
              </button>
            );
          })
        ) : cats.length ? (
          cats.slice(0, 2).map((cat) => (
            <button key={cat.id} type="button" onClick={onOpen}>
              <CatAvatar catId={cat.id} size={30} />
              <span>
                <strong>{cat.displayName}</strong>
                <small>{state.view?.published ? '已加入本频道' : '公开参与尚待确认'}</small>
              </span>
            </button>
          ))
        ) : (
          <button type="button" onClick={onOpen}>
            <span>
              <strong>伙伴正在自动接入</strong>
              <small>
                {state.error ? '家里的近况暂时读不到' : state.view ? '当前没有可参与的伙伴' : '正在读取家里的近况…'}
              </small>
            </span>
          </button>
        )}
        <p>家里的对话仍然只属于你</p>
      </section>
      {context.openCafe && (
        <CollectiveCafePanel
          {...props}
          workPolicy={workPolicy}
          policyBridge={policyBridge}
          state={state}
          channelId={context.channelId}
          channels={context.channelIds}
        />
      )}
    </>
  );
}
