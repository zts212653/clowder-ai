import { type CollectiveF290ExperienceWorkRef, findCollectiveF290ExperienceWork } from '@cat-cafe/shared';

export type F290AssemblyChannelId = 'product-direction' | 'community';
export type F290AssemblyConnection = 'online' | 'offline';
export type F290AssemblyParticipation = 'active' | 'revoked';
export type F290AssemblyMessageStatus = 'quiet' | 'pending' | 'uncertain' | 'responded' | 'result';
export type F290AssemblyExpectation = 'expression' | 'request' | 'unspecified';

export const f290AssemblyChannels = [
  { id: 'product-direction', label: '产品方向' },
  { id: 'community', label: '社区协作' },
] as const satisfies readonly { readonly id: F290AssemblyChannelId; readonly label: string }[];

export const f290AssemblyCats = [
  { id: 'yan', label: '砚砚', role: '日常协作值守' },
  { id: 'xian', label: '宪宪', role: '审计 / 查漏值守' },
] as const;

export type F290AssemblyCatId = (typeof f290AssemblyCats)[number]['id'];

export interface F290AssemblyRecipient {
  readonly label: string;
  readonly catId?: F290AssemblyCatId;
}

export interface F290AssemblyCandidateMessage {
  readonly id: string;
  readonly channelId: F290AssemblyChannelId;
  readonly body: string;
  readonly expectation: F290AssemblyExpectation;
  readonly recipient?: F290AssemblyRecipient;
  readonly responderId?: F290AssemblyCatId;
  readonly status: F290AssemblyMessageStatus;
  readonly workRef?: CollectiveF290ExperienceWorkRef;
}

export interface F290AssemblyCandidateProposal {
  readonly id: string;
  readonly channelId: F290AssemblyChannelId;
  readonly title: string;
}

export interface F290AssemblyCandidateState {
  readonly channelId: F290AssemblyChannelId;
  readonly connection: F290AssemblyConnection;
  readonly participation: F290AssemblyParticipation;
  readonly memberships: Readonly<Record<F290AssemblyChannelId, readonly F290AssemblyCatId[]>>;
  readonly messages: readonly F290AssemblyCandidateMessage[];
  readonly proposals: readonly F290AssemblyCandidateProposal[];
}

export const f290AssemblyDefaultState: F290AssemblyCandidateState = {
  channelId: 'product-direction',
  connection: 'online',
  participation: 'active',
  memberships: {
    'product-direction': ['yan'],
    community: ['yan'],
  },
  messages: [],
  proposals: [],
};

export function findF290AssemblyChannel(channelId: string) {
  return f290AssemblyChannels.find((channel) => channel.id === channelId);
}

export function findF290AssemblyCat(catId: string | undefined) {
  return f290AssemblyCats.find((cat) => cat.id === catId);
}

export function f290AssemblyMembers(
  state: F290AssemblyCandidateState,
  channelId: F290AssemblyChannelId = state.channelId,
) {
  return state.memberships[channelId].flatMap((catId) => {
    const cat = findF290AssemblyCat(catId);
    return cat ? [cat] : [];
  });
}

export function canInteractWithF290Assembly(state: Pick<F290AssemblyCandidateState, 'connection' | 'participation'>) {
  return state.connection === 'online' && state.participation === 'active';
}

export function resolveF290AssemblyRecipient(
  body: string,
  members: readonly (typeof f290AssemblyCats)[number][],
): F290AssemblyRecipient | undefined {
  const rawName = /@([^\s，。！？!?：:]+)/u.exec(body)?.[1];
  if (!rawName) return undefined;
  const cat = members.find((candidate) => candidate.label === rawName);
  return cat ? { label: cat.label, catId: cat.id } : { label: `@${rawName}` };
}

export function setF290AssemblyConnection(
  state: F290AssemblyCandidateState,
  connection: F290AssemblyConnection,
): F290AssemblyCandidateState {
  if (state.participation === 'revoked') return state;
  return { ...state, connection };
}

export function revokeF290AssemblyParticipation(state: F290AssemblyCandidateState): F290AssemblyCandidateState {
  return { ...state, participation: 'revoked', connection: 'online' };
}

export function admitF290AssemblyCat(
  state: F290AssemblyCandidateState,
  catId: F290AssemblyCatId,
  channelId: F290AssemblyChannelId = state.channelId,
): F290AssemblyCandidateState {
  if (!canInteractWithF290Assembly(state) || state.memberships[channelId].includes(catId)) return state;
  return {
    ...state,
    memberships: {
      ...state.memberships,
      [channelId]: [...state.memberships[channelId], catId],
    },
  };
}

export function addF290AssemblyMessage(
  state: F290AssemblyCandidateState,
  body: string,
  expectation: F290AssemblyExpectation,
  now: number,
): F290AssemblyCandidateState {
  const value = body.trim();
  if (!canInteractWithF290Assembly(state) || !value) return state;
  const members = f290AssemblyMembers(state);
  const recipient = resolveF290AssemblyRecipient(value, members);
  const responderId = recipient?.catId;
  return {
    ...state,
    messages: [
      ...state.messages,
      {
        id: `message-${now}`,
        channelId: state.channelId,
        body: value,
        expectation,
        recipient,
        responderId,
        status: f290AssemblyMessageStatus(recipient, expectation),
      },
    ],
  };
}

export function addF290AssemblyProposal(
  state: F290AssemblyCandidateState,
  title: string,
  now: number,
): F290AssemblyCandidateState {
  if (!canInteractWithF290Assembly(state) || !title.trim()) return state;
  return {
    ...state,
    proposals: [...state.proposals, { id: `proposal-${now}`, channelId: state.channelId, title: title.trim() }],
  };
}

export function respondToF290AssemblyMessage(
  state: F290AssemblyCandidateState,
  messageId: string,
): F290AssemblyCandidateState {
  if (!canInteractWithF290Assembly(state)) return state;
  return {
    ...state,
    messages: state.messages.map((message) =>
      message.id === messageId && message.status === 'pending' && message.responderId
        ? { ...message, status: 'responded' }
        : message,
    ),
  };
}

export function addF290AssemblyHostResult(
  state: F290AssemblyCandidateState,
  workRef: CollectiveF290ExperienceWorkRef,
  now: number,
): F290AssemblyCandidateState {
  const work = findCollectiveF290ExperienceWork(workRef);
  if (!work || !canInteractWithF290Assembly(state)) return state;
  return {
    ...state,
    messages: [
      ...state.messages,
      {
        id: `result-${workRef}-${now}`,
        channelId: work.channelId,
        body: `${work.title} 已从我的 Café 回到这里`,
        expectation: 'unspecified',
        status: 'result',
        workRef,
      },
    ],
  };
}

export function restoreF290AssemblyCandidateState(raw: unknown): F290AssemblyCandidateState {
  if (!isRecord(raw)) return f290AssemblyDefaultState;
  const channel = typeof raw.channelId === 'string' ? findF290AssemblyChannel(raw.channelId) : undefined;
  if (!channel || !Array.isArray(raw.messages)) return f290AssemblyDefaultState;
  const legacyPhase = raw.phase;
  const connection = raw.connection === 'offline' || legacyPhase === 'offline' ? 'offline' : 'online';
  const participation = raw.participation === 'revoked' || legacyPhase === 'revoked' ? 'revoked' : 'active';
  return {
    channelId: channel.id,
    connection,
    participation,
    memberships: restoreMemberships(raw.memberships),
    messages: raw.messages.flatMap(restoreMessage),
    proposals: Array.isArray(raw.proposals) ? raw.proposals.flatMap(restoreProposal) : [],
  };
}

function restoreMemberships(raw: unknown): F290AssemblyCandidateState['memberships'] {
  if (!isRecord(raw)) return f290AssemblyDefaultState.memberships;
  return {
    'product-direction': restoreMemberIds(raw['product-direction']),
    community: restoreMemberIds(raw.community),
  };
}

function restoreMemberIds(raw: unknown): readonly F290AssemblyCatId[] {
  if (!Array.isArray(raw)) return ['yan'];
  const memberIds = raw.filter(isF290AssemblyCatId);
  return memberIds.length > 0 ? [...new Set(memberIds)] : ['yan'];
}

function restoreMessage(raw: unknown): F290AssemblyCandidateMessage[] {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.body !== 'string') return [];
  const channel = typeof raw.channelId === 'string' ? findF290AssemblyChannel(raw.channelId) : undefined;
  const expectation = isExpectation(raw.expectation) ? raw.expectation : 'unspecified';
  const status = isMessageStatus(raw.status) ? raw.status : 'uncertain';
  if (!channel) return [];
  const recipient =
    restoreRecipient(raw.recipient) ?? (raw.mentioned === true ? { label: '砚砚', catId: 'yan' } : undefined);
  const responderId = isF290AssemblyCatId(raw.responderId) ? raw.responderId : undefined;
  const workRef =
    typeof raw.workRef === 'string' && /^work_demo_[A-Za-z0-9_-]+$/.test(raw.workRef) ? raw.workRef : undefined;
  return [{ id: raw.id, channelId: channel.id, body: raw.body, expectation, recipient, responderId, status, workRef }];
}

function restoreRecipient(raw: unknown): F290AssemblyRecipient | undefined {
  if (!isRecord(raw) || typeof raw.label !== 'string') return undefined;
  const catId = isF290AssemblyCatId(raw.catId) ? raw.catId : undefined;
  return { label: raw.label, catId };
}

function restoreProposal(raw: unknown): F290AssemblyCandidateProposal[] {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.title !== 'string') return [];
  const channel = typeof raw.channelId === 'string' ? findF290AssemblyChannel(raw.channelId) : undefined;
  return channel ? [{ id: raw.id, channelId: channel.id, title: raw.title }] : [];
}

function isExpectation(value: unknown): value is F290AssemblyExpectation {
  return value === 'expression' || value === 'request' || value === 'unspecified';
}

function f290AssemblyMessageStatus(
  recipient: F290AssemblyRecipient | undefined,
  expectation: F290AssemblyExpectation,
): F290AssemblyMessageStatus {
  if (recipient && !recipient.catId) return 'uncertain';
  if (expectation === 'request') return 'pending';
  return expectation === 'expression' ? 'quiet' : 'uncertain';
}

function isMessageStatus(value: unknown): value is F290AssemblyMessageStatus {
  return (
    value === 'quiet' || value === 'pending' || value === 'uncertain' || value === 'responded' || value === 'result'
  );
}

function isF290AssemblyCatId(value: unknown): value is F290AssemblyCatId {
  return typeof value === 'string' && Boolean(findF290AssemblyCat(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}
