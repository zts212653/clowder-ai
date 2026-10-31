/**
 * Shared utilities for settings hooks.
 */

/** Extract an error message from a failed API response. */
export async function readApiError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? `请求失败 (${res.status})`;
}
