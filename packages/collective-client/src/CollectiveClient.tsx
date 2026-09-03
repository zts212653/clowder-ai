import { ChannelScene } from './ChannelScene.js';
import { OnboardingScene } from './OnboardingScene.js';
import { ProductShell } from './ProductShell.js';
import { useCollectiveClient } from './use-collective-client.js';

export function CollectiveClient() {
  const client = useCollectiveClient();
  const { snapshot } = client;
  const hostOrigin = new URLSearchParams(location.search).get('hostOrigin');
  const embedded = window.parent !== window && hostOrigin !== null;
  const canSteward = snapshot.collective?.role === 'steward';
  const canPair = snapshot.phase === 'ready' && Boolean(snapshot.me?.auth && snapshot.collective);

  return (
    <ProductShell
      embedded={embedded}
      collective={snapshot.collective}
      connection={snapshot.connection}
      canSteward={canSteward}
      canPair={canPair}
      notice={snapshot.notice}
      onInvite={() => void client.createInvite()}
      onPair={() => void client.pairHost()}
    >
      {snapshot.phase === 'ready' && snapshot.collective && snapshot.me ? (
        <ChannelScene
          collective={snapshot.collective}
          humanName={snapshot.me.human.displayName}
          events={snapshot.events}
          connection={snapshot.connection}
          delivery={snapshot.delivery}
          onSend={client.sendMessage}
        />
      ) : (
        <OnboardingScene
          phase={snapshot.phase}
          mode={client.invitationMode}
          providers={snapshot.providers}
          error={snapshot.error}
          onBootstrap={client.bootstrap}
          onAuthenticate={client.authenticate}
          onCreateCollective={client.createCollective}
        />
      )}
    </ProductShell>
  );
}
