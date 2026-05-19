'use client';

import type { BacklogItem, CatId } from '@cat-cafe/shared';
import Link from 'next/link';
import { extractFeatureId } from './FeatureBirdEyePanel';

interface ThreadSituationSummary {
  id: string;
  title?: string;
  lastActiveAt: number;
  participants: CatId[];
  backlogItemId?: string;
}

interface ThreadSituationPanelProps {
  dispatchedItems: BacklogItem[];
  loading: boolean;
  threadsByBacklogId: Record<string, ThreadSituationSummary>;
  /** Fallback: threads matched by feature ID in title */
  threadsByFeatureId?: Record<string, ThreadSituationSummary[]>;
}

function formatLastActive(lastActiveAt: number): string {
  const delta = Date.now() - lastActiveAt;
  if (delta < 60_000) return `${Math.max(1, Math.floor(delta / 1_000))} 秒前`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

export function ThreadSituationPanel({
  dispatchedItems,
  loading,
  threadsByBacklogId,
  threadsByFeatureId = {},
}: ThreadSituationPanelProps) {
  return (
    <section className="min-h-0 rounded-2xl border border-[#E7DAC7] bg-[#FFFDF8] p-3" data-testid="mc-thread-situation">
      <div className="mb-2">
        <h2 className="text-sm font-semibold text-[#2C2118]">线程态势</h2>
        <p className="text-xs text-[#7B6956]">Dispatched 项的执行面状态一览</p>
      </div>

      {dispatchedItems.length === 0 && (
        <p className="rounded-lg border border-dashed border-[#DDCCB5] px-2 py-2 text-xs text-[#8B7864]">
          暂无执行中的 backlog 项
        </p>
      )}

      {dispatchedItems.length > 0 && loading && (
        <p className="rounded-lg border border-dashed border-[#DDCCB5] px-2 py-2 text-xs text-[#8B7864]">
          加载线程态势中...
        </p>
      )}

      <div className="space-y-2">
        {dispatchedItems.map((item) => {
          const thread = threadsByBacklogId[item.id];
          // Fallback: match by feature ID in thread title
          const featureId = extractFeatureId(item.tags);
          const titleMatchedThreads = featureId !== 'Untagged' ? (threadsByFeatureId[featureId] ?? []) : [];

          if (!thread && titleMatchedThreads.length === 0) {
            return (
              <article
                key={item.id}
                className="rounded-xl border border-dashed border-[#DDCCB5] bg-[#FEFCF7] px-2.5 py-1.5"
                data-testid={`mc-thread-situation-item-${item.id}`}
              >
                <p className="text-xs text-[#8B7864]">
                  <span className="font-medium text-[#4B3A2A]">{item.title}</span>
                  {' — '}暂无关联 thread
                </p>
              </article>
            );
          }

          // Direct backlogItemId match takes priority
          const displayThreads = thread ? [thread] : titleMatchedThreads;
          const matchType = thread ? 'direct' : 'title';

          return (
            <article
              key={item.id}
              className="rounded-xl border border-[#EADFCF] bg-[#FFF9F0] px-2.5 py-2"
              data-testid={`mc-thread-situation-item-${item.id}`}
            >
              <p className="text-xs font-semibold text-[#4B3A2A]">{item.title}</p>
              {matchType === 'title' && <p className="text-[10px] text-[#9A866F]">通过标题匹配</p>}
              {displayThreads.map((t) => (
                <div key={t.id} className="mt-1 border-t border-[#F0E8DA] pt-1 first:mt-0 first:border-t-0 first:pt-0">
                  <p className="text-xs text-[#6E5A46]">Thread：{t.title || t.id}</p>
                  <p className="text-xs text-[#6E5A46]">
                    最近活跃：
                    <span
                      title={new Date(t.lastActiveAt).toLocaleString('zh-CN', {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    >
                      {formatLastActive(t.lastActiveAt)}
                    </span>
                  </p>
                  <p className="text-xs text-[#6E5A46]">
                    参与猫：{t.participants.length > 0 ? t.participants.join(', ') : '暂无'}
                  </p>
                  <Link
                    href={`/thread/${t.id}`}
                    className="mt-1 inline-flex text-xs font-medium text-[#245EA8] underline-offset-2 hover:underline"
                    data-testid={`mc-thread-situation-link-${item.id}-${t.id}`}
                  >
                    打开 thread
                  </Link>
                </div>
              ))}
            </article>
          );
        })}
      </div>
    </section>
  );
}
