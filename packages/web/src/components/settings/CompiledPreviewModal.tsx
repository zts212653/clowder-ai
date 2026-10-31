'use client';

/**
 * F237 — Client injection preview modal with scenario dimensions.
 * Two dimensions: scenario (首轮/后续轮/Handoff后) × content (系统提示词/用户消息).
 * Content adapts to native-L0 vs non-native clients automatically.
 *
 * Data comes from /api/prompt-injection/compiled-preview.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '@/utils/api-client';
import { SettingsText } from './primitives';

interface CompiledPreviewData {
  catId: string;
  systemPrompt: string;
  dynamicContext: string;
  bootstrapContext: string;
  userInput: string;
  nativePackContext?: string;
  isNativeL0: boolean;
  clientId: string;
  staticLength: number;
  staticLines: number;
  hasPackBlocks?: boolean;
}

type Scenario = 'first-turn' | 'subsequent' | 'after-handoff';
type TabId = 'system' | 'message';

const SCENARIOS: readonly { id: Scenario; label: string }[] = [
  { id: 'first-turn', label: '首次发送' },
  { id: 'subsequent', label: '后续轮' },
  { id: 'after-handoff', label: 'Handoff 后' },
];

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'system', label: '系统提示词' },
  { id: 'message', label: '用户消息' },
];

const SEP = `\n\n${'─'.repeat(56)}\n\n`;

interface CompiledPreviewModalProps {
  catId: string;
  catName: string;
  onClose: () => void;
}

async function fetchPreview(
  catId: string,
  signal: AbortSignal,
): Promise<{ data?: CompiledPreviewData; error?: string }> {
  const res = await apiFetch(`/api/prompt-injection/compiled-preview?catId=${encodeURIComponent(catId)}`);
  if (signal.aborted) return {};
  if (!res.ok) {
    const body = (await res.json()) as { error?: string };
    return { error: body.error ?? '加载失败' };
  }
  return { data: (await res.json()) as CompiledPreviewData };
}

export function CompiledPreviewModal({ catId, catName, onClose }: CompiledPreviewModalProps) {
  const [data, setData] = useState<CompiledPreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scenario, setScenario] = useState<Scenario>('first-turn');
  const [activeTab, setActiveTab] = useState<TabId>('system');

  useEffect(() => {
    const ac = new AbortController();
    fetchPreview(catId, ac.signal)
      .then((r) => {
        if (ac.signal.aborted) return;
        if (r.error) setError(r.error);
        else if (r.data) setData(r.data);
      })
      .catch(() => {
        if (!ac.signal.aborted) setError('网络错误');
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [catId]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const handleBackdrop = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const content = useMemo(() => {
    if (!data) return null;
    const { isNativeL0, systemPrompt, dynamicContext, bootstrapContext, userInput, nativePackContext } = data;

    // ── System prompt: what goes into the system role channel ──
    let sys: string | null;
    if (!isNativeL0) {
      // Non-native (Gemini etc.): no separate system channel, all via user message
      sys = null;
    } else if (scenario === 'subsequent') {
      // Native L0 subsequent: already injected at session init, not re-sent
      sys = null;
    } else {
      // Native L0 first-turn or after-handoff: full system prompt
      sys = systemPrompt;
    }

    // ── User message: what gets prepended to the user's actual input ──
    const msgParts: string[] = [];
    if (isNativeL0 && scenario !== 'subsequent' && nativePackContext) {
      msgParts.push(nativePackContext);
    }
    if (!isNativeL0 && scenario !== 'subsequent') {
      // Non-native first-turn / after-handoff: system prompt prepended into user message.
      // Subsequent turns: runtime gates via injectSystemPrompt (no re-injection).
      msgParts.push(systemPrompt);
    }
    if (scenario === 'after-handoff') {
      msgParts.push(bootstrapContext);
    }
    msgParts.push(dynamicContext, userInput);

    return { system: sys, message: msgParts.join(SEP) };
  }, [data, scenario]);

  const tabCls = (active: boolean) =>
    `rounded-lg px-3 py-1.5 text-xs font-medium transition ${
      active ? 'bg-[var(--console-active-bg)] text-cafe' : 'text-cafe-muted hover:text-cafe-secondary'
    }`;

  const backdrop = (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop click-to-dismiss is standard UX
    <div
      role="presentation"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm"
      onClick={handleBackdrop}
      onKeyDown={() => {}}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="compiled-preview-title"
        className="relative flex max-h-[calc(100vh-32px)] w-full max-w-[780px] flex-col overflow-hidden rounded-2xl bg-[var(--console-card-bg)] p-[26px] shadow-[0_20px_48px_rgba(43,33,26,0.14)]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={() => {}}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center gap-[14px]">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--console-active-bg)] text-lg font-bold text-[var(--console-modal-title)]">
            👁
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="compiled-preview-title" className="text-xl font-bold text-cafe">
              {catName} 注入内容预览
            </h2>
            {data && (
              <SettingsText as="p" variant="xs" tone="muted">
                {data.staticLines} 行 · {data.staticLength} 字符
                {data.isNativeL0 ? '' : ' · 无独立系统提示词通道'}
              </SettingsText>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-base text-cafe-muted transition hover:bg-[var(--console-modal-close-bg)] hover:text-[var(--console-modal-close-fg)]"
          >
            ✕
          </button>
        </div>

        {/* Navigation: two dimensions on separate rows */}
        <div className="mt-3 shrink-0 space-y-2">
          <div className="flex items-center gap-2">
            <SettingsText as="span" variant="xs" tone="muted" className="w-10 shrink-0">
              时机
            </SettingsText>
            <nav className="flex gap-1" aria-label="时机">
              {SCENARIOS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setScenario(s.id)}
                  className={tabCls(scenario === s.id)}
                >
                  {s.label}
                </button>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <SettingsText as="span" variant="xs" tone="muted" className="w-10 shrink-0">
              位置
            </SettingsText>
            <nav className="flex gap-1" aria-label="位置">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveTab(t.id)}
                  className={tabCls(activeTab === t.id)}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          </div>
        </div>

        {/* Body */}
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-2xl bg-[var(--console-panel-bg)] p-4">
          {/* Annotation legend — separators are display-only, not injected */}
          <div
            className="mb-3 flex items-center gap-2 rounded-lg px-3 py-2"
            style={{ backgroundColor: 'var(--console-elevated-bg)', opacity: 0.85 }}
          >
            <span className="shrink-0 text-xs">ℹ</span>
            <SettingsText as="p" variant="xs" tone="muted">
              ──── 分隔线是预览注释，标注各注入段的边界，实际注入时不包含。
            </SettingsText>
          </div>
          {loading && (
            <SettingsText as="p" variant="xs" tone="muted">
              编译中...
            </SettingsText>
          )}
          {error && (
            <SettingsText as="p" variant="xs" tone="red">
              {error}
            </SettingsText>
          )}
          {content &&
            (activeTab === 'system' && content.system === null ? (
              <SettingsText as="p" variant="sm" tone="muted" className="py-8 text-center">
                无注入内容
              </SettingsText>
            ) : (
              <pre
                className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6"
                style={{ color: 'var(--cafe-text-secondary)' }}
              >
                {activeTab === 'system' ? content.system : content.message}
              </pre>
            ))}
        </div>
      </div>
    </div>
  );

  return createPortal(backdrop, document.body);
}
