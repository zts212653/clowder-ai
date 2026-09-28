import { type CollectiveF290ExperienceWorkRef, collectiveF290ExperienceWorks } from '@cat-cafe/shared';
import { useState } from 'react';

import {
  type F290AssemblyCandidateProposal,
  type F290AssemblyChannelId,
  f290AssemblyCats,
  f290AssemblyChannels,
  findF290AssemblyChannel,
} from './f290-assembly-state.js';

export function F290AssemblyDestinationList({
  channelId,
  canInteract,
  onSelect,
  onOpenMembership,
}: {
  readonly channelId: F290AssemblyChannelId;
  readonly canInteract: boolean;
  readonly onSelect: (id: F290AssemblyChannelId) => void;
  readonly onOpenMembership: () => void;
}) {
  return (
    <nav className="destination-list f290-destination-list" aria-label="Collective 目的地">
      <p>共同现场</p>
      {f290AssemblyChannels.map((channel) => (
        <button
          key={channel.id}
          type="button"
          className={`destination-item ${channel.id === channelId ? 'destination-item-active' : ''}`}
          aria-current={channel.id === channelId ? 'page' : undefined}
          onClick={() => onSelect(channel.id)}
        >
          <span className="destination-symbol">#</span>
          <span>
            <strong>{channel.label}</strong>
            <small>{channel.id === 'product-direction' ? '砚砚正在值守' : '独立的频道位置与上下文'}</small>
          </span>
        </button>
      ))}
      <p className="f290-destination-heading">入口</p>
      <button
        type="button"
        className="destination-item"
        aria-label="成员入席"
        disabled={!canInteract}
        onClick={onOpenMembership}
      >
        <span className="destination-symbol">◌</span>
        <span>
          <strong>成员</strong>
          <small>从这里带 Café 入席</small>
        </span>
      </button>
    </nav>
  );
}

export function F290AssemblyMobileChannelNavigation({
  channelId,
  onSelect,
}: {
  readonly channelId: F290AssemblyChannelId;
  readonly onSelect: (channelId: F290AssemblyChannelId) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="f290-mobile-channel-navigation">
      <button type="button" aria-label="频道导航" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        频道导航 · #{findF290AssemblyChannel(channelId)?.label}
      </button>
      {open && (
        <nav aria-label="窄屏频道导航">
          {f290AssemblyChannels.map((channel) => (
            <button
              key={channel.id}
              type="button"
              aria-current={channel.id === channelId ? 'page' : undefined}
              onClick={() => {
                onSelect(channel.id);
                setOpen(false);
              }}
            >
              # {channel.label}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

export function F290AssemblyContextPanel({
  channelLabel,
  members,
  availableCats,
  proposals,
  embedded,
  canInteract,
  hostNotice,
  membershipOpen,
  membershipNotice,
  proposalOpen,
  proposalTitle,
  onOpenMembership,
  onAdmit,
  onOpenWork,
  onOpenCafe,
  onOpenProposal,
  onProposalTitleChange,
  onSubmitProposal,
  onRevoke,
}: {
  readonly channelLabel: string;
  readonly members: readonly (typeof f290AssemblyCats)[number][];
  readonly availableCats: readonly (typeof f290AssemblyCats)[number][];
  readonly proposals: readonly F290AssemblyCandidateProposal[];
  readonly embedded: boolean;
  readonly canInteract: boolean;
  readonly hostNotice?: string;
  readonly membershipOpen: boolean;
  readonly membershipNotice?: string;
  readonly proposalOpen: boolean;
  readonly proposalTitle: string;
  readonly onOpenMembership: () => void;
  readonly onAdmit: (catId: (typeof f290AssemblyCats)[number]['id']) => void;
  readonly onOpenWork: (workRef: CollectiveF290ExperienceWorkRef) => void;
  readonly onOpenCafe: () => void;
  readonly onOpenProposal: () => void;
  readonly onProposalTitleChange: (title: string) => void;
  readonly onSubmitProposal: () => void;
  readonly onRevoke: () => void;
}) {
  return (
    <aside className="f290-context-panel" aria-label="当前上下文">
      <p className="f290-truth-label">体验候选 · 演示数据</p>
      <section>
        <h3>具名成员</h3>
        {members.map((cat) => (
          <p key={cat.id}>
            <strong>{cat.label}</strong> · You 的 Café · {cat.role}
          </p>
        ))}
        <button type="button" onClick={onOpenMembership} disabled={!canInteract}>
          管理成员入席
        </button>
        {membershipOpen && (
          <div className="f290-candidate-action">
            <p>候选中的入席只改变此频道的演示状态；不伪造生产授权。</p>
            {availableCats.length > 0 ? (
              availableCats.map((cat) => (
                <button key={cat.id} type="button" disabled={!canInteract} onClick={() => onAdmit(cat.id)}>
                  {`让 ${cat.label} 在 # ${channelLabel} 值守`}
                </button>
              ))
            ) : (
              <small>此频道的候选成员已全部入席。</small>
            )}
          </div>
        )}
        {membershipNotice && <output>{membershipNotice}</output>}
      </section>
      <section>
        <h3>我的 Café</h3>
        {embedded ? (
          <>
            <p>同一逻辑上下文位置，私有内容由 Host 渲染。</p>
            {collectiveF290ExperienceWorks.map((work) => (
              <button
                key={work.ref}
                type="button"
                data-work-ref={work.ref}
                disabled={!canInteract}
                onClick={() => onOpenWork(work.ref)}
              >
                继续 {work.title} · {work.cat}
              </button>
            ))}
            <button type="button" onClick={onOpenCafe} disabled={!canInteract}>
              在 Host 中查看全部
            </button>
          </>
        ) : (
          <p>连接你的 Café 后可见。direct 入口不伪造家内 Work、私人正文或权限。</p>
        )}
        {hostNotice && <small className="f290-host-notice">{hostNotice}</small>}
      </section>
      <section>
        <h3>新事项</h3>
        {!proposalOpen ? (
          <button type="button" onClick={onOpenProposal} disabled={!canInteract}>
            提议新上下文
          </button>
        ) : (
          <form
            className="f290-candidate-action"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmitProposal();
            }}
          >
            <label>
              新事项标题
              <input
                aria-label="新事项标题"
                disabled={!canInteract}
                value={proposalTitle}
                onChange={(event) => onProposalTitleChange(event.target.value)}
              />
            </label>
            <button type="submit" disabled={!canInteract || !proposalTitle.trim()}>
              提交候选事项
            </button>
          </form>
        )}
        {proposals.map((proposal) => (
          <output key={proposal.id}>{`候选事项：${proposal.title}`}</output>
        ))}
        <p>候选事项不会自动创建 Task 或选择最近 Thread；仍须经过来源、Work 关系和 owner admission。</p>
      </section>
      <button className="f290-revoke" type="button" onClick={onRevoke} disabled={!canInteract}>
        撤回体验参与
      </button>
    </aside>
  );
}
