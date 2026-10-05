'use client';

import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '@/utils/api-client';
import { ContentLandingHeader } from './content-review/ContentLandingHeader';
import { createFileSurface } from './real-surface-adapters';
import { WorkspaceRootConnectionPanel } from './WorkspaceRootConnectionPanel';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';
import {
  type WorkspaceRootConnection,
  type WorkspaceRootSelection,
  workspaceRootConnectionSchema,
} from './workspace-root-selection';

const targetSchema = z.object({
  worktreeId: z.string().min(1).max(256),
  path: z.string().min(1).max(4096),
  kind: z.literal('file'),
});
const inventoryErrorSchema = z.object({
  error: z.object({
    code: z.literal('directory_inventory_unavailable'),
    locations: z.array(z.object({ label: z.string() })),
  }),
});

/** F232 is an entrance, never a second writable file host or an authorization source. */
export function ArtifactFileSourceResolver({
  path,
  title,
  onResolved,
  onBack,
  worktreeId,
  scrollToLine,
  rootSelection,
}: {
  readonly path: string;
  readonly title: string;
  readonly onResolved: (surface: WorkspaceSurfaceDescriptor) => void;
  readonly onBack: () => void;
  readonly worktreeId?: string;
  readonly scrollToLine?: number | null;
  readonly rootSelection?: WorkspaceRootSelection;
}) {
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<{ scope: string; value: WorkspaceRootConnection } | null>(null);
  const scope = JSON.stringify([path, worktreeId, rootSelection?.root, rootSelection?.expectedEpoch]);
  const callback = useRef(onResolved);
  callback.current = onResolved;
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void (async () => {
      try {
        const response = await apiFetch('/api/workspace/resolve-file-source', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(worktreeId ? { worktreeId } : {}),
            ...(rootSelection ? { selectedRoot: rootSelection.root, selectionEpoch: rootSelection.expectedEpoch } : {}),
            path,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const inventoryError = inventoryErrorSchema.safeParse(await response.json().catch(() => null));
          if (inventoryError.success) {
            const names = inventoryError.data.error.locations.map((location) => location.label).join('、');
            throw new Error(
              names
                ? `已登记目录暂时无法核验：${names}。请在 Workspace 文件树核对这些连接后重试。`
                : '暂时无法核验已登记目录，请核对 Workspace 的目录状态后重试。',
            );
          }
          throw new Error('原位置的文件暂时不可用，请核对文件是否仍在、访问权限是否有效。');
        }
        const body = await response.json();
        if (controller.signal.aborted) return;
        if (body.kind === 'connection-required') {
          setConnection({ scope, value: workspaceRootConnectionSchema.parse(body) });
          return;
        }
        const target = targetSchema.parse(body);
        if (!controller.signal.aborted) callback.current(createFileSurface({ ...target, scrollToLine }));
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '暂时无法核验原位置，请重试。');
      }
    })();
    return () => controller.abort();
    // biome-ignore lint/correctness/useExhaustiveDependencies: directory branch is presentation metadata, root is the exact request input
  }, [path, worktreeId, scrollToLine, rootSelection?.root, scope, attempt]);
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <ContentLandingHeader title={title} onBack={onBack} />
      {connection?.scope === scope ? (
        <WorkspaceRootConnectionPanel
          key={JSON.stringify([scope, connection.value.ownerUserId])}
          connection={connection.value}
          branch={rootSelection?.branch}
          onConnected={() => {
            setConnection(null);
            setAttempt((value) => value + 1);
          }}
        />
      ) : error ? (
        <div className="space-y-3 p-4">
          <p role="alert" className="text-sm text-cafe-error">
            {error}
          </p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            重试
          </button>
        </div>
      ) : (
        <p className="p-4 text-sm text-cafe-muted">正在核验原文件位置…</p>
      )}
    </section>
  );
}
