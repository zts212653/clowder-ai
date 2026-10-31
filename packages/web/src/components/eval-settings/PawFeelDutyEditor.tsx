'use client';

import { isCompletePawFeelDutyConfig, type PawFeelDutyConfig } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { usePawFeelCopy } from '../paw-feel/paw-feel.shell-copy';
import {
  PawFeelLocalError,
  type PawFeelUiError,
  pawFeelUiError,
  pawFeelUiErrorText,
} from '../paw-feel/paw-feel-ui-error';
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

function readError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload as { error?: unknown; detail?: unknown };
  if (typeof candidate.detail === 'string') return candidate.detail;
  if (typeof candidate.error === 'string') return candidate.error;
  return null;
}

export function PawFeelDutyEditor() {
  const t = usePawFeelCopy();
  const [config, setConfig] = useState<PawFeelDutyConfig | null>(null);
  const [cats, setCats] = useState<AvailableDutyCat[]>([]);
  const [primaryCatId, setPrimaryCatId] = useState('');
  const [backupCatId, setBackupCatId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<PawFeelUiError | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const dutyResponse = await apiFetch('/api/paw-feel/duty');
      if (!dutyResponse.ok) throw new PawFeelLocalError({ kind: 'duty_request_failed', status: dutyResponse.status });
      const dutyPayload: unknown = await dutyResponse.json();
      if (!dutyPayload || typeof dutyPayload !== 'object' || !('config' in dutyPayload)) {
        throw new PawFeelLocalError({ kind: 'invalid_duty' });
      }
      const nextConfig = (dutyPayload as { config: unknown }).config;
      if (nextConfig !== null && !isDutyConfig(nextConfig)) throw new PawFeelLocalError({ kind: 'invalid_duty' });
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
      setError(pawFeelUiError(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (!primaryCatId || !backupCatId) {
      setError({ kind: 'both_required' });
      return;
    }
    if (primaryCatId && primaryCatId === backupCatId) {
      setError({ kind: 'different_required' });
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
      if (!response.ok) {
        const sourceMessage = readError(payload);
        throw sourceMessage
          ? new Error(sourceMessage)
          : new PawFeelLocalError({ kind: 'duty_save_failed', status: response.status });
      }
      const nextConfig =
        payload && typeof payload === 'object' && 'config' in payload ? (payload as { config: unknown }).config : null;
      if (!isDutyConfig(nextConfig)) throw new PawFeelLocalError({ kind: 'invalid_duty' });
      setConfig(nextConfig);
      setPrimaryCatId(nextConfig.primaryCatId ?? '');
      setBackupCatId(nextConfig.backupCatId ?? '');
      setSaved(true);
    } catch (reason) {
      setError(pawFeelUiError(reason));
    } finally {
      setSaving(false);
    }
  }, [backupCatId, config?.version, primaryCatId]);

  return (
    <section className="rounded-lg border border-cafe bg-cafe-surface p-3" aria-label={t.dutySettings}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-cafe">{t.dutyTitle}</h3>
          <p className="mt-1 text-xs text-cafe-secondary">
            {t.stableThread}:
            <a href="/thread/thread_eval_friction" className="font-mono hover:underline">
              thread_eval_friction
            </a>
            {t.dutyHint}
          </p>
        </div>
        {config ? (
          <span className="text-micro text-cafe-muted">
            {t.version} {config.version}
          </span>
        ) : null}
      </div>

      {loading ? <p className="mt-3 text-xs text-cafe-muted">{t.loadingDuty}</p> : null}
      {!loading && !config ? (
        <p className="mt-3 rounded-md bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text" role="status">
          {t.unassignedHint}
        </p>
      ) : null}
      {!loading && config && !isCompletePawFeelDutyConfig(config) ? (
        <p className="mt-3 rounded-md bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text" role="status">
          {t.incompleteHint}
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
          {pawFeelUiErrorText(error, t)}
        </p>
      ) : null}
      {saved ? <p className="mt-3 text-xs text-conn-green-text">{t.saved}</p> : null}

      {!loading ? (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="console-button-primary px-3 py-1.5 text-xs disabled:opacity-50"
          >
            {saving ? t.saving : t.saveDuty}
          </button>
          <button
            type="button"
            onClick={() => void load()}
            disabled={saving}
            className="console-button-secondary px-3 py-1.5 text-xs disabled:opacity-50"
          >
            {t.reload}
          </button>
        </div>
      ) : null}
    </section>
  );
}
