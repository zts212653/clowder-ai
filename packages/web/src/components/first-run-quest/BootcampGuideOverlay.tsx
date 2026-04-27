'use client';

import { LifecyclePhaseTip, type LifecycleTipConfig } from './LifecyclePhaseTip';

interface BootcampGuideOverlayProps {
  catName?: string;
  phase: string;
  hasMessages?: boolean;
}

const PHASE_TIPS: Record<string, (catName: string) => string> = {
  'phase-1-intro': (cat) => `在下方输入框输入 @${cat} 你好  开始训练营`,
  'phase-2-env-check': (cat) => `${cat} 正在检查你的开发环境...`,
  'phase-3-config-help': (cat) => `跟着 ${cat} 的指引完成配置`,
};

const LIFECYCLE_TIPS: Record<string, LifecycleTipConfig> = {
  'phase-5-kickoff': { icon: '\u{1F680}', text: '告诉猫猫你想做什么项目，TA 会帮你分析和拆解需求', variant: 'blue' },
  'phase-6-design': { icon: '\u{1F3A8}', text: '猫猫会给出设计方案，选择你喜欢的然后继续', variant: 'purple' },
  'phase-7-dev': { icon: '\u{1F4BB}', text: '猫猫正在开发，遇到关键决策会问你', variant: 'amber' },
  'phase-8-collab': { icon: '\u{1F50D}', text: '多猫协作中，队友正在 review 代码', variant: 'blue' },
  'phase-9-complete': { icon: '\u2705', text: 'Review 通过，准备合入主分支', variant: 'green' },
  'phase-10-retro': { icon: '\u{1F4DD}', text: '和猫猫一起回顾这个项目，看看学到了什么', variant: 'amber' },
  'phase-11-farewell': { icon: '\u{1F393}', text: '恭喜完成训练营！你已经掌握了多猫协作的基本流程', variant: 'green' },
};

export function BootcampGuideOverlay({ catName, phase, hasMessages }: BootcampGuideOverlayProps) {
  const lifecycleTip = LIFECYCLE_TIPS[phase];
  if (lifecycleTip) {
    return <LifecyclePhaseTip phase={phase} config={lifecycleTip} />;
  }

  if (hasMessages) return null;
  const cat = catName ?? '猫猫';
  const tipFn = PHASE_TIPS[phase];
  if (!tipFn) return null;
  const tip = tipFn(cat);

  return (
    <>
      {/* Full-screen overlay with input punch-through */}
      <div className="fixed inset-0 z-[60] bg-black/30" style={{ pointerEvents: 'auto' }} />
      <style>{`[data-bootcamp-step="chat-input"] { position: relative; z-index: 65 !important; }`}</style>
      <div className="pointer-events-none fixed bottom-24 left-1/2 -translate-x-1/2 z-[66]">
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-3 shadow-xl animate-fade-in">
          <div className="flex items-center gap-2">
            <span className="text-lg">👇</span>
            <span className="text-sm font-medium text-amber-800">{tip}</span>
          </div>
        </div>
      </div>
    </>
  );
}
