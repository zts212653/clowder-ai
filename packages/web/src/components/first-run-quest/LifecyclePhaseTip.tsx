'use client';

import { useEffect, useState } from 'react';

export interface LifecycleTipConfig {
  icon: string;
  text: string;
  variant: 'blue' | 'purple' | 'amber' | 'green';
}

interface LifecyclePhaseTipProps {
  phase: string;
  config: LifecycleTipConfig;
}

export function LifecyclePhaseTip({ phase, config }: LifecyclePhaseTipProps) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(false);
    const timer = setTimeout(() => setDismissed(true), 15_000);
    return () => clearTimeout(timer);
  }, [phase]);

  if (dismissed) return null;

  const border = {
    blue: 'border-conn-blue-ring',
    purple: 'border-conn-purple-ring',
    amber: 'border-conn-amber-ring',
    green: 'border-conn-emerald-ring',
  }[config.variant];
  const background = {
    blue: 'bg-conn-blue-bg',
    purple: 'bg-conn-purple-bg',
    amber: 'bg-conn-amber-bg',
    green: 'bg-conn-emerald-bg',
  }[config.variant];
  const textColor = {
    blue: 'text-conn-blue-text',
    purple: 'text-conn-purple-text',
    amber: 'text-conn-amber-text',
    green: 'text-conn-emerald-text',
  }[config.variant];

  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[66] pointer-events-none">
      <div className={`rounded-xl border ${border} ${background} px-5 py-3 shadow-xl animate-fade-in`}>
        <div className="flex items-center gap-2">
          <span className="text-lg">{config.icon}</span>
          <span className={`text-sm font-medium ${textColor}`}>{config.text}</span>
        </div>
      </div>
    </div>
  );
}
