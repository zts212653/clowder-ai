'use client';

import { useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import { apiFetch } from '@/utils/api-client';
import styles from './CatHomePanel.module.css';
import type { DiaryDetailResponse, DiaryEngagementView, DiaryPageView } from './types';

interface CatDiaryShelfProps {
  catName: string;
  diaries: DiaryPageView[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

function newClientEventId(kind: 'open' | 'reaction', diaryId: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${kind}:${diaryId}:${random}`;
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) throw new Error(`${fallback} (${response.status})`);
  return (await response.json()) as T;
}

export function CatDiaryShelf({ catName, diaries, loading, error, onRetry }: CatDiaryShelfProps) {
  const [detail, setDetail] = useState<DiaryDetailResponse | null>(null);
  const [engagements, setEngagements] = useState<Record<string, DiaryEngagementView>>({});
  const [busyDiaryId, setBusyDiaryId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function recordEngagement(
    diaryId: string,
    payload: { kind: 'open'; clientEventId: string } | { kind: 'reaction'; clientEventId: string; active: boolean },
  ): Promise<DiaryEngagementView | null> {
    const response = await apiFetch(`/api/auto-dream/diaries/${encodeURIComponent(diaryId)}/engagement`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { state: DiaryEngagementView };
    setEngagements((current) => ({ ...current, [diaryId]: data.state }));
    return data.state;
  }

  async function openDiary(diaryId: string): Promise<void> {
    if (detail?.diary.diaryId === diaryId) {
      setDetail(null);
      return;
    }
    setBusyDiaryId(diaryId);
    setActionError(null);
    try {
      const response = await apiFetch(`/api/auto-dream/diaries/${encodeURIComponent(diaryId)}`);
      const nextDetail = await readJson<DiaryDetailResponse>(response, '日记暂时翻不开');
      setDetail(nextDetail);
      const next = await recordEngagement(diaryId, {
        kind: 'open',
        clientEventId: newClientEventId('open', diaryId),
      });
      if (!next) setActionError('日记已经打开，但这次翻阅没有记进回响。');
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : '日记暂时翻不开');
    } finally {
      setBusyDiaryId(null);
    }
  }

  async function toggleReaction(diary: DiaryPageView): Promise<void> {
    const current = engagements[diary.diaryId] ?? diary.engagement;
    const active = !current.reacted;
    setBusyDiaryId(diary.diaryId);
    setActionError(null);
    try {
      const next = await recordEngagement(diary.diaryId, {
        kind: 'reaction',
        clientEventId: newClientEventId('reaction', diary.diaryId),
        active,
      });
      if (!next) throw new Error('回响没有送到，请再试一次');
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : '回响没有送到');
    } finally {
      setBusyDiaryId(null);
    }
  }

  if (loading) return <div className={styles.empty}>正在从书架上找 {catName} 的日记…</div>;
  if (error) {
    return (
      <div className={styles.stack}>
        <div className={styles.error}>{error}</div>
        <button type="button" className={styles.buttonSecondary} onClick={onRetry}>
          再找一次
        </button>
      </div>
    );
  }
  if (diaries.length === 0) {
    return (
      <div className={styles.empty}>
        <strong>书架还是空的。</strong>
        <br />
        这不代表 {catName} 没有生活；只有它愿意写下并留下来的页，才会出现在这里。
      </div>
    );
  }

  return (
    <div className={styles.stack}>
      <p className={styles.hint}>卡片只露出标题和一小口摘要。点开以后，才是猫完整留下的那一页。</p>
      {actionError && <div className={styles.error}>{actionError}</div>}
      {diaries.map((diary) => {
        const isOpen = detail?.diary.diaryId === diary.diaryId;
        const engagement = engagements[diary.diaryId] ?? diary.engagement;
        const isBusy = busyDiaryId === diary.diaryId;
        return (
          <article className={styles.diaryCard} key={diary.diaryId}>
            <span className={styles.diaryDate}>{diary.localDate}</span>
            <h3 className={styles.diaryTitle}>{diary.headline}</h3>
            <p className={styles.summary}>{diary.summary}</p>
            {isOpen && detail && (
              <>
                <div className={styles.diaryBody}>
                  <MarkdownContent content={detail.diary.bodyMarkdown} disableCommandPrefix />
                </div>
                <p className={styles.notice}>{detail.historicalNotice}</p>
              </>
            )}
            <div className={styles.cardActions}>
              {isOpen && engagement.opened && (
                <button
                  type="button"
                  className={styles.buttonSecondary}
                  disabled={isBusy}
                  aria-pressed={engagement.reacted}
                  onClick={() => void toggleReaction(diary)}
                >
                  {engagement.reacted ? `🐾 已经告诉${catName}` : '🐾 这页我喜欢'}
                </button>
              )}
              <button
                type="button"
                className={styles.button}
                disabled={isBusy}
                onClick={() => void openDiary(diary.diaryId)}
              >
                {isBusy ? '翻页中…' : isOpen ? '收起' : '读全文'}
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
