import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectiveClient } from '../CollectiveClient.js';
import type { ClientSnapshot, CollectiveEventEnvelope } from '../client-types.js';

const client = vi.hoisted(() => ({
  snapshot: {} as ClientSnapshot,
  selectCollective: vi.fn(),
  sendMessage: vi.fn(),
  createInvite: vi.fn(),
  leaveCollective: vi.fn(),
  pairHost: vi.fn(),
  proposeWork: vi.fn(),
  commitWork: vi.fn(),
  declineWork: vi.fn(),
  acceptWorkResult: vi.fn(),
  completeWork: vi.fn(),
  createRoadmap: vi.fn(),
  setRoadmapWorks: vi.fn(),
  setRoadmapStatus: vi.fn(),
  createVote: vi.fn(),
  castVote: vi.fn(),
  closeVote: vi.fn(),
  createBindingVote: vi.fn(),
  castBindingVote: vi.fn(),
  withdrawBindingVote: vi.fn(),
  settleBindingVote: vi.fn(),
  setWorkDependencies: vi.fn(),
  setReaction: vi.fn(),
}));
vi.mock('../use-collective-client.js', () => ({ useCollectiveClient: () => client }));

const message: CollectiveEventEnvelope = {
  serviceInstanceId: 'svc_12345678',
  collectiveId: 'col_12345678',
  eventId: 'evt_12345678',
  clientEventId: 'default-channel-message',
  sequence: 1,
  actor: {
    kind: 'human',
    humanId: 'human_12345678',
    displayName: 'You',
    avatarUrl: 'https://avatars.githubusercontent.com/u/1',
  },
  target: { kind: 'channel', channelId: 'general' },
  location: { channelId: 'general' },
  recipient: { kind: 'channel' },
  body: '把今天的讨论留在这里，明天可以从同一个话题继续。',
  acceptedAt: '2026-09-10T01:00:00.000Z',
};

beforeEach(() => {
  const collective = {
    collectiveId: message.collectiveId,
    name: '猫咖共创组',
    createdByHumanId: 'human_12345678',
    createdAt: message.acceptedAt,
    role: 'steward' as const,
  };
  client.snapshot = {
    phase: 'ready',
    providers: [],
    collective,
    meta: {
      serviceInstanceId: message.serviceInstanceId,
      bootstrapNeeded: false,
      onboardingComplete: true,
      clientBuildId: 'test',
    },
    me: {
      human: { humanId: 'human_12345678', displayName: 'You', createdAt: message.acceptedAt },
      auth: { provider: 'github', handle: 'operator' },
      collectives: [collective],
    },
    events: [message, { ...message, eventId: 'evt_23456789', sequence: 2, location: { channelId: '设计评审' } }],
    participants: [],
    connection: 'online',
    delivery: { kind: 'idle' },
  };
  const browser = { parent: undefined as unknown };
  browser.parent = browser;
  vi.stubGlobal('window', browser);
  vi.stubGlobal('location', new URL('http://localhost:5272/'));
});
afterEach(() => vi.unstubAllGlobals());

describe('F290 default product entry', () => {
  it('renders Service messages even when an old experienceGate bookmark is opened', () => {
    vi.stubGlobal('location', new URL('http://localhost:5272/?experienceGate=f290-assembly'));
    const html = renderToStaticMarkup(<CollectiveClient />);
    expect(html).toContain(message.body);
    expect(html).not.toContain('演示数据');
    expect(html).not.toContain('模拟离线');
  });

  it('puts real channels in destination navigation without a channel form in the header', () => {
    const html = renderToStaticMarkup(<CollectiveClient />);
    const navigation = html.match(/<nav[^>]*aria-label="频道"[\s\S]*?<\/nav>/)?.[0];
    expect(navigation).toBeDefined();
    expect(navigation).toContain('设计评审');
    expect(html).not.toContain('aria-label="选择频道"');
    expect(html).not.toContain('请求谁回应');
  });

  it('renders the member avatar from the accepted public actor, with a member-card action', () => {
    const html = renderToStaticMarkup(<CollectiveClient />);
    expect(html).toContain('src="https://avatars.githubusercontent.com/u/1"');
    expect(html).toContain('aria-label="查看 You"');
  });

  it('does not invent Host destinations or unfinished spaces in the standalone Service', () => {
    const html = renderToStaticMarkup(<CollectiveClient />);
    expect(html).not.toContain('Needs Me');
    expect(html).not.toContain('我的 Café');
    expect(html).not.toContain('灵感公地');
    expect(html).not.toContain('Roadmap');
    expect(html).not.toContain('资料库');
  });

  it('shows an explicit response expectation as waiting until a real reply exists', () => {
    client.snapshot = {
      ...client.snapshot,
      events: [{ ...message, attentionRequest: 'response_requested' }],
    };
    expect(renderToStaticMarkup(<CollectiveClient />)).toContain('希望伙伴回应 · 尚未有人回应');

    client.snapshot = {
      ...client.snapshot,
      events: [
        { ...message, attentionRequest: 'response_requested' },
        {
          ...message,
          eventId: 'evt_reply890',
          clientEventId: 'reply',
          sequence: 2,
          replyToEventId: message.eventId,
          location: { channelId: 'general', rootEventId: message.eventId },
          body: '我家在跟进。',
        },
      ],
    };
    expect(renderToStaticMarkup(<CollectiveClient />)).toContain('希望伙伴回应 · 已有回应');
  });

  it('mounts real linked Work at its source and reveals Roadmap only after a persistent route exists', () => {
    expect(renderToStaticMarkup(<CollectiveClient />)).not.toContain('Roadmap');
    if (message.actor.kind !== 'human') throw new Error('Expected Human fixture');
    const actor = { kind: 'human' as const, humanId: message.actor.humanId, displayName: message.actor.displayName };
    const work = {
      v: 1 as const,
      serviceInstanceId: message.serviceInstanceId,
      collectiveId: message.collectiveId,
      workId: 'work_aaaaaaaa',
      sourceEventId: message.eventId,
      sourceLocation: { channelId: 'general' },
      title: '把讨论长成可追溯工作',
      intendedOutcome: '负责人、推进者和结果回到原消息。',
      proposedBy: actor,
      dependencyWorkIds: [],
      lifecycle: 'proposed' as const,
      status: 'proposed' as const,
      revision: 1,
      createdAt: message.acceptedAt,
      updatedAt: message.acceptedAt,
      history: [{ revision: 1, action: 'proposed' as const, actor, at: message.acceptedAt }],
    };
    client.snapshot = {
      ...client.snapshot,
      collaboration: {
        serviceInstanceId: message.serviceInstanceId,
        collectiveId: message.collectiveId,
        works: [work],
        roadmaps: [
          {
            v: 1,
            serviceInstanceId: message.serviceInstanceId,
            collectiveId: message.collectiveId,
            roadmapId: 'roadmap_aaaaaaaa',
            sourceEventId: message.eventId,
            sourceLocation: { channelId: 'general' },
            title: '共同路线',
            purpose: '让讨论、依赖和结果在一处继续。',
            accountableHumanId: message.actor.humanId,
            workIds: [work.workId],
            status: 'active',
            revision: 1,
            createdAt: message.acceptedAt,
            updatedAt: message.acceptedAt,
            history: [{ revision: 1, action: 'created', actor, at: message.acceptedAt }],
          },
        ],
        votes: [],
        bindingVotes: [],
        decisions: [],
      },
    };
    const html = renderToStaticMarkup(<CollectiveClient />);
    expect(html).toContain('工作提议 · 来自这条消息');
    expect(html).toContain(work.title);
    expect(html).toContain('Roadmap');
  });
});
