import { useLayoutEffect, useState } from 'react';

type Rect = { left: number; top: number; width: number; height: number };

export function EntrySpotlight({ onPair, onBrowse }: { readonly onPair: () => void; readonly onBrowse: () => void }) {
  const [spotlight, setSpotlight] = useState<Rect>();
  useLayoutEffect(() => {
    const target = document.querySelector('[data-guide-pair]');
    if (!target) return;
    const measure = () => {
      const bounds = target.getBoundingClientRect();
      setSpotlight({
        left: bounds.left - 7,
        top: bounds.top - 5,
        width: bounds.width + 14,
        height: bounds.height + 10,
      });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(target);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  return (
    <>
      {spotlight && <div className="demo-spotlight" data-demo="entry-spotlight" style={spotlight} aria-hidden="true" />}
      <section className="demo-caption entry-caption" data-demo="entry-caption" aria-label="带入伙伴引导">
        <h2>先把你的猫带进来</h2>
        <p>它们会在频道里陪你干活，家里的私人对话不会被带出来。</p>
        <div className="demo-caption-actions">
          <button type="button" onClick={onBrowse}>
            先逛逛
          </button>
          <button type="button" onClick={onPair}>
            带猫进来
          </button>
        </div>
      </section>
    </>
  );
}
