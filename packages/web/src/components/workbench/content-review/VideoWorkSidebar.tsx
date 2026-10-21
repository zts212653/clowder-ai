'use client';
import type { WorkContextRecord, WorkVideoContext } from '@cat-cafe/shared';
import { useState } from 'react';
import { VideoWorkMaterials } from './VideoWorkMaterials';
import { VideoWorkSource } from './VideoWorkSource';
import { type StoryClock, VideoWorkStory } from './VideoWorkStory';

type Story = WorkVideoContext['story'][number];

export function VideoWorkSidebar({
  record,
  loading,
  error,
  onSeek,
  onAnnotate,
  assetUrl,
  clock,
  currentTick,
}: {
  record: WorkContextRecord | null;
  clock?: StoryClock;
  currentTick?: number;
  loading: boolean;
  error: string | null;
  onSeek: (story: Story, metadataRevision: number) => void;
  onAnnotate?: (story: Story, metadataRevision: number) => void;
  assetUrl?: (assetId: string, metadataRevision: number) => string;
}) {
  const [tab, setTab] = useState('story');
  return (
    <aside
      data-video-work-sidebar
      className="w-56 shrink-0 overflow-y-auto border-r border-cafe-subtle p-3"
      aria-label="视频故事线和素材"
    >
      <select
        aria-label="故事线或素材"
        value={tab}
        onChange={(event) => setTab(event.target.value)}
        className="mb-3 w-full rounded-md border border-cafe-subtle bg-cafe-surface px-2 py-1 text-sm"
      >
        <option value="story">故事线</option>
        <option value="assets">素材</option>
      </select>
      {!loading && !error ? <VideoWorkSource binding={record?.context.sourceBinding} /> : null}
      {loading ? <output className="text-xs text-cafe-muted">正在读取这版索引…</output> : null}
      {error ? (
        <p role="alert" className="text-xs text-cafe-error">
          {error}
        </p>
      ) : !loading ? (
        tab === 'story' ? (
          <VideoWorkStory
            record={record}
            clock={clock}
            currentTick={currentTick}
            onSeek={onSeek}
            onAnnotate={onAnnotate}
          />
        ) : (
          <VideoWorkMaterials
            key={`${record?.reference.contentRef}:${record?.reference.ownerRevision}:${record?.metadataRevision}`}
            record={record}
            assetUrl={assetUrl}
          />
        )
      ) : null}
    </aside>
  );
}
