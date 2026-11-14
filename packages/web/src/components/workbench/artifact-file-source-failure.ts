import { z } from 'zod';
import { apiFetch } from '@/utils/api-client';

const inventoryErrorSchema = z.object({
  error: z.object({
    code: z.literal('directory_inventory_unavailable'),
    locations: z.array(z.object({ label: z.string() })),
  }),
});

export type SourceResolutionFailure = {
  readonly kind: 'blocked' | 'preview-fallback';
  readonly message: string;
};

function readErrorCode(payload: unknown): string {
  const error = (payload as { error?: unknown } | null)?.error;
  if (typeof error === 'string') return error;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

const STATUS_DEFAULT_CODE: Record<number, string> = {
  401: 'access_denied',
  403: 'access_denied',
  404: 'not_found',
  413: 'too_large',
};

function classifySourceFailure(status: number, payload: unknown): SourceResolutionFailure {
  const inventoryError = inventoryErrorSchema.safeParse(payload);
  if (inventoryError.success) {
    const names = inventoryError.data.error.locations.map((location) => location.label).join('、');
    return {
      kind: 'preview-fallback',
      message: names
        ? `已登记目录暂时无法核验：${names}。请在 Workspace 文件树核对这些连接后重试。`
        : '暂时无法核验已登记目录，请核对 Workspace 的目录状态后重试。',
    };
  }
  const rawCode = readErrorCode(payload);
  const code =
    STATUS_DEFAULT_CODE[status] === 'access_denied'
      ? 'access_denied'
      : rawCode !== 'unknown'
        ? rawCode
        : STATUS_DEFAULT_CODE[status];
  switch (code) {
    case 'identity_required':
    case 'access_denied':
      return {
        kind: 'blocked',
        message: '当前无权访问原位置的文件；已停止展示缓存预览，请核对访问权限后重试。',
      };
    case 'identity_changed':
      return {
        kind: 'blocked',
        message: '当前登录身份已变化，无法沿用原位置访问；请核对身份后重试。',
      };
    case 'too_large':
      return {
        kind: 'preview-fallback',
        message: '原文件超出协作打开大小限制，暂无法在作品现场打开。',
      };
    case 'not_found':
      return {
        kind: 'preview-fallback',
        message: '该文件所在目录尚未登记为持久协作目录，或原位置文件暂不可用；请核对目录连接或文件位置后重试。',
      };
    default:
      return {
        kind: 'preview-fallback',
        message: '暂时无法核验原文件位置，请稍后重试。',
      };
  }
}

export async function canStillReadWorkspaceFile(
  worktreeId: string | undefined,
  path: string,
  signal: AbortSignal,
): Promise<{ readable: true } | { readable: false; status: number }> {
  if (!worktreeId) return { readable: false, status: 0 };
  try {
    const res = await apiFetch(`/api/workspace/file?${new URLSearchParams({ worktreeId, path })}`, {
      cache: 'no-store',
      signal,
    });
    if (!res.ok) return { readable: false, status: res.status };
    const body = (await res.json().catch(() => null)) as { path?: unknown } | null;
    return body?.path === path ? { readable: true } : { readable: false, status: 404 };
  } catch {
    return { readable: false, status: 0 };
  }
}

export async function resolveSourceFailure(
  status: number,
  payload: unknown,
  worktreeId: string | undefined,
  path: string,
  signal: AbortSignal,
): Promise<SourceResolutionFailure> {
  const classified = classifySourceFailure(status, payload);
  if (classified.kind === 'blocked') return classified;
  const currentRead = await canStillReadWorkspaceFile(worktreeId, path, signal);
  if (currentRead.readable) return classified;
  if (currentRead.status === 401 || currentRead.status === 403) {
    return {
      kind: 'blocked',
      message: '当前无权访问原位置的文件；已停止展示缓存预览，请核对访问权限后重试。',
    };
  }
  return {
    kind: 'blocked',
    message:
      status === 404 || currentRead.status === 404
        ? '原文件所在目录未连接或当前不可读取；已停止展示缓存预览，请核对目录连接或文件位置后重试。'
        : classified.message,
  };
}
