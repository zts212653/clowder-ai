import { useCallback, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

interface FileForEdit {
  sha256?: string;
  binary?: boolean;
  truncated?: boolean;
}

interface ScopedEditToken {
  worktreeId: string;
  token: string;
  expiry: number;
}

export function useFileEditing(deps: {
  worktreeId: string | null;
  openFilePath: string | null;
  file: FileForEdit | null;
  fetchFile: (path: string) => Promise<void>;
}) {
  const { worktreeId, openFilePath, file, fetchFile } = deps;
  const ambientWorktreeId = useChatStore((state) => state.workspaceWorktreeId);
  const ambientEditToken = useChatStore((state) => state.workspaceEditToken);
  const ambientEditTokenExpiry = useChatStore((state) => state.workspaceEditTokenExpiry);
  const setAmbientEditToken = useChatStore((state) => state.setWorkspaceEditToken);
  const [ownerToken, setOwnerToken] = useState<ScopedEditToken | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const usesAmbientOwner = worktreeId === ambientWorktreeId;
  const scopedOwnerToken = ownerToken?.worktreeId === worktreeId ? ownerToken : null;
  const editToken = usesAmbientOwner ? ambientEditToken : (scopedOwnerToken?.token ?? null);
  const editTokenExpiry = usesAmbientOwner ? ambientEditTokenExpiry : (scopedOwnerToken?.expiry ?? null);
  const isTokenValid = !!(editToken && editTokenExpiry && editTokenExpiry > Date.now());
  const canEdit = !!(file && !file.binary && !file.truncated);

  const setEditToken = useCallback(
    (token: string | null, expiresIn?: number) => {
      if (usesAmbientOwner) {
        setAmbientEditToken(token, expiresIn);
        return;
      }
      setOwnerToken(
        token && expiresIn && worktreeId ? { worktreeId, token, expiry: Date.now() + expiresIn * 1000 } : null,
      );
    },
    [setAmbientEditToken, usesAmbientOwner, worktreeId],
  );

  const handleToggleEdit = useCallback(async () => {
    if (editMode && isTokenValid) {
      setEditMode(false);
      return;
    }
    if (!worktreeId) return;
    setSaveError(null);

    if (!isTokenValid) {
      try {
        const res = await apiFetch('/api/workspace/edit-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktreeId }),
        });
        if (!res.ok) {
          setSaveError('无法获取编辑权限');
          return;
        }
        const data = await res.json();
        setEditToken(data.token, data.expiresIn);
      } catch {
        setSaveError('网络错误');
        return;
      }
    }
    setEditMode(true);
  }, [editMode, isTokenValid, setEditToken, worktreeId]);

  const handleSave = useCallback(
    async (newContent: string) => {
      if (!worktreeId || !openFilePath || !file) return;
      if (!editToken) {
        setSaveError('编辑会话过期，请点击「编辑」按钮刷新权限后重试保存');
        return;
      }
      setSaveError(null);
      try {
        const res = await apiFetch('/api/workspace/file', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            worktreeId,
            path: openFilePath,
            content: newContent,
            baseSha256: file.sha256,
            editSessionToken: editToken,
          }),
        });
        if (res.status === 409) {
          setSaveError('冲突：文件已被修改，请重新加载');
          return;
        }
        if (res.status === 401) {
          setEditToken(null);
          setSaveError('编辑会话过期，请点击「编辑」按钮刷新权限后重试保存');
          return;
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: 'Unknown error' }));
          setSaveError(data.error || '保存失败');
          return;
        }
        await fetchFile(openFilePath);
      } catch {
        setSaveError('网络错误');
      }
    },
    [editToken, fetchFile, file, openFilePath, setEditToken, worktreeId],
  );

  return {
    editMode,
    setEditMode,
    saveError,
    setSaveError,
    isTokenValid,
    canEdit,
    handleToggleEdit,
    handleSave,
  };
}
