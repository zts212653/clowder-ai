'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { CatDiaryShelf } from './CatDiaryShelf';
import styles from './CatHomePanel.module.css';
import { CatLifeSettingsPanel } from './CatLifeSettingsPanel';
import type { CatLifeConfigView, CatLifeSettingsResponse, DiaryListResponse } from './types';

interface CatHomePanelProps {
  cat: CatData;
  availableCats: CatData[];
  onSelectCat: (catId: string) => void;
  onClose: () => void;
}

async function readJson<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) throw new Error(`${label} (${response.status})`);
  return (await response.json()) as T;
}

export function CatHomePanel({ cat, availableCats, onSelectCat, onClose }: CatHomePanelProps) {
  const [tab, setTab] = useState<'diaries' | 'life'>('diaries');
  const [lifeData, setLifeData] = useState<CatLifeSettingsResponse | null>(null);
  const [diaryData, setDiaryData] = useState<DiaryListResponse | null>(null);
  const [lifeLoading, setLifeLoading] = useState(true);
  const [diaryLoading, setDiaryLoading] = useState(true);
  const [lifeError, setLifeError] = useState<string | null>(null);
  const [diaryError, setDiaryError] = useState<string | null>(null);
  const lifeRequest = useRef(0);
  const diaryRequest = useRef(0);

  const loadLife = useCallback(async () => {
    const requestId = ++lifeRequest.current;
    setLifeLoading(true);
    setLifeError(null);
    try {
      const response = await apiFetch(`/api/auto-dream/cats/${encodeURIComponent(cat.id)}/life-settings`);
      const next = await readJson<CatLifeSettingsResponse>(response, '生活设置没有取回来');
      if (requestId === lifeRequest.current) setLifeData(next);
    } catch (caught) {
      if (requestId === lifeRequest.current) {
        setLifeError(caught instanceof Error ? caught.message : '生活设置没有取回来');
      }
    } finally {
      if (requestId === lifeRequest.current) setLifeLoading(false);
    }
  }, [cat.id]);

  const loadDiaries = useCallback(async () => {
    const requestId = ++diaryRequest.current;
    setDiaryLoading(true);
    setDiaryError(null);
    try {
      const response = await apiFetch(`/api/auto-dream/diaries?catId=${encodeURIComponent(cat.id)}&limit=20`);
      const next = await readJson<DiaryListResponse>(response, '日记架没有取回来');
      if (requestId === diaryRequest.current) setDiaryData(next);
    } catch (caught) {
      if (requestId === diaryRequest.current) {
        setDiaryError(caught instanceof Error ? caught.message : '日记架没有取回来');
      }
    } finally {
      if (requestId === diaryRequest.current) setDiaryLoading(false);
    }
  }, [cat.id]);

  useEffect(() => {
    setLifeData(null);
    setDiaryData(null);
    void loadLife();
    void loadDiaries();
  }, [loadLife, loadDiaries]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  function applyConfig(config: CatLifeConfigView): void {
    setLifeData((current) =>
      current
        ? {
            ...current,
            config,
          }
        : current,
    );
  }

  return (
    <div className={styles.backdrop}>
      <button type="button" className={styles.backdropClose} aria-label="关上房门" onClick={onClose} />
      <aside className={styles.panel} role="dialog" aria-modal="true" aria-label={`${cat.displayName}的房间`}>
        <header className={styles.header}>
          {cat.avatar ? (
            <Image className={styles.avatar} src={cat.avatar} width={44} height={44} unoptimized alt="" />
          ) : (
            <div className={styles.avatar} />
          )}
          <div className={styles.titleGroup}>
            <h1 className={styles.title}>{cat.displayName}的房间</h1>
            <p className={styles.subtitle}>生活不是任务，日记也不是日报。</p>
            {availableCats.length > 1 && (
              <select
                className={styles.catSelect}
                aria-label="换一只猫的房间"
                value={cat.id}
                onChange={(event) => onSelectCat(event.target.value)}
              >
                {availableCats.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.displayName}
                  </option>
                ))}
              </select>
            )}
          </div>
          <button type="button" className={styles.closeButton} aria-label="关上房门" onClick={onClose}>
            ×
          </button>
        </header>

        <nav className={styles.tabs} aria-label="猫的房间">
          <button
            type="button"
            className={`${styles.tab} ${tab === 'diaries' ? styles.tabActive : ''}`}
            aria-pressed={tab === 'diaries'}
            onClick={() => setTab('diaries')}
          >
            📖 日记架
          </button>
          <button
            type="button"
            className={`${styles.tab} ${tab === 'life' ? styles.tabActive : ''}`}
            aria-pressed={tab === 'life'}
            onClick={() => setTab('life')}
          >
            🌙 生活与作息
          </button>
        </nav>

        <div className={styles.content}>
          {tab === 'diaries' ? (
            <CatDiaryShelf
              key={cat.id}
              catName={cat.displayName}
              diaries={diaryData?.diaries ?? []}
              loading={diaryLoading}
              error={diaryError}
              onRetry={() => void loadDiaries()}
            />
          ) : (
            <CatLifeSettingsPanel
              key={cat.id}
              catId={cat.id}
              catName={cat.displayName}
              data={lifeData}
              loading={lifeLoading}
              error={lifeError}
              onRetry={() => void loadLife()}
              onConfigChanged={applyConfig}
            />
          )}
        </div>
      </aside>
    </div>
  );
}
