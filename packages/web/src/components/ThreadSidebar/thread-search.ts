import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';

export function isGroupableThread(thread: SidebarSnapshotRow): boolean {
  return thread.id !== 'default' && !thread.isHubThread && !thread.systemKind;
}

/** A complete feature number must not include a longer number, e.g. F3110. */
export function matchesThreadSearch(thread: SidebarSnapshotRow, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const fields = [
    thread.title ?? '',
    thread.id,
    thread.projectPath ?? '',
    thread.id === 'default' ? '大厅' : '未命名对话',
  ];
  if (/^f\d+$/.test(normalized)) {
    const feature = new RegExp(`(^|[^a-z0-9])${normalized}(?![a-z0-9])`, 'i');
    return fields.some((field) => feature.test(field));
  }
  return fields.some((field) => field.toLowerCase().includes(normalized));
}
