// Isolated synthetic conversation through the production host and built-in themes.
import { fixtureData, fixtureInput, fixtureSidebar, fixtureUi } from '../../../src/pdl/__tests__/chat-fixture';
import { messageQuoteSelection } from '../../../src/pdl/message-selection';
import { mountChat } from '../../../src/pdl/runtime';

declare global {
  interface Window {
    artifactFixtureReady: boolean;
    artifactOpenedPath: string;
    artifactReadSelection: () => ReturnType<typeof messageQuoteSelection>;
  }
}

const data = fixtureData(),
  state = fixtureUi();
const sha = 'f4212a2d84adf58e18fdd04968e988bdab586b02';
const report =
  '已针对 #2128 与 #2130 提交宿主全局修复 [PR #2131](https://github.com/zts212653/clowder-ai/pull/2131)（HEAD `' +
  sha +
  '`），验证说明见 `docs/SOP.md`。当前等待 CI 与独立审查。';
data.threads[0].title = '交付物引用与持球通知';
data.messages[1].content = report;
data.messages.push({
  ...data.messages[1],
  id: 'hold-notice',
  catId: undefined,
  from: { kind: 'system', service: 'hold-ball' },
  content: '等待中：' + report,
  source: { connector: 'hold-ball', label: '持球通知', icon: 'clock' },
});
state.draft = { 'chat-input': '草稿保持原样' };
state.workspace = {
  workbench: { fileMode: 'render', wt: 'fixture', pane: 'mine', wk: {} },
  preview: {},
  reviews: { works: {}, text: { mode: 'render' } },
};
const workbench = {
  opened: null as null | { worktreeId: string; file: { path: string; content: string; binary: boolean; mime: string } },
  fileInfo: { scope: '', load: '' },
  fileEdits: {},
  editing: { editMode: false, isTokenValid: false, canEdit: false },
  projectPicker: { browse: null, directories: {}, drives: [], completions: { prefix: '', entries: [] }, setup: {} },
  tasks: [],
  git: { id: '', load: 'loading' },
  native: { load: '', reviews: [], nativeTargets: [] },
  execution: {
    invocations: {},
    external: { threadId: data.threadId, load: '', sessions: [] },
    externalDetail: null,
    read: { threadId: data.threadId, load: '', sessions: [], runs: [] },
    detail: null,
    search: { threadId: data.threadId, query: '', load: '', hits: [] },
  },
  recall: { threadId: data.threadId, load: '', page: { readStatus: 'ready', nextCursor: null }, events: [] },
  fileSearch: { results: [], loading: false, error: null },
  workspace: {
    worktreeId: 'fixture',
    worktrees: [{ id: 'fixture', name: 'Fixture' }],
    tree: [],
    loading: false,
    error: null,
  },
};
const input = fixtureInput(data);
const port = {
  threadId: data.threadId,
  state,
  data: { ...input, project: { ...input.project, workbench } },
  sidebarData: fixtureSidebar(data),
  needed() {},
  attach() {},
  live: () => '',
  file: (s: string) => s,
  navResize: { width: () => 240, min: 160, max: () => 400 },
  richRender: async () => '<math><mi>x</mi></math>',
  async get(path: string) {
    if (path === '/api/config/console-themes')
      return { themes: { active: new URLSearchParams(location.search).get('theme') || 'sys:1', customs: [] } };
    if (path.startsWith('/api/console-themes/packages')) return fetch(path).then((r) => r.json());
    if (path === '/api/concierge/work/decisions')
      return {
        identity: { ownerUserId: 'fixture-owner' },
        status: 'available',
        attentionCount: 0,
        page: { offset: 0, limit: 20, hasMore: false },
        items: [],
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
    if (name === 'fileOpen') {
      window.artifactOpenedPath = args.p;
      const { content } = await fetch('/fixture-doc').then((r) => r.json());
      workbench.opened = {
        worktreeId: 'fixture',
        file: { path: args.p, content, binary: false, mime: 'text/markdown' },
      };
      workbench.fileInfo = { scope: JSON.stringify(['fixture', args.p]), load: '' };
      port.data = { ...input, project: { ...input.project, workbench: structuredClone(workbench) } };
      window.clowderChat.update(port as never);
      return true;
    }
  },
};
await mountChat(port as never);
window.artifactFixtureReady = true;
window.artifactReadSelection = () => {
  const row = document.querySelector<HTMLElement>('[data-stream] > [data-mid="hold-notice"]')!;
  return messageQuoteSelection(data.messages[2], row, window.getSelection()!);
};
