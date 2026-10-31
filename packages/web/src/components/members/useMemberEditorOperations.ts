'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { uploadAvatarAsset, uploadRefAudioAsset } from '../hub-cat-editor.client';
import type { HubCatEditorFormState } from '../hub-cat-editor.model';
import type { HubCatEditorProps } from '../hub-cat-editor.types';
import { readApiError } from '../settings/settings-utils';
import type { useHubCatEditorData } from '../useHubCatEditorData';
import type { MemberOperationIssues } from './MemberOperationFeedback';

export function useMemberEditorOperations(
  props: HubCatEditorProps,
  data: ReturnType<typeof useHubCatEditorData>,
  patchForm: (patch: Partial<HubCatEditorFormState>) => void,
) {
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [uploadingAudio, setUploadingAudio] = useState(false);
  const pendingFiles = useRef<{ avatar?: File; audio?: File }>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: operation errors and retained files belong to this editor session only.
  useEffect(() => {
    setAvatarError(null);
    setAudioError(null);
    setRestoreError(null);
    pendingFiles.current = {};
  }, [props.open, props.cat?.id]);

  const handleAvatarUpload = async (file: File) => {
    pendingFiles.current.avatar = file;
    data.setUploadingAvatar(true);
    setAvatarError(null);
    try {
      patchForm({ avatar: await uploadAvatarAsset(file) });
      delete pendingFiles.current.avatar;
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : '头像上传失败');
    } finally {
      data.setUploadingAvatar(false);
    }
  };
  const handleRefAudioUpload = async (file: File) => {
    pendingFiles.current.audio = file;
    setUploadingAudio(true);
    setAudioError(null);
    try {
      patchForm({ voiceRefAudio: (await uploadRefAudioAsset(file)).url });
      delete pendingFiles.current.audio;
    } catch (err) {
      setAudioError(err instanceof Error ? err.message : '参考音频上传失败');
    } finally {
      setUploadingAudio(false);
    }
  };
  const handleRestoreBuiltinCloudIdentity = async (catId: string) => {
    if (data.restoringCloudIdentity) return;
    data.setRestoringCloudIdentity(true);
    setRestoreError(null);
    try {
      const res = await apiFetch(`/api/cats/${catId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restoreBuiltinCloudIdentity: true }),
      });
      if (!res.ok) {
        setRestoreError(await readApiError(res));
        return;
      }
      await props.onSaved();
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : '云端身份恢复失败');
    } finally {
      data.setRestoringCloudIdentity(false);
    }
  };
  const operationIssues: MemberOperationIssues = {
    accounts: {
      error: data.profilesError,
      pending: data.loadingProfiles,
      retry: () => data.setProfilesVersion((v) => v + 1),
    },
    avatar: {
      error: avatarError,
      pending: data.uploadingAvatar,
      retry: () => {
        if (pendingFiles.current.avatar) void handleAvatarUpload(pendingFiles.current.avatar);
      },
    },
    audio: {
      error: audioError,
      pending: uploadingAudio,
      retry: () => {
        if (pendingFiles.current.audio) void handleRefAudioUpload(pendingFiles.current.audio);
      },
    },
    restore: {
      error: restoreError,
      pending: data.restoringCloudIdentity,
      retry: () => {
        if (props.cat) void handleRestoreBuiltinCloudIdentity(props.cat.id);
      },
    },
  };
  return { operationIssues, handleAvatarUpload, handleRefAudioUpload, handleRestoreBuiltinCloudIdentity };
}
