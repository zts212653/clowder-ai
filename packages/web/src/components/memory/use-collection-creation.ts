import { useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export interface CollectionDraft {
  kind: string;
  name: string;
  displayName: string;
  root: string;
  sensitivity: string;
}
interface DryRunResult {
  totalFiles: number;
  markdownFiles: number;
  secretFindings: number;
  safe: boolean;
}
function isDryRun(value: unknown): value is DryRunResult {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    ['totalFiles', 'markdownFiles', 'secretFindings'].every(
      (key) => typeof row[key] === 'number' && Number.isSafeInteger(row[key]) && row[key] >= 0,
    ) && typeof row.safe === 'boolean'
  );
}
async function registerDraft(draft: CollectionDraft, id: string): Promise<string | null> {
  const res = await apiFetch('/api/library/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      kind: draft.kind,
      name: draft.name,
      displayName: draft.displayName.trim(),
      sensitivity: draft.sensitivity,
      ...(draft.root.trim() && { root: draft.root.trim() }),
    }),
  });
  if (!res.ok) {
    if (res.status === 409) return '这个资料库名称已被使用，请换一个名称。';
    if (res.status === 403) return '暂不能创建资料库，请在主人本机打开后再试。';
    return '暂时没有创建成功。请重读资料库列表后再试。';
  }
  const result: unknown = await res.json();
  if (!result || typeof result !== 'object' || !('manifest' in result)) throw new Error('Invalid register result');
  const manifest = result.manifest;
  if (!manifest || typeof manifest !== 'object' || !('id' in manifest) || manifest.id !== id)
    throw new Error('Invalid collection');
  return null;
}
async function rebuildCollection(id: string) {
  const res = await apiFetch(`/api/library/${encodeURIComponent(id)}/rebuild`, { method: 'POST' });
  if (!res.ok) throw new Error('Rebuild unavailable');
  const result: unknown = await res.json();
  if (!result || typeof result !== 'object' || !('blocked' in result) || result.blocked !== false)
    throw new Error('Rebuild unavailable');
}
export function useCollectionCreation(onCreated: () => void) {
  const [draft, setDraft] = useState<CollectionDraft>({
    kind: 'domain',
    name: '',
    displayName: '',
    root: '',
    sensitivity: 'private',
  });
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  function update(key: keyof CollectionDraft, value: string) {
    if (inFlight.current || registered) return;
    setDraft((current) => ({ ...current, [key]: value }));
    setError(null);
    if (key === 'root') setDryRun(null);
  }
  async function scan() {
    if (inFlight.current || !draft.root.trim()) return;
    inFlight.current = true;
    setScanning(true);
    setError(null);
    setDryRun(null);
    try {
      const res = await apiFetch('/api/library/bind-dry-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: draft.root.trim() }),
      });
      const result: unknown = await res.json();
      if (!res.ok || !isDryRun(result)) throw new Error('Scan unavailable');
      setDryRun(result);
    } catch {
      setError('暂时读不到预扫描结果。请检查目录后重试。');
    } finally {
      inFlight.current = false;
      setScanning(false);
    }
  }
  async function submit() {
    if (inFlight.current || !draft.name || !draft.displayName.trim() || (draft.root.trim() && !dryRun)) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    let created = registered;
    try {
      const id = `${draft.kind}:${draft.name}`;
      if (!created) {
        const failure = await registerDraft(draft, id);
        if (failure) {
          setError(failure);
          return;
        }
        created = true;
        setRegistered(true);
      }
      await rebuildCollection(id);
      onCreated();
    } catch {
      setError(
        created
          ? '资料库已建好，索引暂时没有建好。可以重试索引，或先关闭。'
          : '没有确认创建成功。请重读资料库列表后再试。',
      );
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }
  return { draft, update, dryRun, scanning, submitting, registered, error, scan, submit };
}
