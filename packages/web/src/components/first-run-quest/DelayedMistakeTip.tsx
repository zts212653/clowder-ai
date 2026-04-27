'use client';

import { useEffect, useRef, useState } from 'react';

interface DelayedMistakeTipProps {
  catName?: string;
  onVisible?: () => void;
}

export function DelayedMistakeTip({ catName, onVisible }: DelayedMistakeTipProps) {
  const [visible, setVisible] = useState(false);
  const cat = catName ?? '猫猫';
  // Ref-based callback: avoids resetting the 1.5s timer when parent re-renders
  // with a new callback reference.
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!visible || !onVisibleRef.current) return;
    const timer = setTimeout(() => onVisibleRef.current?.(), 1500);
    return () => clearTimeout(timer);
  }, [visible]);

  if (!visible) return null;

  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[66] pointer-events-none">
      <div className="rounded-xl border border-orange-300 bg-orange-50 px-5 py-3 shadow-xl animate-fade-in">
        <div className="flex items-center gap-2">
          <span className="text-lg">🤔</span>
          <span className="text-sm font-medium text-orange-800">
            似乎{cat}执行的不是那么合适…… 让我们再来一只猫猫监督 TA 干活吧！
          </span>
        </div>
      </div>
    </div>
  );
}
