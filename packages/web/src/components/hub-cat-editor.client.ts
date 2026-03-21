'use client';

import { apiFetch } from '@/utils/api-client';

export async function uploadAvatarAsset(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('头像读取失败'));
    reader.readAsDataURL(file);
  });

  const res = await apiFetch('/api/preview/screenshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error((payload.error as string) ?? `头像上传失败 (${res.status})`);
  }
  const payload = (await res.json()) as { url?: string };
  if (!payload.url) throw new Error('头像上传失败');
  return payload.url;
}

export function buildEditorLoadingNote(flags: {
  loadingProfiles: boolean;
  loadingStrategy: boolean;
  loadingCodexSettings: boolean;
}): string {
  return [
    flags.loadingProfiles ? '账号配置加载中…' : null,
    flags.loadingStrategy ? 'Session 策略加载中…' : null,
    flags.loadingCodexSettings ? 'Codex 参数加载中…' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
