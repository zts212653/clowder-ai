'use client';

import { DEMO_SCENES } from './demo-script';
import type { OnboardingJourneyState } from './onboarding-journey';

interface DemoStepProps {
  journey: OnboardingJourneyState;
  onPause: () => void;
  onAdvance: () => void;
}

export function DemoStep({ journey, onPause, onAdvance }: DemoStepProps) {
  return (
    <div className="space-y-4 py-4">
      <div className="grid grid-cols-3 gap-2 text-center text-sm">
        {journey.demoParticipants.map((name) => (
          <div key={name} className="rounded-xl border border-[var(--console-border-soft)] p-3">
            🐾<div className="mt-1 font-medium text-cafe">{name}</div>
          </div>
        ))}
      </div>
      <p className="text-sm leading-6 text-cafe-secondary">
        先看三只演示猫如何分工、互相交接并给出结果。演示结束后，你会选择自己的客户端，创建真实团队。
      </p>
      {(() => {
        const scene = DEMO_SCENES[journey.demoScene];
        return (
          <div className="space-y-2 rounded-xl border border-[var(--console-border-soft)] p-4">
            <h4 className="font-semibold text-cafe">{scene.title}</h4>
            <p className="text-sm leading-6 text-cafe-secondary">{scene.body}</p>
            {scene.draft && (
              <p className="rounded-lg bg-cafe-surface p-2 text-sm text-cafe-secondary">初稿：{scene.draft}</p>
            )}
            {scene.review && (
              <p className="rounded-lg bg-conn-amber-bg p-2 text-sm text-conn-amber-text">审查：{scene.review}</p>
            )}
            {scene.improved && (
              <p className="rounded-lg bg-conn-green-bg p-2 text-sm text-conn-green-text">改稿：{scene.improved}</p>
            )}
          </div>
        );
      })()}
      <div className="flex gap-2">
        <button
          data-testid="first-run-demo-pause"
          type="button"
          onClick={onPause}
          className="flex-1 rounded-lg border border-[var(--console-border-soft)] py-2.5 text-sm font-semibold text-cafe-secondary"
        >
          {journey.demoPaused ? '继续' : '暂停'}
        </button>
        <button
          data-testid="first-run-demo-advance"
          type="button"
          onClick={onAdvance}
          disabled={journey.demoPaused || journey.demoScene === 'handoff'}
          className="flex-1 rounded-lg bg-[var(--semantic-warning)] py-2.5 text-sm font-semibold text-[var(--cafe-surface)] disabled:opacity-50"
        >
          {journey.demoScene === 'opening' ? '开始演示' : journey.demoScene === 'improved' ? '进入真实配置' : '下一幕'}
        </button>
      </div>
    </div>
  );
}
