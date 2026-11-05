import { useEffect, useState } from 'react';
import { MemoryCapsuleCard, MemoryCapsuleDetail } from './MemoryCapsule';
import { MemoryProfileCard } from './MemoryProfileCard';
import { ProfileDetail } from './MemoryProfileDetail';
import { MemoryReadState } from './MemoryReadState';
import { isProfileBrowse, type ProfileMemoryBrowseRead } from './owner-memory-read';
import { useMemoryRead } from './use-memory-read';

export function MemoryProfile({
  onReadSummary,
  target,
}: {
  onReadSummary: (value: string) => void;
  target?: { id: string; revision: string };
}) {
  const read = useMemoryRead<ProfileMemoryBrowseRead>('/api/memory/profile', isProfileBrowse);
  const [selected, select] = useState<string | null>(target?.id ?? 'capsule');
  const [followingSource, followSource] = useState(!!target);
  const [dirty, setDirty] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<{ id: string | null } | null>(null);
  const choose = (id: string | null) => {
    if (id === selected) return;
    if (dirty) {
      setPendingSelection({ id });
      return;
    }
    followSource(false);
    select(id);
  };
  const entries = read.data?.entries ?? [];
  const current = entries.find((entry) => entry.id === selected);
  useEffect(() => {
    if (!followingSource && !read.loading && !read.error && selected && selected !== 'capsule' && !current)
      select('capsule');
  }, [followingSource, read.loading, read.error, selected, current]);
  useEffect(() => {
    onReadSummary(read.loading ? '正在读取' : read.error ? '暂时读不到' : `${read.data?.entries.length ?? 0} 条`);
  }, [read.data, read.error, read.loading, onReadSummary]);
  if (followingSource && !read.loading && !read.error && (!current || current.revision !== target?.revision)) {
    return (
      <section aria-label="画像来源" className="space-y-3">
        <h1 className="text-display-sm">画像</h1>
        <output className="block text-sm text-cafe-muted">
          {current ? '来源版本已变化，不能把当前正文当作当时递送的内容。' : '这条来源暂时读不到，可能已被遗忘。'}
        </output>
        <button
          type="button"
          className="text-compact text-cafe-accent underline"
          onClick={() => {
            followSource(false);
            select(null);
          }}
        >
          查看画像列表
        </button>
      </section>
    );
  }
  return (
    <section className="space-y-4" aria-label="画像记忆">
      <h1 className="sr-only">画像</h1>
      {pendingSelection && (
        <div
          role="alertdialog"
          aria-label="还有未保存的修改"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-cafe-subtle bg-cafe-surface-sunken p-4 text-sm"
        >
          <p>修改还没保存。</p>
          <button type="button" className="shell-focusable underline" onClick={() => setPendingSelection(null)}>
            继续编辑
          </button>
          <button
            type="button"
            className="shell-focusable text-cafe-accent underline"
            onClick={() => {
              setDirty(false);
              followSource(false);
              select(pendingSelection.id);
              setPendingSelection(null);
            }}
          >
            放弃并切换
          </button>
        </div>
      )}
      <MemoryReadState loading={read.loading} error={read.error} empty={false} noun="画像" retry={read.retry} />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,0.38fr)_minmax(0,0.62fr)]">
        <div className={`space-y-3 ${current || selected === 'capsule' ? 'hidden lg:block' : ''}`}>
          {!read.loading && !read.error && (
            <MemoryCapsuleCard
              entry={entries.find((entry) => entry.id === 'capsule')}
              setup={read.data?.capsuleSetup}
              selected={selected === 'capsule'}
              select={() => choose('capsule')}
            />
          )}
          {entries
            .filter((entry) => entry.layer === 'corpus')
            .map((entry) => (
              <MemoryProfileCard
                key={entry.id}
                entry={entry}
                selected={selected === entry.id}
                select={() => choose(entry.id)}
              />
            ))}
          {entries.some((entry) => entry.layer === 'primer') && (
            <h2 className="pt-1 text-xs text-cafe-muted">
              与各只猫的关系画像 · {entries.filter((entry) => entry.layer === 'primer').length} 份
            </h2>
          )}
          {entries
            .filter((entry) => entry.layer === 'primer')
            .map((entry) => (
              <MemoryProfileCard
                key={entry.id}
                entry={entry}
                selected={selected === entry.id}
                select={() => choose(entry.id)}
              />
            ))}
        </div>
        {selected === 'capsule' && !read.error && (
          <MemoryCapsuleDetail
            entry={current}
            onDirtyChange={setDirty}
            close={() => {
              setDirty(false);
              followSource(false);
              select(null);
            }}
            reload={read.retry}
          />
        )}
        {current && current.id !== 'capsule' && (
          <ProfileDetail
            key={`${current.id}:${current.revision}`}
            entry={current}
            onDirtyChange={setDirty}
            close={() => choose(null)}
            reload={() => {
              setDirty(false);
              followSource(false);
              read.retry();
            }}
          />
        )}
      </div>
    </section>
  );
}
