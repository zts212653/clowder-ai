'use client';

import { isCompletePawFeelDutyConfig, type PawFeelDutyConfig } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { type AvailableDutyCat, PawFeelDutySelect } from './PawFeelDutySelect';

function isDutyConfig(value: unknown): value is PawFeelDutyConfig {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PawFeelDutyConfig>;
  return (
    candidate.systemThreadId === 'thread_eval_friction' &&
    typeof candidate.version === 'number' &&
    typeof candidate.updatedAt === 'string' &&
    typeof candidate.updatedBy === 'string'
  );
}

function readError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const candidate = payload as { error?: unknown; detail?: unknown };
  if (typeof candidate.detail === 'string') return candidate.detail;
  if (typeof candidate.error === 'string') return candidate.error;
  return fallback;
}

export function PawFeelDutyEditor() {
  const [config, setConfig] = useState<PawFeelDutyConfig | null>(null);
  const [cats, setCats] = useState<AvailableDutyCat[]>([]);
  const [primaryCatId, setPrimaryCatId] = useState('');
  const [backupCatId, setBackupCatId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const dutyResponse = await apiFetch('/api/paw-feel/duty');
      if (!dutyResponse.ok) throw new Error(`值班配置请求失败 (${dutyResponse.status})`);
      const dutyPayload: unknown = await dutyResponse.json();
      if (!dutyPayload || typeof dutyPayload !== 'object' || !('config' in dutyPayload)) {
        throw new Error('值班配置返回了无效数据');
      }
      const nextConfig = (dutyPayload as { config: unknown }).config;
      if (nextConfig !== null && !isDutyConfig(nextConfig)) throw new Error('值班配置返回了无效数据');
      setConfig(nextConfig);
      setPrimaryCatId(nextConfig?.primaryCatId ?? '');
      setBackupCatId(nextConfig?.backupCatId ?? '');

      try {
        const catsResponse = await apiFetch('/api/eval-hub/available-cats');
        if (catsResponse.ok) {
          const catsPayload: unknown = await catsResponse.json();
          if (
            catsPayload &&
            typeof catsPayload === 'object' &&
            Array.isArray((catsPayload as { cats?: unknown }).cats)
          ) {
            setCats((catsPayload as { cats: AvailableDutyCat[] }).cats);
          }
        }
      } catch {
        // The durable assignment stays readable while the roster is unavailable.
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (!primaryCatId || !backupCatId) {
      setError('必须同时选择 primary 与 backup 才能启用值班');
      return;
    }
    if (primaryCatId && primaryCatId === backupCatId) {
      setError('primary 与 backup 必须是不同的猫');
      return;
    }

    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const response = await apiFetch('/api/paw-feel/duty', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: config?.version ?? 0,
          primaryCatId,
          backupCatId,
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(readError(payload, `值班配置保存失败 (${response.status})`));
      const nextConfig =
        payload && typeof payload === 'object' && 'config' in payload ? (payload as { config: unknown }).config : null;
      if (!isDutyConfig(nextConfig)) throw new Error('值班配置返回了无效数据');
      setConfig(nextConfig);
      setPrimaryCatId(nextConfig.primaryCatId ?? '');
      setBackupCatId(nextConfig.backupCatId ?? '');
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }, [backupCatId, config?.version, primaryCatId]);

  return (
    <section className="rounded-lg border border-cafe bg-cafe-surface p-3" aria-label="爪感差值班设置">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-cafe">责任值班</h3>
          <p className="mt-1 text-xs text-cafe-secondary">
            稳定责任线程：
            <a href="/thread/thread_eval_friction" className="font-mono hover:underline">
              thread_eval_friction
            </a>
            。Primary 持续负责；Backup 仅在显式交接后接班，72h 未处置向 operator 亮红灯。
          </p>
        </div>
        {config ? <span className="text-micro text-cafe-muted">版本 {config.version}</span> : null}
      </div>

      {loading ? <p className="mt-3 text-xs text-cafe-muted">读取值班配置…</p> : null}
      {!loading && !config ? (
        <p className="mt-3 rounded-md bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text" role="status">
          尚未指定责任猫；系统线程仍会收到红色无主提醒，但不会猜测负责人。
        </p>
      ) : null}
      {!loading && config && !isCompletePawFeelDutyConfig(config) ? (
        <p className="mt-3 rounded-md bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text" role="status">
          值班配置不完整；必须同时指定不同的 primary / backup，当前不会进入运营闭环。
        </p>
      ) : null}

      {!loading ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <PawFeelDutySelect
            label="Primary"
            value={primaryCatId}
            cats={cats}
            onChange={setPrimaryCatId}
            excludedCatId={backupCatId}
          />
          <PawFeelDutySelect
            label="Backup"
            value={backupCatId}
            cats={cats}
            onChange={setBackupCatId}
            excludedCatId={primaryCatId}
          />
        </div>
      ) : null}

      {error ? (
        <p className="mt-3 rounded-md bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? <p className="mt-3 text-xs text-conn-green-text">值班配置已写入持久台账。</p> : null}

      {!loading ? (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="console-button-primary px-3 py-1.5 text-xs disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存值班'}
          </button>
          <button
            type="button"
            onClick={() => void load()}
            disabled={saving}
            className="console-button-secondary px-3 py-1.5 text-xs disabled:opacity-50"
          >
            重新读取
          </button>
        </div>
      ) : null}
    </section>
  );
}
