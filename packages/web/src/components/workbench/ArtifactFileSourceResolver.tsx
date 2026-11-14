'use client';

import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { apiFetch } from '@/utils/api-client';
import {
  canStillReadWorkspaceFile,
  resolveSourceFailure,
  type SourceResolutionFailure,
} from './artifact-file-source-failure';
import { ContentLandingHeader } from './content-review/ContentLandingHeader';
import { createFilePreviewSurface, createFileSurface } from './real-surface-adapters';
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

/** F232 is an entrance, never a second writable file host or an authorization source. */
export function ArtifactFileSourceResolver({
  path,
  title,
  onResolved,
  onBack,
  worktreeId,
  scrollToLine,
  rootSelection,
  perFileIdentity,
}: {
  readonly path: string;
  readonly title: string;
  readonly onResolved: (surface: WorkspaceSurfaceDescriptor) => void;
  readonly onBack: () => void;
  readonly worktreeId?: string;
  readonly scrollToLine?: number | null;
  readonly rootSelection?: WorkspaceRootSelection;
  /** Saved legacy descriptors keep their root identity when their alias is resolved. */
  readonly perFileIdentity?: boolean;
}) {
  const presentation = useShellPresentation();
  const usePerFileIdentity = perFileIdentity ?? presentation === 'v2';
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<SourceResolutionFailure | null>(null);
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
          const payload = await response.json().catch(() => null);
          const resolvedFailure = await resolveSourceFailure(
            response.status,
            payload,
            worktreeId,
            path,
            controller.signal,
          );
          if (!controller.signal.aborted) setError(resolvedFailure);
          return;
        }
        const body = await response.json();
        if (controller.signal.aborted) return;
        if (body.kind === 'connection-required') {
          setConnection({ scope, value: workspaceRootConnectionSchema.parse(body) });
          return;
        }
        const target = targetSchema.parse(body);
        if (!controller.signal.aborted)
          callback.current(
            (usePerFileIdentity ? createFilePreviewSurface : createFileSurface)({ ...target, scrollToLine }),
          );
      } catch (cause) {
        if (controller.signal.aborted) return;
        const currentRead = await canStillReadWorkspaceFile(worktreeId, path, controller.signal);
        if (!controller.signal.aborted)
          setError({
            kind: currentRead.readable ? 'preview-fallback' : 'blocked',
            message: cause instanceof Error && cause.message ? cause.message : '暂时无法核验原位置，请重试。',
          });
      }
    })();
    return () => controller.abort();
    // biome-ignore lint/correctness/useExhaustiveDependencies: directory branch is presentation metadata, root is the exact request input
  }, [path, worktreeId, scrollToLine, rootSelection?.root, scope, attempt, usePerFileIdentity]);
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
        <div data-content-opening-state={error.kind} className="space-y-3 p-4">
          <p role="alert" className="text-sm text-cafe-error">
            {error.message}
          </p>
          <button
            type="button"
            className="rounded-md border border-cafe bg-cafe-surface-elevated px-3 py-1.5 text-xs font-medium text-cafe hover:bg-cafe-surface-sunken"
            onClick={() => setAttempt((value) => value + 1)}
          >
            重试
          </button>
        </div>
      ) : (
        <p className="p-4 text-sm text-cafe-muted">正在核验原文件位置…</p>
      )}
    </section>
  );
}
