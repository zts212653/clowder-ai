'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export interface DetectedClient {
  /** Client ID — CLI tool identity (claude, codex, gemini, opencode, dare) */
  client: string;
  /** Client provider key for account binding (anthropic, openai, google) — distinct from model provider. */
  provider: string;
  label: string;
  cli: string;
  installed: boolean;
  version?: string;
  hasApiKey: boolean;
}

interface ClientStepProps {
  onSelect: (client: DetectedClient) => void;
}

export function ClientStep({ onSelect }: ClientStepProps) {
  const [clients, setClients] = useState<DetectedClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/first-run/available-clients')
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to detect clients');
        return (await res.json()) as { clients: DetectedClient[] };
      })
      .then((body) => {
        if (!cancelled) setClients(body.clients);
      })
      .catch(() => {
        if (!cancelled) setClients([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <p className="py-8 text-center text-sm text-gray-400">检测已安装的客户端...</p>;
  }

  const installed = clients.filter((c) => c.installed);
  const notInstalled = clients.filter((c) => !c.installed);

  return (
    <div>
      <h4 className="mb-1 text-sm font-semibold text-gray-700">选择客户端</h4>
      <p className="mb-4 text-xs text-gray-500">猫猫需要一个 CLI 客户端来工作。我们检测到以下已安装的客户端：</p>

      {installed.length === 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
          未检测到已安装的客户端。请先安装至少一个 CLI 工具（如 Claude Code、Codex、OpenCode）。
        </div>
      ) : (
        <div className="space-y-2">
          {installed.map((c) => (
            <button
              key={c.client}
              type="button"
              onClick={() => {
                setSelected(c.client);
                onSelect(c);
              }}
              className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${
                selected === c.client
                  ? 'border-amber-400 bg-amber-50 shadow-sm'
                  : 'border-gray-200 bg-white hover:border-amber-200'
              }`}
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-100 text-green-600">✓</div>
              <div>
                <span className="font-semibold text-gray-900">{c.label}</span>
                {c.version && <span className="ml-2 text-xs text-gray-400">{c.version}</span>}
              </div>
            </button>
          ))}
        </div>
      )}

      {notInstalled.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs text-gray-400">未安装：</p>
          <div className="flex flex-wrap gap-2">
            {notInstalled.map((c) => (
              <span key={c.client} className="rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-400">
                {c.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
