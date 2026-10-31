import type { EntityMemoryOwnerBrowse, EntityMemoryOwnerEntry } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { MemoryEntityProposals } from './MemoryOriginalProposals';
import { MemoryForgetControl, MemoryOwnerFeedback, MemoryOwnerSource } from './MemoryOwnerControls';
import { MemoryReadState } from './MemoryReadState';
import { type EntityMemoryDetailRead, isEntityBrowse, isEntityDetail } from './owner-memory-read';
import { useMemoryOwnerAction } from './use-memory-owner-action';
import { formatMemoryDate, useMemoryRead } from './use-memory-read';

function EntityDetail({
  entry,
  close,
  reload,
}: {
  entry: EntityMemoryOwnerEntry;
  close: () => void;
  reload: () => void;
}) {
  const path = `/api/memory/entities/${encodeURIComponent(entry.id)}`;
  const detail = useMemoryRead<EntityMemoryDetailRead>(
    `${path}?revision=${encodeURIComponent(entry.revision)}`,
    isEntityDetail,
  );
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(entry.canonicalName);
  const [aliases, setAliases] = useState(entry.aliases.join('\n'));
  const [retiring, setRetiring] = useState(false);
  const action = useMemoryOwnerAction(`${path}/actions`, entry.id, () => {
    close();
    reload();
  });
  const data = detail.data;
  return (
    <aside
      aria-label="实体详情"
      className="space-y-4 rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-4 md:p-6"
    >
      <div className="flex justify-between gap-3">
        <h2 className="text-base font-medium">实体详情</h2>
        <button type="button" onClick={close} className="text-compact text-cafe-accent underline">
          返回实体
        </button>
      </div>
      <MemoryReadState
        loading={detail.loading}
        error={detail.error}
        empty={false}
        noun="实体详情"
        retry={detail.retry}
      />
      <MemoryOwnerFeedback action={action} reread={reload} />
      {data && (
        <>
          <h3 className="text-display-sm">{data.canonicalName}</h3>
          <p className="text-compact text-cafe-muted">
            {data.status === 'retired' ? '已不再使用' : '当前记住的实体'} · {formatMemoryDate(data.updatedAt)}
          </p>
          {data.aliases.length > 0 && <p className="text-sm">也叫：{data.aliases.join('、')}</p>}
          <MemoryOwnerSource endpoint={`${path}/source?revision=${encodeURIComponent(data.revision)}`} />
          <MemoryEntityProposals proposals={data.proposals} />
          {data.status === 'active' && (
            <>
              <div className="flex gap-3 text-compact text-cafe-accent">
                <button
                  type="button"
                  disabled={action.blocked}
                  onClick={() => {
                    setName(data.canonicalName);
                    setAliases(data.aliases.join('\n'));
                    setEditing(!editing);
                  }}
                >
                  修改实体
                </button>
                <button type="button" disabled={action.blocked} onClick={() => setRetiring(!retiring)}>
                  不再使用
                </button>
              </div>
              {editing && (
                <form
                  className="space-y-3 text-compact"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (name.trim())
                      action.submit({
                        action: 'correct',
                        expectedRevision: data.revision,
                        patch: {
                          canonicalName: name.trim(),
                          aliases: aliases
                            .split('\n')
                            .map((item) => item.trim())
                            .filter(Boolean),
                        },
                      });
                  }}
                >
                  <label className="block">
                    实体名称
                    <textarea
                      aria-label="实体名称"
                      required
                      maxLength={200}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      className="mt-1 w-full rounded-lg border border-cafe-subtle bg-cafe-surface-sunken p-3"
                    />
                  </label>
                  <label className="block">
                    别名（每行一个）
                    <textarea
                      aria-label="实体别名"
                      value={aliases}
                      onChange={(event) => setAliases(event.target.value)}
                      className="mt-1 w-full rounded-lg border border-cafe-subtle bg-cafe-surface-sunken p-3"
                    />
                  </label>
                  <button type="submit" disabled={action.blocked} className="text-cafe-accent underline">
                    保存实体
                  </button>
                </form>
              )}
              {retiring && (
                <div className="space-y-2 text-compact">
                  <p>停止用于新的关联，保留历史，不删除原始来源。</p>
                  <button
                    type="button"
                    disabled={action.blocked}
                    onClick={() => action.submit({ action: 'retire', expectedRevision: data.revision })}
                    className="text-cafe-accent underline"
                  >
                    确认不再使用
                  </button>
                </div>
              )}
            </>
          )}
          <MemoryForgetControl revision={data.revision} noun="实体" action={action} retainedAudit />
        </>
      )}
    </aside>
  );
}
export function MemoryEntities({ onReadSummary }: { onReadSummary: (value: string) => void }) {
  const read = useMemoryRead<EntityMemoryOwnerBrowse>('/api/memory/entities', isEntityBrowse);
  const [selected, select] = useState<string | null>(null);
  const entries = read.data?.entries ?? [];
  const current = entries.find((entry) => entry.id === selected);
  useEffect(() => {
    onReadSummary(read.loading ? '正在读取' : read.error ? '暂时读不到' : `${read.data?.entries.length ?? 0} 条`);
  }, [read.data, read.error, read.loading, onReadSummary]);
  return (
    <section className="space-y-4" aria-label="实体记忆">
      <header>
        <h1 className="text-display-sm">实体</h1>
        <p className="mt-2 text-compact text-cafe-muted">我们明确记住的名字、概念和别名。</p>
      </header>
      <MemoryReadState
        loading={read.loading}
        error={read.error}
        empty={!entries.length}
        noun="实体"
        retry={read.retry}
      />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className={`space-y-3 ${current ? 'hidden lg:block' : ''}`}>
          {entries.map((entry) => (
            <article key={entry.id} className="rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-4">
              <button
                type="button"
                className="text-left text-base font-medium"
                aria-pressed={current?.id === entry.id}
                onClick={() => select(entry.id)}
              >
                {entry.canonicalName}
              </button>
              <p className="mt-2 text-compact text-cafe-muted">
                {entry.status === 'retired' ? '已不再使用' : '当前记录'}
                {entry.aliases.length ? ` · ${entry.aliases.join('、')}` : ''}
              </p>
            </article>
          ))}
        </div>
        {current && (
          <EntityDetail
            key={`${current.id}:${current.revision}`}
            entry={current}
            close={() => select(null)}
            reload={() => {
              select(null);
              read.retry();
            }}
          />
        )}
      </div>
    </section>
  );
}
