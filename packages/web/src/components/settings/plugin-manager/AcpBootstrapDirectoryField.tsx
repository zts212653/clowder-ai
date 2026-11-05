'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

type Check = { ok: true; root: string; trustMode?: 'strict' | 'trusted-host' } | { ok: false; error: string };
export function AcpBootstrapDirectoryField({
  value,
  label,
  onChange,
}: {
  value: string;
  label: string;
  onChange(value: string): void;
}) {
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setCheck(null);
    setBusy(false);
    return () => {
      generation.current++;
    };
  }, [value]);
  const inspect = async () => {
    const current = ++generation.current;
    setBusy(true);
    setCheck(null);
    try {
      const response = await apiFetch('/api/agent-providers/bootstrap-check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value ? { root: value } : {}),
      });
      const result: Check = await response.json();
      if (!response.ok || (result.ok ? typeof result.root !== 'string' : typeof result.error !== 'string')) {
        throw new Error('目录检查失败，请在运行 Host 的电脑上以所有者身份重试。');
      }
      if (generation.current === current) setCheck(result);
    } catch (error) {
      if (generation.current === current)
        setCheck({ ok: false, error: error instanceof Error ? error.message : '目录检查失败。' });
    } finally {
      if (generation.current === current) setBusy(false);
    }
  };
  return (
    <div className="space-y-2 text-xs text-cafe-secondary">
      <label className="block">
        引导目录（可选，留空自动选择）
        <input
          className="w-full rounded-lg bg-[var(--console-field-bg)] px-3 py-2 text-sm text-cafe"
          aria-label={label}
          placeholder="运行 Host 的电脑上的绝对路径"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <p>
        按 Host
        当前信任策略检查目录与父链。检查会创建专用私有目录，未启动客户端；不会修改已有目录权限。它与项目工作目录不同。
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void inspect()}
        className="rounded-lg bg-[var(--console-field-bg)] px-3 py-2 font-semibold text-cafe"
      >
        {busy ? '正在检查目录…' : '检查引导目录'}
      </button>
      {check &&
        (check.ok ? (
          <div role="status" className="space-y-2 break-all">
            <p>
              {check.trustMode === 'trusted-host' ? '兼容模式检查通过（已跳过祖先信任校验）' : '严格检查通过'}：
              {check.root}
            </p>
            <p>此结果只证明目录合格；保存配置后，再发送消息验证客户端。</p>
            {value !== check.root && (
              <button type="button" className="font-semibold text-cafe" onClick={() => onChange(check.root)}>
                使用此目录
              </button>
            )}
          </div>
        ) : (
          <p role="alert" className="whitespace-pre-wrap break-all">
            {check.error}
          </p>
        ))}
    </div>
  );
}
