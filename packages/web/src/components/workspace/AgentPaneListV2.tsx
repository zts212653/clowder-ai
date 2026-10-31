'use client';

import { CatAvatar } from '@/components/CatAvatar';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useCatData } from '@/hooks/useCatData';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import typographyTokens from '@/styles/typography-tokens.json';
import type { AgentPaneSelectionMeta } from './AgentPaneList';
import { codeToolsCopy } from './code-tools.shell-copy';
import { useAgentPanes } from './useAgentPanes';

interface AgentPaneListV2Props {
  worktreeId: string;
  onSelectPane: (paneId: string, meta?: AgentPaneSelectionMeta) => void;
  selectedPaneId?: string;
}

const STATUS_COLORS = {
  running: 'var(--terminal-status-ok)',
  crashed: 'var(--terminal-status-error)',
  done: 'var(--terminal-text-muted)',
} as const;

/**
 * F322 v2（北极星 §1.13 代码 6b）：猫的终端窗格写猫的名字和头像，编号留在名字后面。
 * 猫身份来自终端域在 spawn 时写入 pane 注册的 catId（done/crashed 终态也保留）；
 * 老注册或缺失时回落编号，不捏造身份。
 *
 * 列表在 Workspace chrome（浅/暗主题）上，不在深色终端区内——身份文字、编号与选中态
 * 必须用主题语义 token（--cafe-*），不能用永远深色的 --terminal-* 调色板（ROOT 2617：
 * 浅色 chrome 上 --terminal-fg 的猫名几乎不可读）。
 */
export function AgentPaneListV2({ worktreeId, onSelectPane, selectedPaneId }: AgentPaneListV2Props) {
  const panes = useAgentPanes(worktreeId);
  const { getCatById } = useCatData();
  const copy = useShellCopy(codeToolsCopy).terminal;

  if (panes.length === 0) return null;

  const statusLabel = (s: 'running' | 'done' | 'crashed') =>
    s === 'running' ? copy.paneRunning : s === 'crashed' ? copy.paneCrashed : copy.paneDone;

  return (
    <div style={{ borderBottom: '1px solid var(--cafe-border-subtle)', padding: '4px 0' }}>
      <div
        style={{
          padding: '2px 8px',
          fontSize: typographyTokens.fontSizePx.label,
          color: 'var(--cafe-text-muted)',
          fontWeight: 600,
        }}
      >
        {copy.catPanes(panes.length)}
      </div>
      {panes.map((pane) => {
        const catId = pane.catId ?? null;
        const displayName = catId ? resolveCatDisplayName(catId, getCatById) : null;
        return (
          <button
            key={pane.invocationId}
            type="button"
            onClick={() => onSelectPane(pane.paneId, { invocationId: pane.invocationId, catId })}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              width: '100%',
              padding: '4px 8px',
              fontSize: typographyTokens.fontSizePx.xs,
              background: selectedPaneId === pane.paneId ? 'var(--cafe-surface-sunken)' : 'transparent',
              border: 'none',
              color: 'var(--cafe-text)',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: STATUS_COLORS[pane.status],
                flexShrink: 0,
              }}
            />
            {catId && <CatAvatar catId={catId} size={16} ring="none" />}
            <span
              style={{
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {displayName ?? pane.invocationId.slice(0, 8)}
              {displayName && (
                <span
                  style={{
                    color: 'var(--cafe-text-muted)',
                    marginLeft: 4,
                    fontSize: typographyTokens.fontSizePx.micro,
                  }}
                >
                  {pane.invocationId.slice(0, 8)}
                </span>
              )}
            </span>
            <span style={{ fontSize: typographyTokens.fontSizePx.micro, color: 'var(--cafe-text-muted)' }}>
              {statusLabel(pane.status)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
