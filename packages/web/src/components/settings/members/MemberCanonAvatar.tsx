'use client';
import type { AssetCanonItem, CharacterAssetBinding, MemberVisualAssets } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { AvatarImageWithFallback } from '@/components/AvatarImageWithFallback';
import { checked, json } from '@/components/content-review/modification-http';
import { uploadAvatarAsset } from '@/components/hub-cat-editor.client';
import { canonActor } from '@/components/workbench/content-review/asset-canon-presentation';
import { useCatData } from '@/hooks/useCatData';
import { API_URL, apiFetch } from '@/utils/api-client';
import { MemberCanonAvatarOption } from './MemberCanonAvatarOption';

interface AvatarData {
  avatar?: string;
  visualAssets: MemberVisualAssets;
  history: CharacterAssetBinding[];
  nextHistoryAfter?: number;
  candidates: { items: AssetCanonItem[]; nextAfter?: number };
}
export function MemberCanonAvatar({
  catId,
  name,
  onLinked,
  initial,
  onCommitted,
}: {
  catId: string;
  name: string;
  onLinked: (linked: boolean) => void;
  initial?: MemberVisualAssets;
  onCommitted?: (value: { avatar?: string; visualAssets: MemberVisualAssets }) => void;
}) {
  const [data, setData] = useState<AvatarData>();
  const [open, setOpen] = useState(false),
    [selected, setSelected] = useState<string>();
  const [showHistory, setShowHistory] = useState(false),
    [uploading, setUploading] = useState(false);
  const [reason, setReason] = useState(''),
    [wantUpload, setWantUpload] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const loadGeneration = useRef(0);
  const operation = useRef<{ key: string; id: string; uploadUrl?: string }>();
  const { refresh } = useCatData({ fetch: false });
  const endpoint = `/api/cats/${encodeURIComponent(catId)}/canon-avatar`;
  const load = async (signal?: AbortSignal) => {
    const generation = ++loadGeneration.current;
    const next = await checked<AvatarData>(await apiFetch(endpoint, { signal }));
    if (generation === loadGeneration.current && !signal?.aborted) {
      setData(next);
      setSelected(next.visualAssets.indexedVersionRef);
      setError('');
      onLinked(next.visualAssets.state !== 'unlinked');
    }
    return next;
  };
  useEffect(() => {
    const abort = new AbortController();
    setData(undefined);
    setError('');
    const request = load(abort.signal);
    const generation = loadGeneration.current;
    void request.catch(() => {
      if (!abort.signal.aborted && generation === loadGeneration.current) setError('头像正典暂时无法读取。');
    });
    return () => abort.abort();
  }, [catId]);
  const save = async (item: AssetCanonItem) => {
    if (!data) {
      setError('请先重新读取当前头像选择。');
      return;
    }
    const body = {
      mode: 'set',
      indexedVersionRef: item.record.indexedVersionRef,
      expectedAssetRevision: item.record.revision,
      expectedBindingRevision: data.visualAssets.bindingRevision,
      reason: `在成员设置中选用 ${item.record.name}`,
    };
    const key = JSON.stringify(body);
    if (operation.current?.key !== key) operation.current = { key, id: crypto.randomUUID() };
    loadGeneration.current++;
    setUploading(true);
    setError('');
    setNotice('');
    try {
      await checked(await apiFetch(endpoint, json({ ...body, operationId: operation.current.id })));
      onCommitted?.(await load());
      await refresh();
      setOpen(false);
      setNotice('头像已单独保存');
    } catch {
      setError('头像未能保存。选择可能已变化，请重新查看后再试。');
    } finally {
      setUploading(false);
    }
  };
  const upload = async (file: File) => {
    if (!data) {
      setError('请先重新读取当前头像选择。');
      return;
    }
    loadGeneration.current++;
    setUploading(true);
    setError('');
    setNotice('');
    const key = JSON.stringify([file.name, file.size, file.lastModified, reason, data.visualAssets.bindingRevision]);
    if (operation.current?.key !== key) operation.current = { key, id: crypto.randomUUID() };
    try {
      const uploadUrl = operation.current.uploadUrl ?? (await uploadAvatarAsset(file));
      operation.current.uploadUrl = uploadUrl;
      await checked(
        await apiFetch(
          `${endpoint}/upload`,
          json({
            uploadUrl,
            reason,
            operationId: operation.current.id,
            expectedBindingRevision: data.visualAssets.bindingRevision,
          }),
        ),
      );
      onCommitted?.(await load());
      await refresh();
      setWantUpload(false);
      setOpen(false);
      setNotice('新头像已记为正典并换上');
    } catch {
      setError('新头像尚未换上。填写的理由仍在，请重试。');
    } finally {
      setUploading(false);
    }
  };
  const visual = data?.visualAssets ?? initial;
  const linked = visual && visual.state !== 'unlinked';
  return (
    <section className="space-y-3" aria-label="头像正典">
      <div className="flex items-center gap-3">
        {linked && data?.avatar ? (
          <AvatarImageWithFallback
            src={`${API_URL}${data.avatar}`}
            alt={`${name}的头像`}
            className="h-16 w-16 rounded-full object-cover"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="text-sm">头像</p>
          <p className="mt-1 text-xs text-cafe-muted">
            {!visual
              ? '正在读取头像来源…'
              : visual.state === 'unlinked'
                ? '尚未关联正典'
                : visual.state === 'selected'
                  ? '正典 · 家里现在用的这张'
                  : visual.state === 'cleared'
                    ? '已关联正典，当前未选择'
                    : '这张图打不开了'}
            {linked ? (
              <button type="button" className="ml-2 text-cafe-accent" onClick={() => setShowHistory(!showHistory)}>
                看取代经过
              </button>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          className="rounded border border-cafe-subtle px-3 py-2 text-sm"
          onClick={() => setOpen(!open)}
        >
          {linked ? '换头像' : '从正典选'}
        </button>
      </div>
      {open ? (
        <div className="space-y-4 rounded-xl border border-cafe-subtle p-3">
          <div className="flex justify-between gap-2 text-sm">
            <span>从正典里选 · {name}的头像</span>
            <button type="button" className="text-cafe-accent" onClick={() => setWantUpload(!wantUpload)}>
              上传新图
            </button>
            <button type="button" onClick={() => setOpen(false)}>
              收起
            </button>
          </div>
          <div className="flex flex-wrap gap-4">
            {data?.candidates.items.map((item) => (
              <MemberCanonAvatarOption
                key={item.record.indexedVersionRef}
                item={item}
                name={name}
                selected={selected === item.record.indexedVersionRef}
                current={data.visualAssets.indexedVersionRef === item.record.indexedVersionRef}
                onSelect={() => setSelected(item.record.indexedVersionRef)}
              />
            ))}
          </div>
          {data && !data.candidates.items.length ? (
            <p className="text-xs text-cafe-muted">还没有这位成员头像用途的正典。</p>
          ) : null}
          {data?.candidates.nextAfter !== undefined ? (
            <button
              type="button"
              className="text-xs text-cafe-accent"
              onClick={() =>
                void apiFetch(`${endpoint}?after=${data.candidates.nextAfter}`)
                  .then((response) => checked<AvatarData>(response))
                  .then((next) =>
                    setData({
                      ...next,
                      candidates: { ...next.candidates, items: [...data.candidates.items, ...next.candidates.items] },
                    }),
                  )
                  .catch(() => setError('其余头像暂时无法读取。'))
              }
            >
              继续看
            </button>
          ) : null}
          <button
            type="button"
            className="rounded bg-cafe-accent px-3 py-2 text-sm text-white"
            disabled={uploading || !data || !selected}
            onClick={() => {
              const item = data?.candidates.items.find((i) => i.record.indexedVersionRef === selected);
              if (item) void save(item);
            }}
          >
            用这张
          </button>
          {wantUpload ? (
            <div className="space-y-2">
              <label className="block text-sm">
                为什么
                <input
                  required
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  className="mt-1 w-full rounded border border-cafe-subtle bg-cafe-surface p-2 focus:border-[var(--evolution-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--evolution-focus)]"
                />
              </label>
              <button
                type="button"
                className="rounded border border-cafe-subtle px-3 py-2 text-sm"
                disabled={uploading || !data || !reason.trim()}
                onClick={() => input.current?.click()}
              >
                选择图片并上传
              </button>
              <input
                ref={input}
                type="file"
                className="sr-only"
                aria-label="上传新的正典头像"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void upload(file);
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {showHistory ? (
        <div className="space-y-1 text-xs text-cafe-muted">
          {data?.history.map((h) => (
            <p key={h.bindingRevision}>
              {canonActor(h.actor)} · {h.recordedAt.slice(0, 10)} · {h.reason}
            </p>
          ))}
          {data?.nextHistoryAfter !== undefined ? (
            <button
              type="button"
              onClick={() =>
                void apiFetch(`${endpoint}?historyAfter=${data.nextHistoryAfter}`)
                  .then((response) => checked<AvatarData>(response))
                  .then((next) =>
                    setData({
                      ...data,
                      history: [...data.history, ...next.history],
                      nextHistoryAfter: next.nextHistoryAfter,
                    }),
                  )
                  .catch(() => setError('其余经过暂时无法读取。'))
              }
            >
              继续看经过
            </button>
          ) : null}
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="text-xs">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs">
          {error}{' '}
          <button type="button" onClick={() => void load().catch(() => setError('头像正典暂时无法读取。'))}>
            重新读取
          </button>
        </p>
      ) : null}
    </section>
  );
}
