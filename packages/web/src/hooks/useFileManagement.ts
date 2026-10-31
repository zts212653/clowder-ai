'use client';

import { useCallback, useRef } from 'react';
import { useConfirm } from '@/components/useConfirm';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

interface ScopedEditToken {
  worktreeId: string;
  token: string;
  expiry: number;
}

async function ensureToken(
  worktreeId: string,
  token: string | null,
  expiry: number | null,
  setToken: (token: string | null, expiresIn?: number) => void,
): Promise<string | null> {
  if (token && expiry && expiry > Date.now()) return token;
  try {
    const res = await apiFetch('/api/workspace/edit-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worktreeId }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    setToken(data.token, data.expiresIn);
    return data.token;
  } catch {
    return null;
  }
}

async function uploadWorkspaceFile(
  worktreeId: string,
  token: string,
  path: string,
  file: File,
  confirm: ReturnType<typeof useConfirm>,
) {
  const doUpload = async (overwrite: boolean) => {
    const form = new FormData();
    form.append('worktreeId', worktreeId);
    form.append('path', path);
    form.append('editSessionToken', token);
    form.append('file', file);
    const url = overwrite ? '/api/workspace/upload?overwrite=true' : '/api/workspace/upload';
    return apiFetch(url, { method: 'POST', body: form });
  };
  let response = await doUpload(false);
  if (response.status === 409) {
    const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
    if (!(await confirm({ title: '覆盖确认', message: `"${name}" 已存在，是否覆盖？` }))) return null;
    response = await doUpload(true);
  }
  if (!response.ok) return null;
  return response.json();
}

/**
 * File actions for either the ambient Workspace selection or an explicitly
 * persisted F307 owner. Explicit owners never reuse another worktree's token.
 */
export function useFileManagement(ownerWorktreeId?: string | null) {
  const confirm = useConfirm();
  const ambientWorktreeId = useChatStore((s) => s.workspaceWorktreeId);
  const ambientEditToken = useChatStore((s) => s.workspaceEditToken);
  const ambientEditTokenExpiry = useChatStore((s) => s.workspaceEditTokenExpiry);
  const setAmbientEditToken = useChatStore((s) => s.setWorkspaceEditToken);
  const ownerTokenRef = useRef<ScopedEditToken | null>(null);
  const worktreeId = ownerWorktreeId === undefined ? ambientWorktreeId : ownerWorktreeId;

  const ensureEditToken = useCallback(async () => {
    if (!worktreeId) return null;
    const usesAmbientOwner = worktreeId === ambientWorktreeId;
    const cachedOwnerToken = ownerTokenRef.current?.worktreeId === worktreeId ? ownerTokenRef.current : null;
    return ensureToken(
      worktreeId,
      usesAmbientOwner ? ambientEditToken : (cachedOwnerToken?.token ?? null),
      usesAmbientOwner ? ambientEditTokenExpiry : (cachedOwnerToken?.expiry ?? null),
      (token, expiresIn) => {
        if (usesAmbientOwner) {
          setAmbientEditToken(token, expiresIn);
          return;
        }
        ownerTokenRef.current =
          token && expiresIn ? { worktreeId, token, expiry: Date.now() + expiresIn * 1000 } : null;
      },
    );
  }, [ambientEditToken, ambientEditTokenExpiry, ambientWorktreeId, setAmbientEditToken, worktreeId]);

  const createFile = useCallback(
    async (path: string, content = '') => {
      if (!worktreeId) return null;
      const token = await ensureEditToken();
      if (!token) return null;
      const res = await apiFetch('/api/workspace/file/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worktreeId, path, content, editSessionToken: token }),
      });
      if (!res.ok) return null;
      return res.json();
    },
    [ensureEditToken, worktreeId],
  );

  const createDir = useCallback(
    async (path: string) => {
      if (!worktreeId) return null;
      const token = await ensureEditToken();
      if (!token) return null;
      const res = await apiFetch('/api/workspace/dir/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worktreeId, path, editSessionToken: token }),
      });
      if (!res.ok) return null;
      return res.json();
    },
    [ensureEditToken, worktreeId],
  );

  const deleteItem = useCallback(
    async (path: string) => {
      if (!worktreeId) return false;
      const token = await ensureEditToken();
      if (!token) return false;
      const res = await apiFetch('/api/workspace/file', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worktreeId, path, editSessionToken: token }),
      });
      return res.ok;
    },
    [ensureEditToken, worktreeId],
  );

  const renameItem = useCallback(
    async (oldPath: string, newPath: string) => {
      if (!worktreeId) return false;
      const token = await ensureEditToken();
      if (!token) return false;
      const res = await apiFetch('/api/workspace/file/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worktreeId, oldPath, newPath, editSessionToken: token }),
      });
      return res.ok;
    },
    [ensureEditToken, worktreeId],
  );

  const uploadFile = useCallback(
    async (path: string, file: File) => {
      if (!worktreeId) return null;
      const token = await ensureEditToken();
      return token ? uploadWorkspaceFile(worktreeId, token, path, file, confirm) : null;
    },
    [confirm, ensureEditToken, worktreeId],
  );

  return { createFile, createDir, deleteItem, renameItem, uploadFile };
}
