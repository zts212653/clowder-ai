/** The engine owns the export frame. This only binds address parameters to its data owner. */
export function readThreadExportAddress(address: { hash: string; search: string }) {
  if (!address.hash.startsWith('#export-')) return null;
  const threadId = decodeURIComponent(address.hash.slice('#export-'.length));
  if (!threadId) throw new Error('导出地址缺少对话 ID');
  const mids = new URLSearchParams(address.search).getAll('messageId');
  if (mids.some((mid) => !mid) || new Set(mids).size !== mids.length) throw new Error('导出消息 ID 无效');
  return { threadId, mids: mids.length ? mids : null };
}
