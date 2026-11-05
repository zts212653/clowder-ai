import { type FormEvent, useEffect, useRef, useState } from 'react';
import { collectiveClientErrorMessage } from './client-request.js';
import type { ClientSnapshot } from './client-types.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';

export function SharedArtifactPublication({
  snapshot,
  onPair,
  onShareMedia,
}: {
  readonly snapshot: ClientSnapshot;
  readonly onPair: () => void;
  readonly onShareMedia?: (sourceEventId: string) => void;
}) {
  const shared = useSharedArtifacts();
  const source = snapshot.events.find((event) => event.eventId === shared?.publicationSource);
  const cafes = snapshot.members?.cafes.filter((cafe) => cafe.humanId === snapshot.me?.human.humanId) ?? [];
  const [file, setFile] = useState<File>();
  const [title, setTitle] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [workId, setWorkId] = useState('');
  const sourceWorks = snapshot.collaboration?.works.filter((work) => work.sourceEventId === source?.eventId) ?? [];
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const sourceId = source?.eventId;
  useEffect(() => {
    if (!sourceId) {
      dialog.current?.close();
      return;
    }
    setFile(undefined);
    setTitle('');
    setConnectionId('');
    setWorkId('');
    setError(undefined);
    dialog.current?.showModal();
  }, [sourceId]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!shared?.api || !file || !source || !title.trim() || pending) return;
    const target = connectionId || cafes[0]?.connectionId;
    if (!target) return;
    setPending(true);
    setError(undefined);
    try {
      const artifact = await shared.api.publish({
        file,
        title: title.trim(),
        connectionId: target,
        sourceEventId: source.eventId,
        ...(workId ? { workId } : {}),
      });
      await shared.refresh();
      if (mounted.current) {
        shared.open(artifact);
        shared.closePublication();
      }
    } catch (failure) {
      if (mounted.current) setError(collectiveClientErrorMessage(failure));
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="shared-publication-dialog"
      onCancel={() => shared?.closePublication()}
      onClose={() => shared?.closePublication()}
    >
      <form onSubmit={(event) => void submit(event)}>
        <header>
          <h2>分享共同作品</h2>
          <button type="button" aria-label="关闭分享" onClick={() => shared?.closePublication()}>
            ×
          </button>
        </header>
        <p>作品将回到这条讨论，成员可以一起阅读和批注。</p>
        <blockquote>{source?.body}</blockquote>
        {onShareMedia && source && (
          <button
            type="button"
            onClick={() => {
              dialog.current?.close();
              onShareMedia(source.eventId);
            }}
          >
            从此 Café 选择图片或视频
          </button>
        )}
        {!cafes.length ? (
          <p>
            先连接自己的 Café，再分享作品。
            <button type="button" onClick={onPair}>
              连接我的 Café
            </button>
          </p>
        ) : (
          <>
            <label>
              Markdown 文件
              <input
                type="file"
                accept=".md,.markdown,text/markdown"
                required
                onChange={(event) => {
                  const selected = event.target.files?.[0];
                  setFile(selected);
                  setError(undefined);
                  if (selected) setTitle(selected.name.replace(/\.(md|markdown)$/i, ''));
                }}
              />
            </label>
            <label>
              作品名称
              <input value={title} required maxLength={200} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label>
              作品存放在
              <select
                value={connectionId || cafes[0]?.connectionId}
                onChange={(event) => setConnectionId(event.target.value)}
              >
                {cafes.map((cafe) => (
                  <option key={cafe.connectionId} value={cafe.connectionId}>
                    {cafe.endpointLabel}
                  </option>
                ))}
              </select>
            </label>
            {sourceWorks.length > 0 && (
              <label>
                属于任务
                <select value={workId} onChange={(event) => setWorkId(event.target.value)}>
                  <option value="">这条讨论中的作品</option>
                  {sourceWorks.map((work) => (
                    <option key={work.workId} value={work.workId}>
                      {work.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <small>支持 UTF-8 Markdown，最大 64KB。这个 Café 离线时，作品会暂时无法打开。</small>
          </>
        )}
        {error && <p role="alert">{error} 请保留文件，重试会接着同一次发布。</p>}
        <footer>
          <button type="button" onClick={() => shared?.closePublication()}>
            {pending ? '关闭' : '取消'}
          </button>
          <button type="submit" disabled={!file || !title.trim() || !cafes.length || pending}>
            {pending ? '正在分享…' : '分享作品'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
