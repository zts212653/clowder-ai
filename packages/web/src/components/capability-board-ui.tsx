/**
 * Capability Center UI — F041 统一能力中心组件
 *
 * 卡片式手风琴布局，Pencil MCP 定制 icon
 * - 折叠态：名字 + 描述 + 状态灯 + 全局开关
 * - 展开态：MCP → tools, Skill → triggers, 底部 per-cat 开关（按猫族折叠）
 */

'use client';

import { type ReactNode, useState } from 'react';

// ────────── Types ──────────

export interface CapabilityBoardItem {
  id: string;
  type: 'mcp' | 'skill';
  source: 'cat-cafe' | 'external';
  enabled: boolean;
  cats: Record<string, boolean>;
  description?: string;
  triggers?: string[];
  category?: string;
  mounts?: Record<string, boolean>;
  tools?: { name: string; description?: string }[];
  connectionStatus?: 'connected' | 'disconnected' | 'unknown';
}

export interface CatFamily {
  id: string;
  name: string;
  catIds: string[];
}

export interface SkillHealthSummary {
  allMounted: boolean;
  registrationConsistent: boolean;
  unregistered: string[];
  phantom: string[];
}

export interface CapabilityBoardResponse {
  items: CapabilityBoardItem[];
  catFamilies: CatFamily[];
  projectPath: string;
  skillHealth?: SkillHealthSummary;
}

export type ToggleHandler = (
  id: string,
  type: 'mcp' | 'skill',
  enabled: boolean,
  scope?: 'global' | 'cat',
  catId?: string,
) => void;

// ────────── SVG Icons (Pencil MCP design: plug / book-open / puzzle) ──────────

export function McpIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </svg>
  );
}

export function SkillIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

export function ExtensionIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.315 8.685a.98.98 0 0 1 .837-.276c.47.07.802.48.968.925a2.501 2.501 0 1 0 3.214-3.214c-.446-.166-.855-.497-.925-.968a.979.979 0 0 1 .276-.837l1.61-1.61a2.404 2.404 0 0 1 1.705-.707c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.969a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z" />
    </svg>
  );
}

// ────────── Section ──────────

export function CapabilitySection({
  icon,
  title,
  subtitle,
  items,
  catFamilies,
  toggling,
  onToggle,
  onDeleteMcp,
  deletingMcp,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  items: CapabilityBoardItem[];
  catFamilies: CatFamily[];
  toggling: string | null;
  onToggle: ToggleHandler;
  onDeleteMcp?: (id: string, hard: boolean) => void;
  deletingMcp?: string | null;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-6">
      <div className="flex items-center gap-3 mb-3 pl-1">
        {icon}
        <div>
          <h3 className="text-[15px] font-bold text-slate-800 tracking-wide">{title}</h3>
          <p className="text-xs font-medium text-slate-400 mt-0.5">
            {subtitle} · {items.length}
          </p>
        </div>
      </div>
      <div className="space-y-2.5">
        {items.map((item) => (
          <CapabilityCard
            key={`${item.type}:${item.id}`}
            item={item}
            catFamilies={catFamilies}
            toggling={toggling}
            onToggle={onToggle}
            onDelete={onDeleteMcp && item.type === 'mcp' && item.source === 'external' ? onDeleteMcp : undefined}
            isDeleting={deletingMcp === item.id}
          />
        ))}
      </div>
    </div>
  );
}

// ────────── Accordion Card ──────────

function CapabilityCard({
  item,
  catFamilies,
  toggling,
  onToggle,
  onDelete,
  isDeleting,
}: {
  item: CapabilityBoardItem;
  catFamilies: CatFamily[];
  toggling: string | null;
  onToggle: ToggleHandler;
  onDelete?: (id: string, hard: boolean) => void;
  isDeleting?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const isToggling = toggling === `${item.type}:${item.id}`;
  const hasDetails =
    (item.triggers && item.triggers.length > 0) ||
    (item.tools && item.tools.length > 0) ||
    item.type === 'mcp' ||
    catFamilies.length > 0;

  return (
    <div
      className={`rounded-xl border transition-all duration-300 overflow-hidden ${
        expanded
          ? 'border-indigo-300 shadow-md ring-1 ring-indigo-100 bg-cafe-surface/60 backdrop-blur-sm'
          : 'border-slate-200/60 hover:border-indigo-200 hover:shadow shadow-sm bg-cafe-surface/40'
      }`}
    >
      {/* Header */}
      <div className={`flex items-center gap-3 px-4 transition-all duration-300 ${expanded ? 'py-3' : 'py-2.5'}`}>
        <button
          type="button"
          onClick={() => hasDetails && setExpanded((v) => !v)}
          className={`flex-1 min-w-0 flex items-center gap-3 text-left ${hasDetails ? 'cursor-pointer group' : 'cursor-default'}`}
        >
          {hasDetails && (
            <div
              className={`shrink-0 flex items-center justify-center w-6 h-6 rounded-full transition-colors ${
                expanded
                  ? 'bg-indigo-100 text-indigo-600'
                  : 'bg-slate-100 text-slate-400 group-hover:bg-indigo-50 group-hover:text-indigo-500'
              }`}
            >
              <svg
                className={`w-3.5 h-3.5 transition-transform duration-300 ${expanded ? 'rotate-90' : ''}`}
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
          )}
          {!hasDetails && <span className="w-6 shrink-0" />}

          <div className="flex-1 min-w-0 py-0.5">
            <div className="flex items-center gap-2">
              <span
                className={`text-sm font-semibold truncate transition-colors ${
                  expanded ? 'text-indigo-900' : 'text-slate-700'
                }`}
              >
                {item.id}
              </span>
              <TypeBadge type={item.type} />
              {item.connectionStatus && <StatusDot status={item.connectionStatus} />}
            </div>
            {item.description && (
              <p className="text-xs text-slate-500 mt-1 truncate max-w-[90%] font-medium">{item.description}</p>
            )}
          </div>
        </button>

        {/* Global toggle + delete */}
        <div className="shrink-0 pl-2 flex items-center gap-1.5">
          <ToggleSwitch
            enabled={item.enabled}
            disabled={isToggling}
            onChange={(v) => onToggle(item.id, item.type, v)}
          />
          {onDelete && (
            <button
              type="button"
              onClick={() => onDelete(item.id, false)}
              disabled={isDeleting}
              title="禁用此 MCP"
              className="p-1 rounded text-slate-300 hover:text-red-400 hover:bg-red-50
                         transition-colors disabled:opacity-40"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Expanded details */}
      <div
        className={`grid transition-all duration-300 ease-in-out ${
          expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">
          {expanded && (
            <div className="border-t border-indigo-100/50 px-5 py-3.5 bg-gradient-to-br from-indigo-50/50 to-white/50 text-xs text-slate-600 space-y-3">
              {/* Full description */}
              {item.description && (
                <div>
                  <span className="font-medium text-slate-500">描述:</span>
                  <p className="mt-1 text-slate-600 leading-relaxed break-words">{item.description}</p>
                </div>
              )}

              {/* MCP tools */}
              {item.type === 'mcp' && item.tools && item.tools.length > 0 && (
                <div>
                  <span className="font-medium text-cafe-secondary">Tools ({item.tools.length}):</span>
                  <ul className="mt-1 space-y-0.5 ml-3">
                    {item.tools.map((tool) => (
                      <li key={tool.name} className="flex gap-2">
                        <code className="text-purple-600">{tool.name}</code>
                        {tool.description && (
                          <span className="text-cafe-muted leading-relaxed break-words">{tool.description}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {item.type === 'mcp' && (!item.tools || item.tools.length === 0) && (
                <p className="text-slate-400 italic py-1">
                  {item.connectionStatus === 'disconnected'
                    ? '探活失败或服务不可达，请检查 MCP 配置'
                    : item.connectionStatus === 'connected'
                      ? '已连接，但该 MCP 服务没有返回 tools'
                      : '当前未探活（或未对任一猫启用）'}
                </p>
              )}

              {/* Skill triggers */}
              {item.type === 'skill' && item.triggers && item.triggers.length > 0 && (
                <div>
                  <span className="font-medium text-slate-500 mb-2 block">触发词:</span>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {item.triggers.map((t) => (
                      <span
                        key={t}
                        className="px-2 py-1 bg-cafe-surface border border-indigo-100/50 text-indigo-600 rounded-md text-[11px] font-medium shadow-sm"
                      >
                        &quot;{t}&quot;
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {item.type === 'skill' && (!item.triggers || item.triggers.length === 0) && (
                <p className="text-slate-400 italic py-1">无特定触发词，由上下文自动匹配</p>
              )}

              {/* Skill mount status */}
              {item.type === 'skill' && item.source === 'cat-cafe' && item.mounts && (
                <MountStatusBadges mounts={item.mounts} />
              )}

              {/* Per-cat toggles (grouped by family) */}
              {catFamilies.length > 0 && (
                <CatFamilyToggles item={item} catFamilies={catFamilies} toggling={toggling} onToggle={onToggle} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ────────── Per-cat toggles grouped by family ──────────

function CatFamilyToggles({
  item,
  catFamilies,
  toggling,
  onToggle,
}: {
  item: CapabilityBoardItem;
  catFamilies: CatFamily[];
  toggling: string | null;
  onToggle: ToggleHandler;
}) {
  const [openFamily, setOpenFamily] = useState<string | null>(null);

  return (
    <div className="pt-2 border-t border-indigo-100/30">
      <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">启用状态（按猫）</span>
      <div className="mt-1.5 space-y-1">
        {catFamilies.map((family) => {
          const isOpen = openFamily === family.id;
          const relevantCatIds = family.catIds.filter((c) => c in item.cats);
          // For skills: hide families that have no relevant cats to avoid noisy grids.
          if (item.type === 'skill' && relevantCatIds.length === 0) return null;
          const enabledCount = relevantCatIds.filter((c) => item.cats[c]).length;
          return (
            <div key={family.id} className="rounded-lg border border-slate-100 bg-cafe-surface/50">
              <button
                type="button"
                onClick={() => setOpenFamily(isOpen ? null : family.id)}
                className="w-full flex items-center justify-between px-3 py-1.5 text-left"
              >
                <span className="text-[12px] font-medium text-slate-600">{family.name}</span>
                <span className="text-[11px] text-slate-400">
                  {enabledCount}/{relevantCatIds.length}
                  <svg
                    className={`inline-block w-3 h-3 ml-1 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                      clipRule="evenodd"
                    />
                  </svg>
                </span>
              </button>
              {isOpen && (
                <div className="px-3 pb-2 space-y-1">
                  {family.catIds.map((catId) => {
                    // Sparse cats: if a skill is not relevant for a cat (provider mismatch),
                    // the backend omits the key entirely. Render a dash instead of a toggle.
                    if (!(catId in item.cats)) {
                      return (
                        <div key={catId} className="flex items-center justify-between py-0.5">
                          <span className="text-[11px] text-slate-500 font-mono">{catId}</span>
                          <span className="text-[12px] text-slate-300 select-none" title="该 Skill 对此猫不适用">
                            –
                          </span>
                        </div>
                      );
                    }
                    const catEnabled = item.cats[catId] ?? false;
                    const isCatToggling = toggling === `${item.type}:${item.id}:${catId}`;
                    return (
                      <div key={catId} className="flex items-center justify-between py-0.5">
                        <span className="text-[11px] text-slate-500 font-mono">{catId}</span>
                        <ToggleSwitch
                          enabled={catEnabled}
                          disabled={isCatToggling}
                          size="sm"
                          onChange={(v) => onToggle(item.id, item.type, v, 'cat', catId)}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ────────── Sub-components ──────────

function TypeBadge({ type }: { type: 'mcp' | 'skill' }) {
  return (
    <span
      className={`inline-flex items-center justify-center text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider ${
        type === 'mcp'
          ? 'bg-gradient-to-r from-purple-100 to-indigo-100 text-purple-700 border border-purple-200/50'
          : 'bg-gradient-to-r from-blue-100 to-cyan-100 text-blue-700 border border-blue-200/50'
      }`}
    >
      {type === 'mcp' ? 'MCP' : 'Skill'}
    </span>
  );
}

export function StatusDot({ status }: { status: 'connected' | 'disconnected' | 'unknown' }) {
  const color = status === 'connected' ? 'bg-green-400' : status === 'disconnected' ? 'bg-red-400' : 'bg-gray-300';
  const label = status === 'connected' ? '已连接' : status === 'disconnected' ? '掉线' : '未知';
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} title={label} />;
}

function ToggleSwitch({
  enabled,
  disabled,
  size = 'md',
  onChange,
}: {
  enabled: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md';
  onChange: (v: boolean) => void;
}) {
  const isSm = size === 'sm';
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onChange(!enabled);
      }}
      disabled={disabled}
      className={`rounded-full relative transition-[background-color,opacity] duration-300 ease-in-out shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-500 box-content border-[3px] border-transparent ${
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:opacity-90'
      } ${enabled ? 'bg-indigo-500' : 'bg-slate-200'} ${isSm ? 'w-7 h-3.5' : 'w-10 h-5'}`}
    >
      <span
        className={`absolute top-0 rounded-full bg-cafe-surface shadow-sm ring-1 ring-black/5 transition-transform duration-300 ease-in-out flex items-center justify-center ${isSm ? 'w-3.5 h-3.5' : 'w-5 h-5'} ${
          enabled ? (isSm ? 'translate-x-[14px]' : 'translate-x-[20px]') : 'translate-x-0'
        }`}
      >
        {enabled && !isSm && (
          <svg className="w-2.5 h-2.5 text-indigo-500 drop-shadow-sm" viewBox="0 0 12 12" fill="none">
            <path
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3.5 6.5l2 2 3-4"
            />
          </svg>
        )}
      </span>
    </button>
  );
}

/** Mount status badges for cat-cafe skills (provider list is explicit for stable ordering). */
function MountStatusBadges({ mounts }: { mounts: Record<string, boolean> }) {
  const providers = [
    { key: 'claude', label: 'Claude' },
    { key: 'codex', label: 'Codex' },
    { key: 'gemini', label: 'Gemini' },
    { key: 'kimi', label: 'Kimi' },
  ];
  return (
    <div>
      <span className="font-medium text-slate-500 mb-1.5 block">挂载状态:</span>
      <div className="flex flex-wrap gap-1.5">
        {providers.map(({ key, label }) => {
          const ok = mounts[key] ?? false;
          return (
            <span
              key={key}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border ${
                ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200/50' : 'bg-red-50 text-red-600 border-red-200/50'
              }`}
            >
              {ok ? (
                <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none">
                  <path
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 6.5l2 2 4-4.5"
                  />
                </svg>
              ) : (
                <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none">
                  <path stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M3.5 3.5l5 5M8.5 3.5l-5 5" />
                </svg>
              )}
              {label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Skill health summary banner (allMounted + registrationConsistent) */
export function SkillHealthBanner({ health, items }: { health: SkillHealthSummary; items?: CapabilityBoardItem[] }) {
  const allGood = health.allMounted && health.registrationConsistent;

  // Find skills with mount failures for detail display
  const mountFailures = (items ?? [])
    .filter((i) => i.type === 'skill' && i.source === 'cat-cafe' && i.mounts)
    .filter((i) => !Object.values(i.mounts!).every(Boolean))
    .map((i) => ({
      id: i.id,
      failed: Object.entries(i.mounts!)
        .filter(([, ok]) => !ok)
        .map(([provider]) => provider),
    }));

  return (
    <div
      className={`flex items-start gap-2.5 rounded-lg px-3.5 py-2.5 text-xs border ${
        allGood
          ? 'bg-emerald-50/60 border-emerald-200/40 text-emerald-700'
          : 'bg-amber-50/60 border-amber-200/40 text-amber-700'
      }`}
    >
      <span className="text-base leading-none mt-0.5">{allGood ? '✓' : '!'}</span>
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <span className={health.allMounted ? 'text-emerald-600' : 'text-amber-600'}>
            {health.allMounted ? '全部正确挂载' : '部分挂载异常'}
          </span>
          <span className="text-slate-300">·</span>
          <span className={health.registrationConsistent ? 'text-emerald-600' : 'text-amber-600'}>
            {health.registrationConsistent ? '注册一致' : '注册不一致'}
          </span>
        </div>
        {mountFailures.length > 0 && (
          <div className="space-y-0.5 text-amber-600/80">
            {mountFailures.map((f) => (
              <p key={f.id}>
                <code className="text-[10px] bg-amber-100/50 px-1 rounded">{f.id}</code> — {f.failed.join(', ')} 未挂载
              </p>
            ))}
          </div>
        )}
        {health.unregistered.length > 0 && (
          <p className="text-amber-600/80">未注册: {health.unregistered.join(', ')}</p>
        )}
        {health.phantom.length > 0 && <p className="text-amber-600/80">幽灵项: {health.phantom.join(', ')}</p>}
      </div>
    </div>
  );
}

export function FilterChips({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-cafe-secondary">{label}:</span>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
            value === opt.value
              ? 'bg-blue-50 border-blue-300 text-blue-700'
              : 'border-cafe text-cafe-secondary hover:border-cafe'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ────────── Section Icon Wrappers (Pencil MCP design) ──────────

export function SectionIconMcp() {
  return (
    <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-50 to-indigo-100/50 border border-indigo-100/50 shadow-sm">
      <McpIcon className="w-4 h-4 text-indigo-500" />
    </div>
  );
}

export function SectionIconSkill() {
  return (
    <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-amber-50 to-yellow-100/50 border border-amber-100/50 shadow-sm">
      <SkillIcon className="w-4 h-4 text-amber-600" />
    </div>
  );
}

export function SectionIconExtension() {
  return (
    <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-50 to-green-100/50 border border-emerald-100/50 shadow-sm">
      <ExtensionIcon className="w-4 h-4 text-emerald-600" />
    </div>
  );
}
