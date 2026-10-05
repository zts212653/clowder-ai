'use client';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '@/utils/api-client';
import type { WorkspaceRootConnection } from './workspace-root-selection';

const operationSchema = z.object({
  operationId: z.string().min(1),
  root: z.string().min(1),
  expectedEpoch: z.number().int().nonnegative(),
  expectedUserId: z.string().min(1),
  admission: z.literal('absolute-file-directory').optional(),
  connectionProof: z.string().min(1).optional(),
});
type Operation = z.infer<typeof operationSchema>;
const receiptSchema = z.object({
  receiptRef: z.string().min(1),
  connected: z.boolean(),
  root: z.string(),
  ownerUserId: z.string(),
  operationId: z.string(),
  currentEpoch: z.number().int().nonnegative(),
  connectionProof: z.string().optional(),
});

export function WorkspaceRootConnectionPanel({
  connection,
  branch,
  onConnected,
  resumeOnOpen = true,
  beforeConnect,
  disabled = false,
  onSettled,
}: {
  connection: WorkspaceRootConnection;
  branch?: string;
  onConnected: () => void | Promise<void>;
  resumeOnOpen?: boolean;
  beforeConnect?: (
    operation: Operation,
    signal: AbortSignal,
  ) => Promise<{ connectionProof?: string; connected?: boolean } | void>;
  disabled?: boolean;
  onSettled?: (operation: Operation) => void;
}) {
  const key = `cat-cafe:workspace-root-connection:${JSON.stringify([connection.ownerUserId, connection.root, ...(connection.admission ? [connection.admission] : [])])}`;
  const [operation, setOperation] = useState<Operation | null>(null);
  const [fresh, setFresh] = useState(true);
  const [epoch, setEpoch] = useState(connection.expectedEpoch);
  const [proof, setProof] = useState(connection.connectionProof);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [knownConnected, setKnownConnected] = useState(false);
  const [removedFileConnection, setRemovedFileConnection] = useState(false);
  const active = useRef<AbortController | null>(null);
  const callback = useRef(onConnected);
  callback.current = onConnected;

  async function consume(value: unknown, expected: Operation, open = true) {
    const receipt = receiptSchema.parse(value);
    if (
      receipt.root !== expected.root ||
      receipt.ownerUserId !== expected.expectedUserId ||
      receipt.operationId !== expected.operationId
    )
      throw new Error('连接回执与当前选择不一致，请重新核对位置。');
    if (receipt.connected) {
      try {
        const stored = localStorage.getItem(key);
        if (stored && operationSchema.parse(JSON.parse(stored)).operationId === expected.operationId)
          localStorage.removeItem(key);
      } catch {
        /* A confirmed owner receipt remains true if local cleanup fails. */
      }
      if (open) await callback.current();
      else setKnownConnected(true);
    } else {
      setFresh(true);
      setEpoch(receipt.currentEpoch);
      setProof(receipt.connectionProof);
      setRemovedFileConnection(connection.admission === 'absolute-file-directory');
      setError(
        connection.admission === 'absolute-file-directory'
          ? '这份文件的目录连接已移除，请返回原入口核对。'
          : '此前的连接已移除。再次连接需确认下方的共享范围。',
      );
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    setReady(false);
    setError(null);
    void (async () => {
      try {
        const saved = localStorage.getItem(key);
        if (saved) {
          const prior = operationSchema.parse(JSON.parse(saved));
          if (
            prior.root !== connection.root ||
            prior.expectedUserId !== connection.ownerUserId ||
            prior.admission !== connection.admission
          )
            throw new Error('连接记录与当前位置不一致。');
          setOperation(prior);
          setFresh(false);
          const response = await apiFetch(
            `/api/workspace/root-connections?${new URLSearchParams({ operationId: prior.operationId })}`,
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          if (response.ok) await consume(await response.json(), prior, resumeOnOpen);
          else if (response.status !== 404) throw new Error('暂时无法核对原连接请求，请重试。');
        }
        if (!controller.signal.aborted) setReady(true);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '暂时无法读取连接记录，请重试。');
      }
    })();
    return () => controller.abort();
    // biome-ignore lint/correctness/useExhaustiveDependencies: immutable directory/user scope is the storage key
  }, [key, attempt]);

  async function connect() {
    const signal = active.current?.signal;
    if (!ready || busy || disabled || !signal || signal.aborted) return;
    setBusy(true);
    setError(null);
    let next =
      !fresh && operation
        ? operation
        : {
            operationId: crypto.randomUUID(),
            root: connection.root,
            expectedEpoch: epoch,
            expectedUserId: connection.ownerUserId,
            ...(connection.admission ? { admission: connection.admission } : {}),
            ...(proof ? { connectionProof: proof } : {}),
          };
    try {
      if (!next.connectionProof && proof && next.expectedEpoch === connection.expectedEpoch)
        next = { ...next, connectionProof: proof };
      if (knownConnected) {
        await beforeConnect?.(next, signal);
        if (!signal.aborted) await callback.current();
        return;
      }
      const prepared = await beforeConnect?.(next, signal);
      if (signal.aborted) return;
      if (prepared?.connected) {
        await callback.current();
        return;
      }
      if (!next.connectionProof && prepared?.connectionProof)
        next = { ...next, connectionProof: prepared.connectionProof };
      if (!next.connectionProof) throw new Error('Connection source must be verified before submission');
      localStorage.setItem(key, JSON.stringify(next));
      setOperation(next);
      setFresh(false);
      const response = await apiFetch('/api/workspace/root-connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
        signal,
      });
      const body = await response.json();
      if (signal.aborted) return;
      if (response.ok) await consume(body, next);
      else if (body?.error?.code === 'connection_changed' && Number.isSafeInteger(body.error.currentEpoch)) {
        setFresh(true);
        setEpoch(body.error.currentEpoch);
        setProof(body.error.connectionProof);
        setError('目录连接已发生变化。请再次确认当前目录和共享范围。');
      } else throw new Error('连接未完成，请核对位置、身份或原请求；重试将沿用这次请求。');
    } catch {
      if (!signal.aborted) setError('连接结果尚待核对，或本次凭据未能保存。请重试；当前目录保持不变。');
    } finally {
      onSettled?.(next);
      if (!signal.aborted) setBusy(false);
    }
  }

  return (
    <div data-testid="workspace-root-connection" className="space-y-3 p-4 text-sm">
      <p>
        连接后，该目录（包含其中其他文件）将加入当前 Clowder AI 的 Workspace 共享目录列表，可跨对话使用；可移除连接。
      </p>
      <p>
        {connection.name} · {connection.path}
      </p>
      <details>
        <summary>位置详情</summary>
        <p className="break-all">{connection.root}</p>
        {branch && <p>{branch}</p>}
      </details>
      {error && (
        <p role="alert" className="text-cafe-error">
          {error}
        </p>
      )}
      {ready && !removedFileConnection ? (
        <button type="button" disabled={busy || disabled} onClick={() => void connect()}>
          {busy
            ? '正在核对连接…'
            : knownConnected
              ? `在 ${connection.name} 继续`
              : !fresh && operation
                ? '核对并重试连接'
                : `连接 ${connection.name} 并继续`}
        </button>
      ) : (
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          重新读取连接记录
        </button>
      )}
    </div>
  );
}
