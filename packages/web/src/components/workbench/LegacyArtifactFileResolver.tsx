'use client';

import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '@/utils/api-client';
import { ArtifactFileSourceResolver } from './ArtifactFileSourceResolver';
import {
  type ArtifactFileEntrance,
  type ArtifactFileLocation,
  artifactFileLocationKey,
  artifactFileLocationSchema,
} from './artifact-file-source';
import { ContentLandingHeader } from './content-review/ContentLandingHeader';
import { createFileSurface } from './real-surface-adapters';
import { WorkspaceRootConnectionPanel } from './WorkspaceRootConnectionPanel';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

const inventorySchema = z.object({
  ownerUserId: z.string().min(1),
  inventory: z.enum(['available', 'partial']),
  locations: z.array(
    z.object({
      root: z.string().min(1),
      label: z.string().min(1),
      branch: z.string(),
      status: z.enum(['available', 'unavailable']),
      connection: z.enum(['connected', 'required', 'unknown']).optional(),
      expectedEpoch: z.number().int().nonnegative().optional(),
    }),
  ),
});
const selectedSchema = z.object({
  worktreeId: z.string().min(1),
  path: z.string().min(1),
  kind: z.literal('file'),
  absolutePath: artifactFileLocationSchema.shape.absolutePath,
});
type Inventory = z.infer<typeof inventorySchema>;

export function LegacyArtifactFileResolver({
  source,
  onResolved,
  onBack,
  forceChoice = false,
}: {
  readonly source: ArtifactFileEntrance;
  readonly onResolved: (surface: WorkspaceSurfaceDescriptor) => void;
  readonly onBack: () => void;
  readonly forceChoice?: boolean;
}) {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [saved, setSaved] = useState<ArtifactFileLocation | null>(null);
  const [choosing, setChoosing] = useState(forceChoice);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const pending = useRef<AbortController | null>(null);
  const connectionBusy = useRef<string | null>(null);
  const choiceSequence = useRef(0);
  const callback = useRef(onResolved);
  callback.current = onResolved;
  const sourceKey = JSON.stringify([source.threadId, source.artifactId]);
  useEffect(() => {
    const controller = new AbortController();
    pending.current = controller;
    setError(null);
    setInventory(null);
    void (async () => {
      try {
        const response = await apiFetch('/api/workspace/file-locations', { signal: controller.signal });
        if (!response.ok) throw new Error('暂时无法读取文件位置，请重试。');
        const next = inventorySchema.parse(await response.json());
        if (controller.signal.aborted) return;
        setInventory(next);
        const raw = localStorage.getItem(artifactFileLocationKey(next.ownerUserId, source));
        if (raw) {
          const prior = artifactFileLocationSchema.parse(JSON.parse(raw));
          setSaved(prior);
        } else {
          setSaved(null);
        }
      } catch {
        if (!controller.signal.aborted) setError('暂时无法读取文件位置或保存的选择，请重试；没有改用其他目录。');
      }
    })();
    return () => controller.abort();
    // The entrance is immutable; object reference changes do not reread or reset its selection.
    // biome-ignore lint/correctness/useExhaustiveDependencies: exact entrance identity is sourceKey
  }, [sourceKey, attempt]);

  function resolved(surface: WorkspaceSurfaceDescriptor, location: ArtifactFileLocation) {
    callback.current({ ...surface, artifactFileSource: { ...source, selectedLocation: location } });
  }
  async function choose(location: Inventory['locations'][number], fromConnection = false) {
    if (
      !inventory ||
      (!fromConnection && (busy || connectionBusy.current)) ||
      location.status !== 'available' ||
      !pending.current ||
      pending.current.signal.aborted
    )
      return;
    const sequence = ++choiceSequence.current;
    const signal = pending.current.signal;
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch('/api/workspace/resolve-file-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selectedRoot: location.root,
          selectionEpoch: location.expectedEpoch,
          path: source.path,
          expectedUserId: inventory.ownerUserId,
        }),
        signal,
      });
      if (!response.ok) throw new Error('所选位置的文件不可读取，请核对路径或重试。');
      const target = selectedSchema.parse(await response.json());
      if (signal.aborted || sequence !== choiceSequence.current) return;
      const next = { absolutePath: target.absolutePath, label: location.label };
      try {
        localStorage.setItem(artifactFileLocationKey(inventory.ownerUserId, source), JSON.stringify(next));
      } catch {
        throw new Error('本次选择尚未保存。请重试；此前保存的位置保持不变。');
      }
      setSaved(next);
      resolved(createFileSurface(target), next);
    } catch (cause) {
      if (!signal.aborted && sequence === choiceSequence.current)
        setError(cause instanceof Error ? cause.message : '无法打开所选文件，请重试。');
    } finally {
      if (!signal.aborted && sequence === choiceSequence.current) setBusy(false);
    }
  }

  if (saved && !choosing)
    return (
      <section className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
          <span>继续你选定的位置：{saved.label}</span>
          <button type="button" onClick={() => setChoosing(true)}>
            选择其他位置
          </button>
          <details>
            <summary>位置详情</summary>
            <p className="break-all">{saved.absolutePath}</p>
          </details>
        </div>
        <ArtifactFileSourceResolver
          path={saved.absolutePath}
          rootSelection={saved.rootSelection}
          title={source.title}
          onBack={onBack}
          onResolved={(surface) => resolved(surface, saved)}
        />
      </section>
    );
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <ContentLandingHeader title={source.title} onBack={onBack} />
      <div className="space-y-3 overflow-auto p-4 text-sm">
        <p>这条旧产物没有保存原目录，请选择要继续的文件位置。</p>
        <p className="text-xs text-cafe-muted">打开的是你现在选定的文件，不代表已找回历史原件。</p>
        {saved && (
          <button type="button" onClick={() => setChoosing(false)}>
            保留原选择：{saved.label}
          </button>
        )}
        {error && (
          <p role="alert" className="text-cafe-error">
            {error}
          </p>
        )}
        {!inventory ? (
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            重新读取位置
          </button>
        ) : (
          <>
            {inventory.inventory === 'partial' && (
              <p role="status">部分已登记位置或目录尚无法核验，不能据此判断原目录不存在。</p>
            )}
            {inventory.locations.length === 0 && <p>当前没有可列出的文件位置，请核对 Workspace 的目录登记。</p>}
            {inventory.locations.map((location) => (
              <div key={location.root} className="rounded border border-cafe p-3">
                {location.connection === 'required' &&
                location.status === 'available' &&
                location.expectedEpoch !== undefined ? (
                  <WorkspaceRootConnectionPanel
                    connection={{
                      kind: 'connection-required',
                      ownerUserId: inventory.ownerUserId,
                      root: location.root,
                      name: location.label,
                      path: source.path,
                      expectedEpoch: location.expectedEpoch,
                    }}
                    branch={location.branch}
                    resumeOnOpen={false}
                    disabled={busy}
                    beforeConnect={async (operation, signal) => {
                      if (connectionBusy.current && connectionBusy.current !== operation.operationId)
                        throw new Error('另一个位置正在处理。');
                      connectionBusy.current = operation.operationId;
                      setBusy(true);
                      const response = await apiFetch('/api/workspace/resolve-file-source', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          selectedRoot: operation.root,
                          selectionEpoch: operation.expectedEpoch,
                          path: source.path,
                          expectedUserId: operation.expectedUserId,
                        }),
                        signal,
                      });
                      if (!response.ok) throw new Error('所选文件暂时无法核验。');
                      const body = await response.json();
                      const next = artifactFileLocationSchema.parse({
                        absolutePath: body.absolutePath,
                        label: location.label,
                        rootSelection: {
                          root: operation.root,
                          branch: location.branch,
                          expectedEpoch: operation.expectedEpoch,
                        },
                      });
                      if (signal.aborted) return;
                      localStorage.setItem(
                        artifactFileLocationKey(inventory.ownerUserId, source),
                        JSON.stringify(next),
                      );
                      setSaved(next);
                      setChoosing(true);
                      return {
                        ...(typeof body.connectionProof === 'string' ? { connectionProof: body.connectionProof } : {}),
                        connected: body.kind === 'file',
                      };
                    }}
                    onConnected={() => choose(location, true)}
                    onSettled={(operation) => {
                      if (connectionBusy.current === operation.operationId) {
                        connectionBusy.current = null;
                        setBusy(false);
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    disabled={
                      busy ||
                      location.status !== 'available' ||
                      location.connection === 'unknown' ||
                      location.connection === 'required'
                    }
                    onClick={() => void choose(location)}
                  >
                    在 {location.label} 继续
                  </button>
                )}
                <p className="text-xs text-cafe-muted">{location.branch}</p>
                {location.status === 'unavailable' && <p className="text-xs text-cafe-error">这个位置暂时无法核验。</p>}
                <details>
                  <summary>位置详情</summary>
                  <p className="break-all">
                    {location.root}/{source.path}
                  </p>
                </details>
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}
