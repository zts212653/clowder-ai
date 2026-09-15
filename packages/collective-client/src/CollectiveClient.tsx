import { ChannelScene } from './ChannelScene.js';
import { F290AssemblyExperience } from './F290AssemblyExperience.js';
import { OnboardingScene } from './OnboardingScene.js';
import { ProductShell } from './ProductShell.js';
import { useCollectiveClient } from './use-collective-client.js';

export function CollectiveClient() {
  const hostOrigin = new URLSearchParams(location.search).get('hostOrigin');
  const embedded = window.parent !== window && hostOrigin !== null;
  const experienceGate = new URLSearchParams(location.search).get('experienceGate') === 'f290-assembly';

  if (experienceGate) return <F290AssemblyExperience embedded={embedded} hostOrigin={hostOrigin ?? undefined} />;

  return <LiveCollectiveClient embedded={embedded} />;
}

function LiveCollectiveClient({ embedded }: { readonly embedded: boolean }) {
  const client = useCollectiveClient();
  const { snapshot } = client;
  const canSteward = snapshot.collective?.role === 'steward';
  const canPair = snapshot.phase === 'ready' && Boolean(snapshot.me?.auth && snapshot.collective);

  return (
    <ProductShell
      embedded={embedded}
      collective={snapshot.collective}
      collectives={snapshot.me?.collectives}
      onSelectCollective={client.selectCollective}
      connection={snapshot.connection}
      canSteward={canSteward}
      canPair={canPair}
      notice={snapshot.notice}
      onInvite={() => void client.createInvite()}
      onPair={() => void client.pairHost()}
    >
      {snapshot.phase === 'ready' && snapshot.collective && snapshot.me ? (
        <ChannelScene
          key={snapshot.collective.collectiveId}
          collective={snapshot.collective}
          humanName={snapshot.me.human.displayName}
          events={snapshot.events}
          participants={snapshot.participants}
          error={snapshot.error}
          connection={snapshot.connection}
          delivery={snapshot.delivery}
          onSend={client.sendMessage}
        />
      ) : snapshot.phase === 'ready' && snapshot.me ? (
        <p className="channel-empty">选择一个共同家园，继续交流。</p>
      ) : (
        <OnboardingScene
          phase={snapshot.phase}
          mode={client.invitationMode}
          providers={snapshot.providers}
          error={snapshot.error}
          onBootstrap={client.bootstrap}
          onAuthenticate={client.authenticate}
          onConfigureProvider={client.configureProvider}
          onCreateCollective={client.createCollective}
        />
      )}
    </ProductShell>
  );
}
