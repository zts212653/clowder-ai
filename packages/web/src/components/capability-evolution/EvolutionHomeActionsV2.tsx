import { useId, useState } from 'react';
import { CafeIcon } from '@/components/rich/CafeIcons';
import { HelpTip } from '@/components/settings/HelpTip';
import { StartEvolution } from './StartEvolution';

export function EvolutionHomeActionsV2({
  targetThreadId,
  reload,
}: {
  targetThreadId: string | null;
  reload: () => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const formId = useId();
  return (
    <>
      <header className="evolution-v2-home-heading">
        <div className="evolution-v2-home-title">
          <h1 className="evolution-title">能力进化</h1>
          <HelpTip topic="能力进化">
            从一个目标开始，保留改进方案、判断依据和后续沿用的来源。提交草案、同意改动和验证有效是不同的状态。
          </HelpTip>
        </div>
        <div className="evolution-v2-home-actions">
          <button type="button" className="evolution-link" onClick={() => void reload()}>
            刷新
          </button>
          <button
            type="button"
            className="evolution-primary"
            aria-expanded={creating}
            aria-controls={formId}
            onClick={() => setCreating(!creating)}
          >
            <CafeIcon name="chat" className="h-4 w-4" />
            新建目标
          </button>
        </div>
      </header>
      <div id={formId} hidden={!creating} className="evolution-v2-start">
        <StartEvolution key={targetThreadId ?? 'unbound'} targetThreadId={targetThreadId} />
      </div>
    </>
  );
}
