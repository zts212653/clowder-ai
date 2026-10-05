import type { CollectiveEventEnvelope, CollectiveMemberDirectory, CollectiveParticipant } from './client-types.js';
import { MemberAvatar } from './MemberAvatar.js';

export type MemberSelection =
  | { readonly kind: 'human'; readonly humanId: string }
  | { readonly kind: 'agent'; readonly connectionId: string; readonly catId: string };

export function MemberPanel({
  member,
  members,
  participants,
  events,
  onSelect,
  onClose,
  onCafe,
  onReplayGuide,
}: {
  readonly member: MemberSelection | 'members';
  readonly members?: CollectiveMemberDirectory;
  readonly participants: readonly CollectiveParticipant[];
  readonly events: readonly CollectiveEventEnvelope[];
  readonly onSelect: (member: MemberSelection) => void;
  readonly onClose: () => void;
  readonly onCafe?: () => void;
  readonly onReplayGuide?: () => void;
}) {
  const agents = participants.filter(
    (cat) => cat.availability === 'declared' && members?.cafes.some((cafe) => cafe.connectionId === cat.connectionId),
  );
  return (
    <aside
      className="context-panel member-panel"
      data-spatial-role="context-panel"
      aria-label={member === 'members' ? '成员' : '成员资料'}
    >
      <header className="context-header">
        <div>
          <span>共同家园</span>
          <h2>{member === 'members' ? '成员' : '成员资料'}</h2>
        </div>
        <button type="button" aria-label="关闭成员资料" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="member-content">
        {member === 'members' ? (
          <>
            {!members ? (
              <p className="empty-copy">正在读取成员…</p>
            ) : (
              members.humans.map((human) => (
                <section key={human.humanId} className="member-family">
                  <button
                    type="button"
                    className="member-row"
                    onClick={() => onSelect({ kind: 'human', humanId: human.humanId })}
                  >
                    <MemberAvatar name={human.displayName} kind="human" avatarUrl={human.avatarUrl} />
                    <span>
                      <strong>{human.displayName}</strong>
                      <small>{human.role === 'steward' ? '维护者' : '成员'} · 人</small>
                    </span>
                  </button>
                  {agents
                    .filter((agent) => agent.humanId === human.humanId)
                    .map((agent) => (
                      <button
                        key={`${agent.connectionId}:${agent.catId}`}
                        type="button"
                        className="member-row member-row-agent"
                        onClick={() =>
                          onSelect({ kind: 'agent', connectionId: agent.connectionId, catId: agent.catId })
                        }
                      >
                        <MemberAvatar name={agent.displayName} kind="agent" avatarUrl={agent.avatarDataUrl} />
                        <span>
                          <strong>{agent.displayName}</strong>
                          <small>{agent.endpointLabel} · 猫</small>
                        </span>
                      </button>
                    ))}
                </section>
              ))
            )}
          </>
        ) : (
          <MemberProfile member={member} members={members} participants={participants} events={events} />
        )}
        {onCafe && (
          <button type="button" className="cafe-window-button" onClick={onCafe}>
            管理参与…
          </button>
        )}
        {member === 'members' && onReplayGuide && (
          <button type="button" className="first-entry-replay" onClick={onReplayGuide}>
            再看一遍演示
          </button>
        )}
      </div>
    </aside>
  );
}

function MemberProfile({
  member,
  members,
  participants,
  events,
}: {
  readonly member: MemberSelection;
  readonly members?: CollectiveMemberDirectory;
  readonly participants: readonly CollectiveParticipant[];
  readonly events: readonly CollectiveEventEnvelope[];
}) {
  if (member.kind === 'human') {
    const current = members?.humans.find((human) => human.humanId === member.humanId);
    const previous = events
      .map((event) => (event.actor.kind === 'human' ? event.actor : event.actor.human))
      .find((human) => human.humanId === member.humanId);
    const human = current ?? previous;
    if (!human) return <p>暂时无法读取这位成员。</p>;
    const cafes = members?.cafes.filter((cafe) => cafe.humanId === human.humanId) ?? [];
    return (
      <>
        <div className="member-profile">
          <MemberAvatar name={human.displayName} kind="human" avatarUrl={human.avatarUrl} />
          <h3>{human.displayName}</h3>
          <p>以本人身份交流 · 人</p>
        </div>
        <dl className="member-facts">
          <dt>在共同家园的身份</dt>
          <dd>{current?.role === 'steward' ? '维护者' : current ? '成员' : '历史消息中的署名'}</dd>
          {cafes.length > 0 && (
            <>
              <dt>Café</dt>
              <dd>
                {cafes.map((cafe) => (
                  <div key={cafe.connectionId}>{cafe.endpointLabel}</div>
                ))}
              </dd>
            </>
          )}
        </dl>
      </>
    );
  }
  const participant = participants.find(
    (cat) => cat.connectionId === member.connectionId && cat.catId === member.catId,
  );
  const actor = events.find(
    (event) =>
      event.actor.kind === 'agent' &&
      event.actor.provenance.connectionId === member.connectionId &&
      event.actor.provenance.catId === member.catId,
  )?.actor;
  const previous = actor?.kind === 'agent' ? actor : undefined;
  const name = participant?.displayName ?? previous?.agent.displayName;
  if (!name) return <p>暂时无法读取这位成员。</p>;
  return (
    <>
      <div className="member-profile">
        <MemberAvatar name={name} kind="agent" avatarUrl={participant?.avatarDataUrl} />
        <h3>{name}</h3>
        <p>{participant?.endpointLabel ?? previous?.provenance.endpointLabel} · 猫</p>
        {participant?.description && <p>{participant.description}</p>}
      </div>
      <dl className="member-facts">
        <dt>由谁负责</dt>
        <dd>{participant?.humanDisplayName ?? previous?.human.displayName}</dd>
        <dt>公开参与</dt>
        <dd>
          {participant?.availability === 'declared'
            ? participant.channelIds.map((id) => `#${id}`).join(' · ')
            : '当前没有有效参与声明'}
        </dd>
        <dt>发言身份</dt>
        <dd>以自身具名身份回应，私人授权由主人管理。</dd>
      </dl>
    </>
  );
}
