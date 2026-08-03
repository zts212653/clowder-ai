'use client';

import type { CatLifeSettingsInput } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import styles from './CatHomePanel.module.css';
import { CatLifeSettingsForm } from './CatLifeSettingsForm';
import type { CatLifeConfigView, CatLifePreviewView, CatLifeSettingsResponse } from './types';

interface CatLifeSettingsPanelProps {
  catId: string;
  catName: string;
  data: CatLifeSettingsResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onConfigChanged: (config: CatLifeConfigView) => void;
}

function browserTimezone(fallback: string): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || fallback;
}

function initialDraft(data: CatLifeSettingsResponse): CatLifeSettingsInput {
  if (data.config) {
    return {
      enabled: data.config.enabled,
      rhythm: data.config.rhythm,
      wakeTime: data.config.wakeTime,
      timezone: data.config.timezone,
      ...(data.config.quietHours ? { quietHours: data.config.quietHours } : {}),
    };
  }
  return { ...data.defaults, timezone: browserTimezone(data.defaults.timezone) };
}

function nextWakeLabel(value: number | null): string {
  return value === null ? '已暂停，不会唤醒' : new Date(value).toLocaleString();
}

function CatLifeStatusCard({ config }: { config: CatLifeConfigView }) {
  if (config.projectionStatus === 'error') {
    return (
      <div className={styles.error}>
        <strong>私人时间暂时没有接上</strong>
        <br />
        作息已经保存，但唤醒尚未生效。系统会继续尝试；你也可以调整后重新确认。
      </div>
    );
  }
  if (config.projectionStatus === 'pending') {
    return (
      <div className={styles.statusCard}>
        <strong>私人时间正在安顿</strong>
        <br />
        作息已经保存，等唤醒接好后才会显示为开启。
      </div>
    );
  }
  return (
    <div className={styles.statusCard}>
      <strong>{config.enabled ? '私人时间已开启' : '私人时间正在暂停'}</strong>
      <br />
      下次预计：{nextWakeLabel(config.nextWakeAt)}
    </div>
  );
}

export function CatLifeSettingsPanel({
  catId,
  catName,
  data,
  loading,
  error,
  onRetry,
  onConfigChanged,
}: CatLifeSettingsPanelProps) {
  const [draft, setDraft] = useState<CatLifeSettingsInput | null>(data ? initialDraft(data) : null);
  const [preview, setPreview] = useState<CatLifePreviewView | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!data) return;
    setDraft(initialDraft(data));
    setPreview(null);
  }, [data]);

  function update(next: CatLifeSettingsInput): void {
    setDraft(next);
    setPreview(null);
    setSaved(false);
  }

  async function createPreview(): Promise<void> {
    if (!draft) return;
    setBusy(true);
    setActionError(null);
    try {
      const response = await apiFetch(`/api/auto-dream/cats/${encodeURIComponent(catId)}/life-settings/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: draft }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `预览失败 (${response.status})`);
      }
      setPreview((await response.json()) as CatLifePreviewView);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : '这份生活暂时预览不了');
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: 'confirm' | 'cancel'): Promise<void> {
    if (!preview) return;
    setBusy(true);
    setActionError(null);
    try {
      const response = await apiFetch('/api/auto-dream/life-settings/decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ previewId: preview.previewId, decision }),
      });
      if (!response.ok) throw new Error(`确认失败 (${response.status})`);
      const result = (await response.json()) as { config: CatLifeConfigView | null };
      if (decision === 'confirm' && result.config) {
        onConfigChanged(result.config);
        setSaved(true);
      }
      setPreview(null);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : '这次确认没有生效');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className={styles.empty}>正在看看 {catName} 平时怎么生活…</div>;
  if (error) {
    return (
      <div className={styles.stack}>
        <div className={styles.error}>{error}</div>
        <button type="button" className={styles.buttonSecondary} onClick={onRetry}>
          再试一次
        </button>
      </div>
    );
  }
  if (!draft) return <div className={styles.empty}>生活设置暂时没有取回来。</div>;

  return (
    <div className={styles.stack}>
      {data?.config ? (
        <CatLifeStatusCard config={data.config} />
      ) : (
        <p className={styles.hint}>这里还没有配置。只是打开房间不会创建闹钟；你确认预览后，生活才会开始。</p>
      )}

      <CatLifeSettingsForm draft={draft} onChange={update} />

      {actionError && <div className={styles.error}>{actionError}</div>}
      {saved && <div className={styles.success}>这份生活已经安顿好了。</div>}
      {preview ? (
        <div className={styles.previewCard}>
          <strong>确认前，再看一眼</strong>
          <div className={styles.previewFacts}>
            <div className={styles.fact}>
              <strong>下次预计醒来</strong>
              {nextWakeLabel(preview.nextWakeAt)}
            </div>
            <div className={styles.fact}>
              <strong>每周预计</strong>约 {preview.weeklyWakeCount} 次
            </div>
          </div>
          <p className={styles.hint}>{preview.costNotice}</p>
          <div className={styles.actions}>
            <button type="button" className={styles.button} disabled={busy} onClick={() => void decide('confirm')}>
              确认这个作息
            </button>
            <button
              type="button"
              className={styles.buttonSecondary}
              disabled={busy}
              onClick={() => void decide('cancel')}
            >
              先不改变
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className={styles.button} disabled={busy} onClick={() => void createPreview()}>
          {busy ? '正在预览…' : '预览这份生活'}
        </button>
      )}
    </div>
  );
}
