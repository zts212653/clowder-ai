'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export interface DetectedClient {
  /** Client ID — CLI tool identity (claude, codex, gemini, opencode) */
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
  /** #768: ClientId the chosen role template recommends (`roleTemplates[].defaultClient`). */
  recommendedClient?: string;
}

export function ClientStep({ onSelect, recommendedClient }: ClientStepProps) {
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
    return <p className="py-8 text-center text-sm text-cafe-muted">检测已安装的客户端...</p>;
  }

  // #768: the template's recommended client leads its group; binding still needs an
  // installed CLI, so recommendation ranks and labels the list instead of forcing it.
  const recommendedFirst = (a: DetectedClient, b: DetectedClient) =>
    Number(b.provider === recommendedClient) - Number(a.provider === recommendedClient);
  const installed = clients.filter((c) => c.installed).sort(recommendedFirst);
  const notInstalled = clients.filter((c) => !c.installed).sort(recommendedFirst);
  // Detected but not installed is not a usable recommendation — it cannot be bound here,
  // so it must still raise the notice, and it is labelled in the uninstalled list so the
  // user can see which CLI to install rather than facing arbitrary installed clients.
  const recommendedEntry = recommendedClient ? clients.find((c) => c.provider === recommendedClient) : undefined;
  const recommendationUsable = !recommendedClient || (recommendedEntry?.installed ?? false);
  const recommendedBadge = (client: DetectedClient) =>
    client.provider === recommendedClient ? (
      <span className="ml-2 rounded-md bg-conn-amber-bg px-1.5 py-0.5 text-xs font-semibold text-conn-amber-text">
        模板推荐
      </span>
    ) : null;

  return (
    <div>
      <h4 className="mb-1 text-sm font-semibold text-cafe-secondary">选择客户端</h4>
      <p className="mb-4 text-xs text-cafe-muted">猫猫需要一个 CLI 客户端来工作。我们检测到以下已安装的客户端：</p>

      {recommendationUsable ? null : (
        <p className="mb-3 text-xs text-conn-amber-text">
          这个角色模板推荐 {recommendedClient} 客户端，但本机{recommendedEntry ? '尚未安装' : '检测不到'}
          它；先选一个已安装的客户端，创建成员后可在成员设置里切换。
        </p>
      )}

      {installed.length === 0 ? (
        <div className="rounded-xl border border-conn-amber-ring bg-conn-amber-bg p-4 text-sm text-conn-amber-text">
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
                  ? 'border-[var(--semantic-warning)] bg-conn-amber-bg shadow-sm'
                  : 'border-[var(--console-border-soft)] bg-cafe-surface-canvas hover:border-conn-amber-ring'
              }`}
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-conn-green-bg text-conn-green-text">
                ✓
              </div>
              <div>
                <span className="font-semibold text-cafe">{c.label}</span>
                {recommendedBadge(c)}
                {c.version && <span className="ml-2 text-xs text-cafe-muted">{c.version}</span>}
              </div>
            </button>
          ))}
        </div>
      )}

      {notInstalled.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs text-cafe-muted">未安装：</p>
          <div className="flex flex-wrap gap-2">
            {notInstalled.map((c) => (
              <span
                key={c.client}
                className="rounded-lg border border-[var(--console-border-soft)] px-2 py-1 text-xs text-cafe-muted"
              >
                {c.label}
                {recommendedBadge(c)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
