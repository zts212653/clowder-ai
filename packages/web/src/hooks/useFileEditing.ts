import { useCallback, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

interface FileForEdit {
  sha256?: string;
  binary?: boolean;
  truncated?: boolean;
}

export function useFileEditing(deps: {
  worktreeId: string | null;
  openFilePath: string | null;
  file: FileForEdit | null;
  fetchFile: (path: string) => Promise<void>;
}) {
  const { worktreeId, openFilePath, file, fetchFile } = deps;

  const editToken = useChatStore((s) => s.workspaceEditToken);
  const editTokenExpiry = useChatStore((s) => s.workspaceEditTokenExpiry);
  const setEditToken = useChatStore((s) => s.setWorkspaceEditToken);

  const [editMode, setEditMode] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const isTokenValid = !!(editToken && editTokenExpiry && editTokenExpiry > Date.now());
  const canEdit = !!(file && !file.binary && !file.truncated);

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
  }, [editMode, worktreeId, isTokenValid, setEditToken]);

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
        if (openFilePath) await fetchFile(openFilePath);
      } catch {
        setSaveError('网络错误');
      }
    },
    [worktreeId, openFilePath, file, editToken, setEditToken, fetchFile],
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
