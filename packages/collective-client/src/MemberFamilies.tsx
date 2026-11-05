import { AppTooltip } from '@cat-cafe/ui';
import type { CollectiveMemberDirectory, CollectiveParticipant } from './client-types.js';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import { MemberAvatar } from './MemberAvatar.js';
import type { MemberSelection } from './MemberPanel.js';

/** endpointId is the public Café identity; a nickname or catId alone never proves equivalence. */
export function MemberFamilies({
  members,
  participants,
  onSelect,
}: {
  readonly members: CollectiveMemberDirectory;
  readonly participants: readonly CollectiveParticipant[];
  readonly onSelect: (member: MemberSelection) => void;
}) {
  const t = useCollectiveText();
  const language = useCollectiveLanguage();
  return members.humans.flatMap((human) => {
    const cafes = members.cafes.filter((cafe) => cafe.humanId === human.humanId);
    const endpoints = [...new Map(cafes.map((cafe) => [cafe.endpointId, cafe])).values()];
    const homes = endpoints.length ? endpoints : [undefined];
    return homes.map((home) => {
      const connections = new Set(
        cafes.filter((cafe) => cafe.endpointId === home?.endpointId).map((cafe) => cafe.connectionId),
      );
      const agents = participants.filter(
        (cat) =>
          cat.availability === 'declared' &&
          cat.humanId === human.humanId &&
          cat.endpointId === home?.endpointId &&
          connections.has(cat.connectionId),
      );
      const cats = new Map<string, CollectiveParticipant[]>();
      for (const cat of agents) {
        const key = JSON.stringify([cat.serviceInstanceId, cat.collectiveId, cat.endpointId, cat.humanId, cat.catId]);
        cats.set(key, [...(cats.get(key) ?? []), cat]);
      }
      return (
        <details open className="member-family" key={`${human.humanId}:${home?.endpointId ?? 'human'}`}>
          <summary>
            <strong>{home?.endpointLabel ?? human.displayName}</strong>
            <small>
              {cats.size + 1} {language === 'en' && cats.size === 0 ? 'member' : t('位成员')}
            </small>
          </summary>
          <button
            type="button"
            className="member-row"
            onClick={() => onSelect({ kind: 'human', humanId: human.humanId })}
          >
            <MemberAvatar name={human.displayName} kind="human" avatarUrl={human.avatarUrl} />
            <span>
              <strong>{human.displayName}</strong>
              <small>{t(human.role === 'steward' ? '维护者' : '普通成员')}</small>
            </span>
          </button>
          {[...cats].map(([key, sessions]) => (
            <PublicCatRow key={key} sessions={sessions} onSelect={onSelect} />
          ))}
        </details>
      );
    });
  });
}

function PublicCatRow({
  sessions,
  onSelect,
}: {
  readonly sessions: readonly CollectiveParticipant[];
  readonly onSelect: (member: MemberSelection) => void;
}) {
  const t = useCollectiveText();
  const ordered = [...sessions].sort((a, b) => a.connectionId.localeCompare(b.connectionId));
  const cat = ordered[0];
  const label = cat.displayLabel ?? cat.displayName;
  const identity = `${cat.displayName} · @${cat.catId} · ${cat.humanDisplayName} · ${cat.endpointLabel}`;
  const name = (
    <>
      <MemberAvatar name={label} kind="agent" avatarUrl={cat.avatarDataUrl} />
      <span>
        <AppTooltip label={identity} intent="content">
          <strong>{label}</strong>
        </AppTooltip>
        <small>
          @{cat.catId}
          {ordered.length > 1 ? ` · ${ordered.length} ${t('个公开连接')}` : ''}
        </small>
      </span>
    </>
  );
  const select = (session: CollectiveParticipant) =>
    onSelect({ kind: 'agent', connectionId: session.connectionId, catId: session.catId });
  if (ordered.length === 1)
    return (
      <button type="button" className="member-row member-row-agent" aria-label={identity} onClick={() => select(cat)}>
        {name}
      </button>
    );
  return (
    <details className="member-sessions">
      <summary className="member-row member-row-agent">{name}</summary>
      <div className="member-connection-choices">
        {ordered.map((session, index) => (
          <button
            key={session.connectionId}
            type="button"
            className="member-connection-choice"
            onClick={() => select(session)}
          >
            {t('公开连接')} {index + 1}
            <small>
              {session.channelIds.map((id) => `#${id}`).join(' · ')} · {session.connectionId}
            </small>
          </button>
        ))}
      </div>
    </details>
  );
}
