// Synthetic receipts rendered by the production PDL host; never connects to a live API.

import { fixtureData, fixtureInput, fixtureSidebar, fixtureUi } from '../../../src/pdl/__tests__/chat-fixture';

declare global {
  interface Window {
    __settled: () => Promise<void>;
    fixtureReady: boolean;
    settlePending: () => Promise<void>;
  }
}

import { mountChat } from '../../../src/pdl/runtime';

const data = fixtureData();
data.input = 'Keep this draft';
data.threads[0].title = 'Pending decisions acceptance';
const state = fixtureUi();
state.draft = { 'chat-input': data.input };
let pending = true;
const rows = ['old-approval', 'reply-1'].map((mid) => ({
  decisionRef: mid,
  summary: mid === 'old-approval' ? 'Review an older taste proposal' : 'Review a profile update',
  approval: {
    proposalId: mid,
    sourceFeatureId: 'F221',
    resolution: 'open',
    createdAt: Date.now() - 9 * 86400000,
    expiresAt: Date.now() - 2 * 86400000,
    navigation: { state: 'anchored', approvalCardRef: { threadId: data.threadId, messageId: mid } },
  },
  originalApprovalCard: { cardRef: { threadId: data.threadId, messageId: mid, blockId: 'taste-' + mid } },
}));
const port = {
  threadId: data.threadId,
  state,
  data: fixtureInput(data),
  sidebarData: fixtureSidebar(data),
  needed() {},
  navResize: { width: () => 240, min: 160, max: () => 400 },
  attach() {},
  live: () => '',
  file: (s: string) => s,
  richRender: async () => '<math><mi>x</mi></math>',
  async get(path: string, params?: Record<string, string>) {
    if (path === '/api/config/console-themes')
      return { themes: { active: new URLSearchParams(location.search).get('theme') || 'sys:1', customs: [] } };
    if (path.startsWith('/api/console-themes/packages')) return fetch(path).then((r) => r.json());
    if (path === '/api/concierge/work/decisions')
      return {
        identity: { ownerUserId: 'fixture-owner' },
        status: 'available',
        attentionCount: pending ? 2 : 0,
        page: { offset: 0, limit: 20, hasMore: false },
        items: pending && params?.mentionPeriod !== 'handled' ? rows : [],
      };
    if (path === '/api/concierge/confirmations') return { confirmations: [] };
    if (path === '/api/concierge/thread') return { threadId: null };
    if (path === '/api/concierge/work/mentions/last-handling') return { receipt: null };
    if (path === '/api/config/chat-background') return { threads: {} };
    if (path === '/api/config/chat-background/images') return { images: [] };
    if (path === '/api/accounts') return { providers: [] };
    if (path.startsWith('/api/accounts/')) return { selection: { members: [] } };
    if (path === '/api/plugin-manager/plugins') return { plugins: [] };
    if (path === '/api/plugin-manager/pdl') return { fragments: {} };
    return {};
  },
  async post() {
    return {};
  },
  async action(name: string, args: Record<string, string>) {
    if (name === 'jump') {
      if (!data.messages.some((m) => m.id === args.mid))
        data.messages.unshift({ ...data.messages[1], id: args.mid, content: 'The original older proposal' });
      state.pendingMid = args.mid;
      port.data = fixtureInput(data);
      window.clowderChat.update(port as never);
    }
  },
};
await mountChat(port as never);
Object.assign(window, {
  fixtureReady: true,
  settlePending: async () => {
    pending = false;
    await window.clowderChat.emit('cat-cafe:proposal-updated', {});
    await window.__settled();
  },
});
