'use client';

/**
 * 无 diff 时的占位。#1809：读取失败且没有数据时不再提示「选择文件查看差异」——
 * 那会让用户以为本地还有一份可选的文件；失败态由 header 的错误、重试和 GitHub 出口承担。
 */
export function ChangesDiffPlaceholder({
  loading,
  failed,
  loadingLabel,
  selectFileLabel,
}: {
  loading: boolean;
  failed: boolean;
  loadingLabel: string;
  selectFileLabel: string;
}) {
  if (loading) return <div className="p-4 text-center text-cafe-secondary text-xs">{loadingLabel}</div>;
  if (failed) return null;
  return <div className="p-4 text-center text-cafe-secondary text-xs">{selectFileLabel}</div>;
}
