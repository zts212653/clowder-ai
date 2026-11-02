'use client';
import type {
  AssetCanonItem,
  AssetCanonRecord,
  AssetCanonUpdate,
  AssetUpdateDecision,
  WorkContextRecord,
} from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { AssetCanonJudgment } from './AssetCanonJudgment';
import { AssetCanonSupersession } from './AssetCanonSupersession';
import { AssetCanonUpdateView } from './AssetCanonUpdateView';
import { addAssetToChat } from './asset-canon-chat';
import { canonAssetUrl, canonCommand } from './asset-canon-client';
import { canonActor, canonStatusLabel } from './asset-canon-presentation';
import { VideoWorkMaterialPreview } from './VideoWorkMaterialPreview';
import type { MaterialUsageProps } from './VideoWorkMaterialUses';

type Detail = AssetCanonItem & {
  nextAfter?: number;
  uses: { reference: { contentRef: string; ownerRevision: number }; title: string; uses: string[] }[];
};
type History = {
  nextAfter?: number;
  history: {
    kind: string;
    record: AssetCanonRecord;
    actor?: { kind: string; actorId: string };
    reason?: string;
    recordedAt?: string;
  }[];
  decisions: AssetUpdateDecision[];
};

export function AssetCanonDetail({
  item,
  update,
  record,
  threadId,
  candidates,
  onSaved,
  onNextVersion,
  workTitle,
  clock,
  onSeek,
}: {
  workTitle?: string;
  item: AssetCanonItem;
  update?: AssetCanonUpdate;
  record: WorkContextRecord;
  threadId: string;
  candidates: AssetCanonItem[];
  onSaved: () => void;
  onNextVersion: (body: string) => Promise<void>;
} & Pick<MaterialUsageProps, 'clock' | 'onSeek'>) {
  const operations = useRef(new Map<string, string>());
  const mutate = (intent: Record<string, unknown>) => {
    const key = JSON.stringify(intent);
    if (!operations.current.has(key)) operations.current.set(key, crypto.randomUUID());
    return canonCommand(threadId, { ...intent, operationId: operations.current.get(key)! });
  };
  const [detail, setDetail] = useState<Detail>();
  const [showUpdate, setShowUpdate] = useState(true);
  const [status, setStatus] = useState<AssetCanonRecord['status']>(item.record.status);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<History>();
  const [showHistory, setShowHistory] = useState(false);
  const [superseding, setSuperseding] = useState(false);
  const current = detail ?? item;
  useEffect(() => {
    const abort = new AbortController();
    setDetail(undefined);
    setError('');
    setStatus(item.record.status);
    void canonCommand<Detail>(
      threadId,
      { action: 'read-asset', indexedVersionRef: item.record.indexedVersionRef },
      abort.signal,
    )
      .then((d) => {
        if (!abort.signal.aborted) {
          setDetail(d);
          setStatus(d.record.status);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setError('这件素材暂时无法读取。');
      });
    return () => abort.abort();
  }, [threadId, item.record.indexedVersionRef, item.record.revision]);
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await operation();
      setReason('');
      onSaved();
      return true;
    } catch {
      setError('未能保存。素材或权限可能已变化，请核对后重试；填写的理由仍在。');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const url = canonAssetUrl(item, threadId);
  return (
    <section className="space-y-4 p-3 text-sm" aria-label="素材详情">
      {update ? (
        <button type="button" className="text-xs text-cafe-accent" onClick={() => setShowUpdate(!showUpdate)}>
          {showUpdate ? '素材详情与标记' : '查看更新提示'}
        </button>
      ) : null}
      {update && showUpdate ? (
        <AssetCanonUpdateView
          item={item}
          update={update}
          record={record}
          clock={clock}
          onSeek={onSeek}
          threadId={threadId}
          busy={busy}
          act={act}
          mutate={mutate}
          onNextVersion={onNextVersion}
        />
      ) : (
        <>
          <VideoWorkMaterialPreview
            key={url}
            initiallyOpen
            url={url}
            name={item.record.name}
            mediaType={item.record.version.mediaType}
          />
          <h3 className="break-all font-semibold">{item.record.name.split('/').at(-1)}</h3>
          <p className="text-xs text-cafe-muted">
            {item.record.kind} · {item.record.version.byteLength.toLocaleString()} 字节
          </p>
          {detail?.canWrite ? (
            <AssetCanonJudgment
              item={current}
              status={status}
              setStatus={setStatus}
              reason={reason}
              setReason={setReason}
              candidates={candidates}
              record={record}
              busy={busy}
              act={act}
              mutate={mutate}
            />
          ) : null}
          <p>现在 · {current.record.status ? canonStatusLabel[current.record.status] : '还没标'}</p>
          {current.record.judgment ? (
            <>
              <p className="whitespace-pre-wrap">为什么 · {current.record.judgment.reason}</p>
              <p className="text-xs text-cafe-muted">
                {canonActor(current.record.judgment.actor)} · {current.record.judgment.recordedAt.slice(0, 10)}
              </p>
            </>
          ) : null}
          <div className="border-t border-cafe-subtle pt-3">
            <p>也用在</p>
            {!detail ? (
              <p className="mt-1 text-xs text-cafe-muted">{error ? '使用记录暂时无法读取' : '正在读取使用记录…'}</p>
            ) : null}
            {detail?.uses
              .filter((u) => u.reference.contentRef !== record.reference.contentRef)
              .map((u) => (
                <p className="mt-1 text-xs" key={`${u.reference.contentRef}:${u.reference.ownerRevision}`}>
                  {u.title} · 第 {u.reference.ownerRevision} 版
                </p>
              ))}
            {detail?.nextAfter !== undefined ? (
              <button
                type="button"
                className="text-xs text-cafe-accent"
                onClick={() =>
                  void canonCommand<Detail>(threadId, {
                    action: 'read-asset',
                    indexedVersionRef: item.record.indexedVersionRef,
                    after: detail.nextAfter,
                  })
                    .then((next) => setDetail({ ...next, uses: [...detail.uses, ...next.uses] }))
                    .catch(() => setError('其余使用记录暂时无法读取。'))
                }
              >
                继续看使用记录
              </button>
            ) : null}
            {detail &&
            detail.nextAfter === undefined &&
            !detail.uses.some((u) => u.reference.contentRef !== record.reference.contentRef) ? (
              <p className="mt-1 text-xs text-cafe-muted">别的片子没用到</p>
            ) : null}
          </div>
        </>
      )}
      <button
        type="button"
        className="rounded border border-cafe-subtle px-3 py-2 text-cafe-accent"
        onClick={() => {
          const result = addAssetToChat(threadId, item, workTitle);
          if (result) setError(result);
        }}
      >
        对这件说一句
      </button>
      <div className="flex flex-wrap gap-3 border-t border-cafe-subtle pt-3 text-xs text-cafe-muted">
        <button
          type="button"
          onClick={() => {
            setShowHistory(!showHistory);
            if (!showHistory)
              void canonCommand<History>(threadId, {
                action: 'read-asset-history',
                indexedVersionRef: item.record.indexedVersionRef,
                reference: record.reference,
              })
                .then(setHistory)
                .catch(() => setError('经过暂时无法读取。'));
          }}
        >
          看取代经过
        </button>
        <a href={url} target="_blank" rel="noreferrer">
          打开原件
        </a>
        {detail?.canWrite && current.record.status === 'canonical' && !current.record.supersededBy ? (
          <button type="button" onClick={() => setSuperseding(!superseding)}>
            取代旧的一件…
          </button>
        ) : null}
      </div>
      {superseding ? (
        <AssetCanonSupersession
          item={current}
          candidates={candidates}
          record={record}
          threadId={threadId}
          busy={busy}
          act={act}
          mutate={mutate}
        />
      ) : null}
      {showHistory ? (
        <div className="space-y-2 text-xs">
          {history?.history.map((event) => (
            <p key={event.record.revision}>
              {event.actor
                ? `${canonActor(event.actor)} · ${event.recordedAt?.slice(0, 10)} · ${event.reason}`
                : event.kind}
            </p>
          ))}
          {history?.nextAfter !== undefined ? (
            <button
              type="button"
              onClick={() =>
                void canonCommand<History>(threadId, {
                  action: 'read-asset-history',
                  indexedVersionRef: item.record.indexedVersionRef,
                  reference: record.reference,
                  after: history.nextAfter,
                })
                  .then((next) => setHistory({ ...next, history: [...history.history, ...next.history] }))
                  .catch(() => setError('其余经过暂时无法读取。'))
              }
            >
              继续看经过
            </button>
          ) : null}
          {history?.decisions.map((d) => (
            <p key={d.operationId}>
              {canonActor(d.actor)} 选择这版保留 · {d.recordedAt.slice(0, 10)} · {d.reason}
            </p>
          ))}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs">
          {error}
        </p>
      ) : null}
    </section>
  );
}
