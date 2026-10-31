'use client';

import type { CollectiveCafeSection } from '@cat-cafe/shared';
import { CollectiveCafeConnectionSettings } from './CollectiveCafeConnectionSettings';
import { CollectiveChannelListeningSettings } from './CollectiveChannelListeningSettings';
import { CollectiveParticipationContent } from './CollectiveParticipationPanel';
import type { CollectiveConnectionProjection } from './collective-client';
import type { useCollectiveParticipation } from './use-collective-participation';
import type { CollectiveWorkPolicyState } from './use-collective-work-policy';

interface CollectiveCafeSectionContentProps {
  readonly section: CollectiveCafeSection;
  readonly state: ReturnType<typeof useCollectiveParticipation>;
  readonly workPolicy?: CollectiveWorkPolicyState;
  readonly connection: CollectiveConnectionProjection;
  readonly connections: readonly CollectiveConnectionProjection[];
  readonly channelId: string;
  readonly channels: readonly string[];
  readonly busy?: string;
  readonly pairingState: 'waiting' | 'ready' | 'unavailable';
  readonly onPair: () => void;
  readonly onMutate: (operation: 'reconnect' | 'revoke') => void;
  readonly onSelectConnection: (id: string) => void;
  readonly onSelectCats: () => void;
}

export function CollectiveCafeSectionContent(props: CollectiveCafeSectionContentProps) {
  switch (props.section) {
    case 'channel':
      return <ChannelSection {...props} />;
    case 'connection':
      return (
        <CollectiveCafeConnectionSettings
          connection={props.connection}
          connections={props.connections}
          busy={props.busy}
          pairingState={props.pairingState}
          onPair={props.onPair}
          onMutate={props.onMutate}
          onSelectConnection={props.onSelectConnection}
        />
      );
    case 'cats':
      if (!props.state.view)
        return (
          <CafeSectionLoading
            label="正在读取我的猫…"
            error={props.state.error}
            onRetry={() => void props.state.reload()}
          />
        );
      return <ParticipationSection {...props} surface="roster" />;
    case 'permissions':
      if (!props.state.view || !props.workPolicy)
        return (
          <CafeSectionLoading
            label="正在读取已允许的工作…"
            error={props.state.error ?? props.workPolicy?.error}
            onRetry={() => {
              void props.state.reload();
              void props.workPolicy?.read();
            }}
          />
        );
      return <ParticipationSection {...props} surface="policy" />;
    case 'calendar':
      return <ParticipationSection {...props} surface="work" />;
  }
}

function ChannelSection(props: CollectiveCafeSectionContentProps) {
  if (!props.workPolicy || !props.state.view)
    return (
      <CafeSectionLoading
        label="正在读取频道设置…"
        error={props.state.error ?? props.workPolicy?.error}
        onRetry={() => {
          void props.state.reload();
          void props.workPolicy?.read();
        }}
      />
    );
  return (
    <CollectiveChannelListeningSettings
      state={props.workPolicy}
      view={props.state.view}
      channelId={props.channelId}
      enabled={props.connection.authorityStatus === 'connected'}
      onSelectCats={props.onSelectCats}
    />
  );
}

function ParticipationSection({
  state,
  connection,
  channelId,
  channels,
  workPolicy,
  surface,
}: CollectiveCafeSectionContentProps & { readonly surface: 'roster' | 'work' | 'policy' }) {
  return (
    <CollectiveParticipationContent
      state={state}
      channelId={channelId}
      channels={channels}
      workPolicy={workPolicy}
      canParticipate={connection.authorityStatus === 'connected'}
      surface={surface}
    />
  );
}

function CafeSectionLoading({
  label,
  error,
  onRetry,
}: {
  readonly label: string;
  readonly error?: string;
  readonly onRetry: () => void;
}) {
  return error ? (
    <div role="alert" className="text-xs leading-5 text-cafe-secondary">
      <p>{error}</p>
      <button type="button" className="mt-2 underline" onClick={onRetry}>
        重新读取
      </button>
    </div>
  ) : (
    <p className="text-xs leading-5 text-cafe-muted">{label}</p>
  );
}
