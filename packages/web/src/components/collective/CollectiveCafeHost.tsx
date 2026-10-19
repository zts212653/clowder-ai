'use client';

import type { CollectiveClientContext } from '@cat-cafe/shared';
import { type ComponentProps, type RefObject, useEffect, useRef, useState } from 'react';
import { CollectiveCafePanel } from './CollectiveCafePanel';
import { CollectivePrivateSlots } from './CollectivePrivateSlots';
import { CollectiveWorkPermission } from './CollectiveWorkPermission';
import { useCollectiveAutoReconcile, useCollectiveParticipation } from './use-collective-participation';
import { useCollectiveUiPlacement } from './use-collective-ui-placement';
import { useCollectiveWorkPolicy } from './use-collective-work-policy';
import type { CollectiveWorkPolicyBridge } from './use-collective-work-policy-bridge';

export function CollectiveCafeHost({
  context,
  iframeRef,
  onParticipationReady,
  policyBridge,
  ...props
}: Omit<ComponentProps<typeof CollectiveCafePanel>, 'state' | 'channelId' | 'channels'> & {
  readonly context: CollectiveClientContext;
  readonly iframeRef?: RefObject<HTMLIFrameElement>;
  readonly policyBridge?: CollectiveWorkPolicyBridge;
  readonly onParticipationReady?: (value: { readonly revision: number; readonly catCount: number }) => void;
}) {
  const state = useCollectiveParticipation(props.connection.connectionId);
  const workPolicy = useCollectiveWorkPolicy(props.connection.connectionId, policyBridge);
  useCollectiveAutoReconcile(state, context.channelIds, props.connection.authorityStatus === 'connected');
  const slots = useCollectiveUiPlacement(iframeRef, props.connection, context);
  const [privateSection, setPrivateSection] = useState<'permissions'>();
  useEffect(() => {
    setPrivateSection(undefined);
  }, [context.contextId, context.revision]);
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
  return (
    <>
      {policyBridge && <CollectiveWorkPermission bridge={policyBridge} state={workPolicy} view={state.view} />}
      {!context.openCafe && !privateSection && (
        <CollectivePrivateSlots
          slots={slots}
          state={state}
          context={context}
          connectionId={props.connection.connectionId}
          enabled={props.connection.authorityStatus === 'connected'}
          onPermissions={() => setPrivateSection('permissions')}
        />
      )}
      {(context.openCafe || privateSection) && (
        <CollectiveCafePanel
          {...props}
          initialSection={privateSection ?? context.cafeSection ?? 'cats'}
          onClose={() => {
            setPrivateSection(undefined);
            props.onClose();
          }}
          workPolicy={workPolicy}
          state={state}
          channelId={context.channelId}
          channels={context.channelIds}
        />
      )}
    </>
  );
}
