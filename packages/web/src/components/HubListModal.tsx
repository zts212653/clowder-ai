'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { HubConnectorConfigTab } from './HubConnectorConfigTab';
import HubPermissionsTab from './HubPermissionsTab';
import { HubIcon } from './icons/HubIcon';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';
import { formatRelativeTime } from './ThreadSidebar/thread-utils';

const CONNECTOR_LABELS: Record<string, string> = {
  feishu: '飞书',
  telegram: 'Telegram',
  wechat: '微信',
  slack: 'Slack',
  discord: 'Discord',
  'wecom-bot': '企业微信',
  'wecom-agent': '企微自建应用',
  dingtalk: '钉钉',
};

/** Connectors that support group chat and thus need permission management. */
const GROUP_CONNECTORS: { id: string; label: string }[] = [
  { id: 'feishu', label: '飞书' },
  { id: 'wecom-bot', label: '企业微信' },
  { id: 'dingtalk', label: '钉钉' },
];

type HubTab = 'threads' | 'config' | 'permissions';

interface HubThreadSummary {
  id: string;
  title?: string;
  connectorId?: string;
  externalChatId?: string;
  createdAt?: number;
  lastCommandAt?: number;
}

interface HubListModalProps {
  open: boolean;
  onClose: () => void;
  currentThreadId?: string;
}

export function HubListModal({ open, onClose, currentThreadId }: HubListModalProps) {
  const [hubThreads, setHubThreads] = useState<HubThreadSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<HubTab>('threads');
  const [permConnector, setPermConnector] = useState(GROUP_CONNECTORS[0].id);

  const fetchHubThreads = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch('/api/connector/hub-threads');
      if (!res.ok) {
        setLoadError('加载 IM Hub 失败，请稍后重试。');
        return;
      }
      const data = await res.json();
      setHubThreads(data.threads ?? []);
    } catch {
      setLoadError('加载 IM Hub 失败，请稍后重试。');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      fetchHubThreads();
      setActiveTab('threads');
    }
  }, [open, fetchHubThreads]);

  if (!open) return null;

  const handleNavigate = (threadId: string) => {
    pushThreadRouteWithHistory(threadId, typeof window !== 'undefined' ? window : undefined);
    onClose();
  };

  const grouped = new Map<string, HubThreadSummary[]>();
  for (const t of hubThreads) {
    const key = t.connectorId ?? 'unknown';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(t);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="hub-list-modal"
    >
      <div className="bg-cafe-surface rounded-2xl shadow-xl w-[520px] max-h-[80vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-cafe-subtle">
          <div className="flex items-center gap-2.5">
            <HubIcon className="w-5 h-5 text-blue-600" />
            <span className="text-lg font-semibold text-cafe">IM Hub</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-cafe-muted hover:text-cafe-secondary transition-colors"
            data-testid="hub-list-close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex border-b border-cafe-subtle px-6" data-testid="hub-tabs">
          <button
            type="button"
            onClick={() => setActiveTab('threads')}
            className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
              activeTab === 'threads' ? 'text-blue-600' : 'text-cafe-secondary hover:text-cafe-secondary'
            }`}
            data-testid="hub-tab-threads"
          >
            系统对话中心
            {activeTab === 'threads' && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 rounded-full" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('config')}
            className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
              activeTab === 'config' ? 'text-blue-600' : 'text-cafe-secondary hover:text-cafe-secondary'
            }`}
            data-testid="hub-tab-config"
          >
            平台配置
            {activeTab === 'config' && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 rounded-full" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('permissions')}
            className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
              activeTab === 'permissions' ? 'text-blue-600' : 'text-cafe-secondary hover:text-cafe-secondary'
            }`}
            data-testid="hub-tab-permissions"
          >
            群聊权限
            {activeTab === 'permissions' && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 rounded-full" />
            )}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {activeTab === 'permissions' ? (
            <div className="space-y-3">
              <div className="flex gap-1.5" data-testid="perm-connector-selector">
                {GROUP_CONNECTORS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setPermConnector(c.id)}
                    className={`px-3 py-1 text-xs rounded-full transition-colors ${
                      permConnector === c.id
                        ? 'bg-blue-500 text-white'
                        : 'bg-cafe-surface-elevated text-cafe-secondary hover:bg-cafe-surface-elevated'
                    }`}
                    data-testid={`perm-connector-${c.id}`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              <HubPermissionsTab
                key={permConnector}
                connectorId={permConnector}
                connectorLabel={GROUP_CONNECTORS.find((c) => c.id === permConnector)?.label ?? permConnector}
              />
            </div>
          ) : activeTab === 'threads' ? (
            <div className="space-y-4">
              {isLoading ? (
                <p className="text-center text-cafe-muted py-8 text-sm">加载中...</p>
              ) : loadError ? (
                <div
                  className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
                  role="alert"
                  data-testid="hub-list-error"
                >
                  {loadError}
                </div>
              ) : hubThreads.length === 0 ? (
                <p className="text-center text-cafe-muted py-8 text-sm">
                  还没有 IM Hub。从飞书/Telegram 发送消息建立绑定后，命令将自动路由到专用 Hub thread。
                </p>
              ) : (
                Array.from(grouped.entries()).map(([connectorId, threads]) => (
                  <div key={connectorId}>
                    <div className="text-xs font-semibold text-cafe-secondary uppercase tracking-wide mb-2">
                      {CONNECTOR_LABELS[connectorId] ?? connectorId} Hub
                    </div>
                    <div className="space-y-2">
                      {threads.map((t) => {
                        const isCurrent = t.id === currentThreadId;
                        return (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => handleNavigate(t.id)}
                            disabled={isCurrent}
                            className={`w-full text-left p-3 rounded-xl border transition-colors ${
                              isCurrent
                                ? 'border-blue-300 bg-blue-50 opacity-60 cursor-default'
                                : 'border-cafe bg-cafe-surface-elevated hover:bg-cafe-surface-elevated'
                            }`}
                            data-testid={`hub-item-${t.id}`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-[15px] font-medium text-cafe">
                                {t.title ?? `${CONNECTOR_LABELS[connectorId] ?? connectorId} IM Hub`}
                              </span>
                              {isCurrent && (
                                <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-blue-100 text-blue-700">
                                  当前
                                </span>
                              )}
                            </div>
                            {t.externalChatId && (
                              <div className="text-xs text-cafe-muted mt-1 truncate">{t.externalChatId}</div>
                            )}
                            {t.lastCommandAt && (
                              <div className="text-xs text-cafe-muted mt-0.5">
                                最近命令 {formatRelativeTime(t.lastCommandAt)}
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : (
            <HubConnectorConfigTab />
          )}
        </div>
      </div>
    </div>
  );
}
