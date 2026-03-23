'use client';

import { useCallback } from 'react';
import { useConfirm } from '@/components/useConfirm';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

/** Ensure we have a valid edit token, refreshing if needed. Returns token or null. */
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

export function useFileManagement() {
  const confirm = useConfirm();
  const worktreeId = useChatStore((s) => s.workspaceWorktreeId);
  const editToken = useChatStore((s) => s.workspaceEditToken);
  const editTokenExpiry = useChatStore((s) => s.workspaceEditTokenExpiry);
  const setEditToken = useChatStore((s) => s.setWorkspaceEditToken);

  const createFile = useCallback(
    async (path: string, content = '') => {
      if (!worktreeId) return null;
      const token = await ensureToken(worktreeId, editToken, editTokenExpiry, setEditToken);
      if (!token) return null;
      const res = await apiFetch('/api/workspace/file/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worktreeId, path, content, editSessionToken: token }),
      });
      if (!res.ok) return null;
      return res.json();
    },
    [worktreeId, editToken, editTokenExpiry, setEditToken],
  );

  const createDir = useCallback(
    async (path: string) => {
      if (!worktreeId) return null;
      const token = await ensureToken(worktreeId, editToken, editTokenExpiry, setEditToken);
      if (!token) return null;
      const res = await apiFetch('/api/workspace/dir/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worktreeId, path, editSessionToken: token }),
      });
      if (!res.ok) return null;
      return res.json();
    },
    [worktreeId, editToken, editTokenExpiry, setEditToken],
  );

  const deleteItem = useCallback(
    async (path: string) => {
      if (!worktreeId) return false;
      const token = await ensureToken(worktreeId, editToken, editTokenExpiry, setEditToken);
      if (!token) return false;
      const res = await apiFetch('/api/workspace/file', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worktreeId, path, editSessionToken: token }),
      });
      return res.ok;
    },
    [worktreeId, editToken, editTokenExpiry, setEditToken],
  );

  const renameItem = useCallback(
    async (oldPath: string, newPath: string) => {
      if (!worktreeId) return false;
      const token = await ensureToken(worktreeId, editToken, editTokenExpiry, setEditToken);
      if (!token) return false;
      const res = await apiFetch('/api/workspace/file/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worktreeId, oldPath, newPath, editSessionToken: token }),
      });
      return res.ok;
    },
    [worktreeId, editToken, editTokenExpiry, setEditToken],
  );

  const uploadFile = useCallback(
    async (path: string, file: File) => {
      if (!worktreeId) return null;
      const token = await ensureToken(worktreeId, editToken, editTokenExpiry, setEditToken);
      if (!token) return null;
      const doUpload = async (overwrite: boolean) => {
        const form = new FormData();
        form.append('worktreeId', worktreeId);
        form.append('path', path);
        form.append('editSessionToken', token);
        form.append('file', file);
        const url = overwrite ? '/api/workspace/upload?overwrite=true' : '/api/workspace/upload';
        return apiFetch(url, { method: 'POST', body: form });
      };
      const res = await doUpload(false);
      if (res.status === 409) {
        const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
        if (!(await confirm({ title: '覆盖确认', message: `"${name}" 已存在，是否覆盖？` }))) return null;
        const retry = await doUpload(true);
        if (!retry.ok) return null;
        return retry.json();
      }
      if (!res.ok) return null;
      return res.json();
    },
    [worktreeId, editToken, editTokenExpiry, setEditToken, confirm],
  );

  return { createFile, createDir, deleteItem, renameItem, uploadFile };
}
