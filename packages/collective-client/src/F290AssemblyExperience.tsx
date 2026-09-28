import {
  type CollectiveF290ExperienceHostRequest,
  type CollectiveF290ExperienceHostResultReceipt,
  type CollectiveF290ExperienceResultRejectionReason,
  type CollectiveF290ExperienceWorkRef,
  collectiveF290ExperienceHostResultSchema,
  findCollectiveF290ExperienceWork,
} from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  F290AssemblyContextPanel,
  F290AssemblyDestinationList,
  F290AssemblyMobileChannelNavigation,
} from './F290AssemblyExperienceControls.js';
import {
  addF290AssemblyHostResult,
  addF290AssemblyMessage,
  addF290AssemblyProposal,
  admitF290AssemblyCat,
  canInteractWithF290Assembly,
  type F290AssemblyCandidateMessage,
  type F290AssemblyCandidateState,
  type F290AssemblyChannelId,
  f290AssemblyCats,
  f290AssemblyDefaultState,
  f290AssemblyMembers,
  findF290AssemblyCat,
  findF290AssemblyChannel,
  respondToF290AssemblyMessage,
  restoreF290AssemblyCandidateState,
  revokeF290AssemblyParticipation,
  setF290AssemblyConnection,
} from './f290-assembly-state.js';
import { ProductShell } from './ProductShell.js';

export type { F290AssemblyCandidateState } from './f290-assembly-state.js';

const STORE_KEY = 'f290-assembly-experience-v1';
type CandidateStateStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): CandidateStateStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function persistF290AssemblyCandidateState(
  state: F290AssemblyCandidateState,
  storage: Pick<Storage, 'setItem'> | undefined = browserStorage(),
) {
  if (!storage) return;
  try {
    storage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // Candidate state remains usable when browser storage is unavailable or full.
  }
}

function restoreCandidateState(storage = browserStorage()): F290AssemblyCandidateState {
  if (!storage) return f290AssemblyDefaultState;
  try {
    return restoreF290AssemblyCandidateState(JSON.parse(storage.getItem(STORE_KEY) ?? 'null'));
  } catch {
    return f290AssemblyDefaultState;
  }
}

function attentionCopy(message: F290AssemblyCandidateMessage) {
  if (message.status === 'responded')
    return `${findF290AssemblyCat(message.responderId)?.label ?? '成员'}已在原处具名回应`;
  if (message.status === 'result') return 'Host 已把允许公开的结果带回原处';
  if (message.recipient && !message.recipient.catId) return '点名对象尚未在当前频道；不会改派给其他猫';
  if (message.status === 'pending') return '已送达 · 尚未接住';
  if (message.status === 'uncertain') return '期待尚未说明 · 不会按关键词静默丢弃';
  return '表达已送达 · 允许安静';
}

function recipientLocationCopy(message: F290AssemblyCandidateMessage) {
  if (message.recipient?.catId) return `recipient: ${message.recipient.label} · location: 当前频道`;
  if (message.recipient) return `recipient: ${message.recipient.label} · 未在当前频道`;
  return 'location: 当前频道';
}

function hostRequest(message: CollectiveF290ExperienceHostRequest, hostOrigin?: string) {
  if (!hostOrigin || window.parent === window) return false;
  window.parent.postMessage(message, hostOrigin);
  return true;
}

function postHostResultReceipt(message: CollectiveF290ExperienceHostResultReceipt, hostOrigin?: string) {
  if (!hostOrigin || window.parent === window) return false;
  window.parent.postMessage(message, hostOrigin);
  return true;
}

function hostResultRejectionReason(
  state: F290AssemblyCandidateState,
  workRef: CollectiveF290ExperienceWorkRef,
): CollectiveF290ExperienceResultRejectionReason | undefined {
  if (!findCollectiveF290ExperienceWork(workRef)) return 'unknown_work';
  if (state.participation === 'revoked') return 'participation_revoked';
  if (state.connection === 'offline') return 'connection_offline';
  return undefined;
}

function hostResultRejectionCopy(reason: CollectiveF290ExperienceResultRejectionReason) {
  switch (reason) {
    case 'participation_revoked':
      return '参与已撤回；未接收 Host 回传的公开结果。';
    case 'connection_offline':
      return '当前离线；未把 Host 回传冒充为已送达。';
    case 'unknown_work':
      return '这项 Work 不在当前体验候选中；未接收 Host 回传。';
  }
}

export function F290AssemblyExperience({
  embedded,
  hostOrigin,
}: {
  readonly embedded: boolean;
  readonly hostOrigin?: string;
}) {
  const [state, setState] = useState<F290AssemblyCandidateState>(() => restoreCandidateState());
  const [body, setBody] = useState('');
  const [expectation, setExpectation] = useState<F290AssemblyCandidateMessage['expectation']>('request');
  const [hostNotice, setHostNotice] = useState<string>();
  const [membershipOpen, setMembershipOpen] = useState(false);
  const [membershipNotice, setMembershipNotice] = useState<string>();
  const [proposalOpen, setProposalOpen] = useState(false);
  const [proposalTitle, setProposalTitle] = useState('');
  const lifecycleRef = useRef(state);
  const currentChannel = findF290AssemblyChannel(state.channelId);
  if (!currentChannel) throw new Error('F290 candidate state contains an unknown channel');
  const channelMessages = useMemo(
    () => state.messages.filter((message) => message.channelId === state.channelId),
    [state.channelId, state.messages],
  );
  const channelProposals = useMemo(
    () => state.proposals.filter((proposal) => proposal.channelId === state.channelId),
    [state.channelId, state.proposals],
  );
  const channelMembers = f290AssemblyMembers(state);
  const canInteract = canInteractWithF290Assembly(state);
  const availableCats = f290AssemblyCats.filter((cat) => !channelMembers.some((member) => member.id === cat.id));

  useEffect(() => {
    lifecycleRef.current = state;
  }, [state]);
  useEffect(() => persistF290AssemblyCandidateState(state), [state]);
  useEffect(() => {
    if (!embedded || !hostOrigin) return;
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent || event.origin !== hostOrigin) return;
      const parsed = collectiveF290ExperienceHostResultSchema.safeParse(event.data);
      if (!parsed.success) return;
      const current = lifecycleRef.current;
      const rejection = hostResultRejectionReason(current, parsed.data.workRef);
      if (rejection) {
        postHostResultReceipt(
          { type: 'collective:f290-experience-result-rejected', workRef: parsed.data.workRef, reason: rejection },
          hostOrigin,
        );
        setHostNotice(hostResultRejectionCopy(rejection));
        return;
      }
      const next = addF290AssemblyHostResult(current, parsed.data.workRef, Date.now());
      lifecycleRef.current = next;
      setState(next);
      postHostResultReceipt(
        { type: 'collective:f290-experience-result-accepted', workRef: parsed.data.workRef },
        hostOrigin,
      );
      setHostNotice('Host 已按 Work 来源位置回传公开状态；私人施工内容仍留在 Café。');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [embedded, hostOrigin]);

  const selectChannel = (channelId: F290AssemblyChannelId) => setState((current) => ({ ...current, channelId }));
  const send = () => {
    const value = body.trim();
    if (!value || !canInteract) return;
    setState((current) => addF290AssemblyMessage(current, value, expectation, Date.now()));
    setBody('');
  };
  const respond = (id: string) => setState((current) => respondToF290AssemblyMessage(current, id));
  const toggleConnection = () => {
    const current = lifecycleRef.current;
    const next = setF290AssemblyConnection(current, current.connection === 'offline' ? 'online' : 'offline');
    lifecycleRef.current = next;
    setState(next);
  };
  const revokeParticipation = () => {
    const next = revokeF290AssemblyParticipation(lifecycleRef.current);
    lifecycleRef.current = next;
    setState(next);
  };
  const openCafe = () => {
    if (!canInteract) return;
    const delivered = embedded && hostRequest({ type: 'collective:f290-experience-open-cafe' }, hostOrigin);
    setHostNotice(delivered ? '已请求 Host 在同一上下文位置打开我的 Café。' : '连接你的 Café 后可见');
  };
  const openWork = (workRef: CollectiveF290ExperienceWorkRef) => {
    if (!canInteract) return;
    if (!findCollectiveF290ExperienceWork(workRef)) {
      setHostNotice('这项 Work 不在当前体验候选中。');
      return;
    }
    const delivered = embedded && hostRequest({ type: 'collective:f290-experience-open-work', workRef }, hostOrigin);
    setHostNotice(
      delivered ? '只把 Work 引用交给 Host；私有现场不进入 Service Client。' : '连接你的 Café 后可继续这项工作。',
    );
  };
  const admit = (catId: (typeof f290AssemblyCats)[number]['id']) => {
    if (!canInteract) return;
    const cat = findF290AssemblyCat(catId);
    if (!cat) return;
    setState((current) => admitF290AssemblyCat(current, catId));
    setMembershipNotice(`${cat.label}已在 # ${currentChannel.label} 值守`);
    setMembershipOpen(false);
  };
  const submitProposal = () => {
    const title = proposalTitle.trim();
    if (!title || !canInteract) return;
    setState((current) => addF290AssemblyProposal(current, title, Date.now()));
    setProposalTitle('');
    setProposalOpen(false);
  };

  return (
    <ProductShell
      embedded={embedded}
      collective={{
        collectiveId: 'col_f290_assembly_candidate',
        name: '猫咖共创组',
        createdByHumanId: 'human_f290_candidate',
        createdAt: '2026-09-07T00:00:00.000Z',
        role: 'member',
      }}
      connection={state.connection}
      canSteward={false}
      canPair={false}
      experienceGate="f290-assembly"
      onInvite={() => undefined}
      onPair={() => undefined}
      destinations={
        <F290AssemblyDestinationList
          canInteract={canInteract}
          channelId={state.channelId}
          onSelect={selectChannel}
          onOpenMembership={() => setMembershipOpen(true)}
        />
      }
    >
      <div className="f290-assembly-experience" data-testid="f290-assembly-experience">
        <F290AssemblyMobileChannelNavigation channelId={state.channelId} onSelect={selectChannel} />
        <section className="f290-channel-scene" aria-label={`# ${currentChannel.label}`}>
          <header className="f290-scene-header">
            <div>
              <p>体验候选 · 演示数据</p>
              <h2># {currentChannel.label}</h2>
              <span>You 的 Café × 此频道：具名猫、游标与上下文各自独立。</span>
            </div>
            <div className="f290-header-actions">
              {embedded ? (
                <button type="button" onClick={openCafe} disabled={!canInteract}>
                  打开我的 Café
                </button>
              ) : (
                <span>连接你的 Café 后可见</span>
              )}
              <button type="button" onClick={toggleConnection} disabled={state.participation === 'revoked'}>
                {state.connection === 'offline' ? '恢复连接' : '模拟离线'}
              </button>
            </div>
          </header>
          <div className="f290-message-flow">
            <section className="f290-endpoint-card" aria-label="频道接收端">
              <strong>You 的 Café · #{currentChannel.label}</strong>
              <span>持久游标 · standing interest · 上下文胶囊</span>
              <small>多猫可值守；这不是一条永不退出的 LLM session。</small>
            </section>
            {channelMessages.length === 0 ? (
              <div className="f290-empty-state">从一个真实输入开始：点名、提问，或只分享一句近况。</div>
            ) : (
              channelMessages.map((message) => (
                <article key={message.id} className="f290-message" data-work-ref={message.workRef}>
                  <header>
                    <strong>{message.recipient?.catId ? `You · 人 → ${message.recipient.label}` : 'You · 人'}</strong>
                    <span>{recipientLocationCopy(message)}</span>
                  </header>
                  <p>{message.body}</p>
                  <footer>
                    <span data-attention={message.status}>{attentionCopy(message)}</span>
                    {message.status === 'pending' && message.responderId && (
                      <button type="button" disabled={!canInteract} onClick={() => respond(message.id)}>
                        {findF290AssemblyCat(message.responderId)?.label}回应
                      </button>
                    )}
                  </footer>
                </article>
              ))
            )}
          </div>
          <form
            className="f290-composer"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <label>
              消息期待
              <select
                aria-label="消息期待"
                value={expectation}
                onChange={(event) => setExpectation(event.target.value as F290AssemblyCandidateMessage['expectation'])}
              >
                <option value="request">请求回应</option>
                <option value="expression">只是表达</option>
                <option value="unspecified">暂不说明</option>
              </select>
            </label>
            <textarea
              aria-label={`在 # ${currentChannel.label} 里说点什么`}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="点名具名成员，或直接说说正在发生什么…"
              rows={3}
              disabled={!canInteract}
            />
            <div>
              <small>显式点名按当前频道的可见成员寻址；未知对象保留不确定，不会被偷换成另一只猫。</small>
              <button
                type="submit"
                disabled={!canInteract || !body.trim()}
              >{`发送到 # ${currentChannel.label}`}</button>
            </div>
            {state.connection === 'offline' && <output>当前离线：位置保留，尚不冒充送达。</output>}
            {state.participation === 'revoked' && <output>参与已撤回；网络恢复不会让旧路由复活</output>}
          </form>
        </section>
        <F290AssemblyContextPanel
          availableCats={availableCats}
          canInteract={canInteract}
          channelLabel={currentChannel.label}
          embedded={embedded}
          hostNotice={hostNotice}
          members={channelMembers}
          membershipNotice={membershipNotice}
          membershipOpen={membershipOpen}
          onAdmit={admit}
          onOpenCafe={openCafe}
          onOpenMembership={() => setMembershipOpen(true)}
          onOpenProposal={() => setProposalOpen(true)}
          onOpenWork={openWork}
          onProposalTitleChange={setProposalTitle}
          onRevoke={revokeParticipation}
          onSubmitProposal={submitProposal}
          proposalOpen={proposalOpen}
          proposals={channelProposals}
          proposalTitle={proposalTitle}
        />
      </div>
    </ProductShell>
  );
}
