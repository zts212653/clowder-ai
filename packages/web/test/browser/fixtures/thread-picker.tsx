import { createRoot } from 'react-dom/client';
import type { PlatformOperationStatus } from '@/components/HubConfigIcons';
import { ActionRenderer } from '@/components/settings/primitives/ActionRenderer';
import { useLabelStore } from '@/stores/label-store';
import { type SidebarSnapshotRow, useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/cat-persona-tokens.css';
import '@/app/connector-tokens.css';
import '@/app/theme-extras.css';
import '@/app/console-controls.css';
import '@/app/shell-v2.css';

function row(
  id: string,
  title: string,
  options: Partial<Pick<SidebarSnapshotRow, 'pinned' | 'labels' | 'lastActiveAt' | 'systemKind'>> = {},
): SidebarSnapshotRow {
  return {
    id,
    title,
    participants: [],
    pinned: false,
    favorited: false,
    labels: [],
    preferredCats: [],
    projectPath: '/project/alpha',
    lastActiveAt: 100,
    systemKind: null,
    isHubThread: false,
    unreadCount: 0,
    hasUserMention: false,
    presence: { status: 'idle' },
    ...options,
  };
}

useSidebarProjectionStore.setState({
  rows: [
    row('t1', '置顶的发布复盘', { pinned: true, lastActiveAt: 300 }),
    row('t2', '导出失败调查', { labels: ['release'], lastActiveAt: 200 }),
    row('t3', '连接器房间', { systemKind: 'connector_hub', lastActiveAt: 400 }),
  ],
  pendingThreadCommands: {},
  hasCanonicalSnapshot: true,
});
useLabelStore.setState({
  labels: [{ id: 'release', name: '发布', color: '#8b5e3c', sortOrder: 0, createdBy: 'owner', createdAt: 1 }],
});

const operation: PlatformOperationStatus = {
  name: 'threads',
  label: '监听会话',
  actions: [{ id: 'list', label: '读取会话', render: 'status', resultRender: 'thread-picker' }],
  rowActions: [{ id: 'choose', label: '保存', next: 'list' }],
};

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

createRoot(root).render(
  <main className="cafe-presentation min-h-screen bg-cafe-surface p-6 text-cafe">
    <div className="mx-auto max-w-3xl">
      <ActionRenderer target={{ kind: 'plugin', id: 'fixture' }} operation={operation} />
    </div>
  </main>,
);
