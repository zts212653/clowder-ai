import { readProfileOpeningReference, splitProfileBody } from '@cat-cafe/shared/profile-opening-reference';
import { useEffect, useState } from 'react';
import { MemoryCapsuleCard, MemoryCapsuleDetail } from './MemoryCapsule';
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
  const [selected, select] = useState<string | null>(target?.id ?? null);
  const [followingSource, followSource] = useState(!!target);
  const entries = read.data?.entries ?? [];
  const current = entries.find((entry) => entry.id === selected);
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
      <header>
        <h1 className="text-display-sm">画像</h1>
        <p className="mt-2 text-compact text-cafe-muted">关于你和我们相处方式的共同画像与关系画像。</p>
      </header>
      <MemoryReadState loading={read.loading} error={read.error} empty={false} noun="画像" retry={read.retry} />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className={`space-y-3 ${current || selected === 'capsule' ? 'hidden lg:block' : ''}`}>
          {!read.loading && !read.error && (
            <MemoryCapsuleCard
              entry={entries.find((entry) => entry.id === 'capsule')}
              setup={read.data?.capsuleSetup}
              selected={selected === 'capsule'}
              select={() => {
                followSource(false);
                select('capsule');
              }}
            />
          )}
          {entries
            .filter((entry) => entry.id !== 'capsule')
            .map((entry) => (
              <article key={entry.id} className="rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-4">
                <button
                  type="button"
                  className="text-left text-base font-medium"
                  aria-pressed={current?.id === entry.id}
                  onClick={() => {
                    followSource(false);
                    select(entry.id);
                  }}
                >
                  {entry.title}
                </button>
                {entry.layer === 'primer' && readProfileOpeningReference(entry.content) && (
                  <p className="mt-2 text-xs text-cafe-muted">含新对话开场参考</p>
                )}
                <p className="mt-2 line-clamp-3 break-words text-compact text-cafe-muted">
                  {splitProfileBody(entry.content).body}
                </p>
              </article>
            ))}
        </div>
        {selected === 'capsule' && (
          <MemoryCapsuleDetail
            entry={current}
            close={() => {
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
            close={() => {
              followSource(false);
              select(null);
            }}
            reload={() => {
              followSource(false);
              select(null);
              read.retry();
            }}
          />
        )}
      </div>
    </section>
  );
}
