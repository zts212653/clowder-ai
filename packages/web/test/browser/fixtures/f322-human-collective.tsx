import { createRoot } from 'react-dom/client';
import { ChannelConversationFlow } from '../../../../collective-client/src/ChannelConversationFlow.js';
import type { CollectiveEventEnvelope } from '../../../../collective-client/src/client-types.js';
import { TopicMessage } from '../../../../collective-client/src/TopicMessage.js';
import '../../../src/app/theme-tokens.css';
import '../../../src/app/console-tokens.css';
import '../../../../collective-client/src/styles/tokens.css';
import '../../../../collective-client/src/styles/shell.css';
import '../../../../collective-client/src/styles/channel.css';
import '../../../../collective-client/src/styles/channel-message.css';
import '../../../../collective-client/src/styles/message-reactions.css';
import '../../../../collective-client/src/styles/collaboration.css';

/**
 * F322 B segment 1 (human message), shared-room half — probe fixture. The REAL `ChannelConversationFlow` / `ChannelMessage`
 * / `TopicMessage` with the Client's own stylesheets in the order `main.tsx` loads them, on a column the width of the reading
 * column or the Studio chat bar. Light or dark follows the Client's own rule (`:root.dark`). The presentation default comes
 * from the real `?presentation=` frame URL parameter; the viewer comes from `?viewer=` (a humanId, or empty for "unknown").
 * Nothing talks to a service.
 */
const ME = 'human_me';
const OTHER = 'human_other';
const SAME_NAME = 'human_same_name';
const T0 = Date.UTC(2026, 9, 1, 12, 41);
const minute = 60_000;
const at = (n: number) => new Date(T0 + n * minute).toISOString();

const human = (humanId: string, displayName: string, avatarUrl?: string) => ({
  kind: 'human' as const,
  humanId,
  displayName,
  ...(avatarUrl ? { avatarUrl } : {}),
});
const cat = (ownerId: string, ownerName: string, name: string) => ({
  kind: 'agent' as const,
  human: { humanId: ownerId, displayName: ownerName },
  agent: { agentId: 'codex', displayName: name },
  provenance: {
    connectionId: 'con_1',
    endpointId: 'end_1',
    endpointLabel: `${ownerName} 的 Café`,
    catId: 'codex',
    sessionRef: 'x',
  },
});

let sequence = 0;
function event(
  id: string,
  actor: CollectiveEventEnvelope['actor'],
  body: string,
  minutes: number,
): CollectiveEventEnvelope {
  sequence += 1;
  return {
    serviceInstanceId: 'svc_12345678',
    collectiveId: 'col_12345678',
    eventId: id,
    clientEventId: id,
    sequence,
    actor,
    target: { kind: 'channel', channelId: 'general' },
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body,
    acceptedAt: at(minutes),
  } as CollectiveEventEnvelope;
}

const LONG =
  '这一段故意写得很长，用来看一条很长的话会不会撑满阅读栏：它应该最多占到栏宽的八成，左边留出空来，字在块里左对齐，换行以后每一行的左边在同一条线上。再多写几句让它一定换行，免得在宽栏里一行就放下了。';
const CODE =
  '看这段：\n\n```ts\nconst aVeryLongLineOfCodeThatIsMuchWiderThanTheBlockCanBe = renderTheWholeCoverGallery(options, more, args);\n```';

export const events: CollectiveEventEnvelope[] = [
  event('own-short', human(ME, '阿宪'), '三版封面，暖一点。', 0),
  event('other-1', human(OTHER, '阿禾'), '我这边也想看，能发给我吗？', 1),
  event('own-run-a', human(ME, '阿宪'), '好，再来一版。', 2),
  event('own-run-b', human(ME, '阿宪'), LONG, 3),
  event('own-run-c', human(ME, '阿宪'), CODE, 4),
  event('same-name', human(SAME_NAME, '阿宪'), '我也叫阿宪，但我不是你。', 5),
  event('own-cat', cat(ME, '阿宪', '缅因猫'), '收到，三版马上出。', 6),
  event('other-cat', cat(OTHER, '阿禾', '阿禾家的猫'), '我这边也在看。', 7),
];

const params = new URLSearchParams(window.location.search);
const width = Number(params.get('w') ?? '720');
// An empty `viewer=` means "the viewer is not known": nothing is yours.
const viewer = params.has('viewer') ? params.get('viewer') || undefined : ME;

declare global {
  interface Window {
    __collective: { setScheme: (scheme: 'light' | 'dark') => void };
  }
}
window.__collective = {
  setScheme(scheme) {
    document.documentElement.classList.toggle('dark', scheme === 'dark');
  },
};

const noop = async () => undefined;
function Page() {
  return (
    <div data-testid="column" style={{ width, padding: '16px 20px', background: 'var(--console-card-bg)' }}>
      <ChannelConversationFlow
        flowRef={{ current: null }}
        threads={events.map((root) => ({ root, replies: [] }))}
        legacy={[]}
        search={false}
        humanName="阿宪"
        channelWorks={[]}
        channelVotes={[]}
        channelReactions={[]}
        humanId={viewer ?? ''}
        canSteward={false}
        participants={[]}
        humanNames={{}}
        roadmaps={[]}
        actions={{ openTopic: noop, mention: noop, openMember: noop } as never}
      />
      <div data-testid="topic" style={{ marginTop: 16 }}>
        <TopicMessage event={events[0]} currentHumanId={viewer} />
        <TopicMessage event={events[1]} currentHumanId={viewer} onOpenMember={() => undefined} />
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing collective fixture root');
createRoot(root).render(<Page />);
