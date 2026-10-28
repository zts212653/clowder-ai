import { useEffect, useState } from 'react';
export const RAIL_WIDTH_FALLBACK = 52;
const MOBILE_BREAKPOINT = 768;
/** The panel docks against the rail's right edge; without a rail in the tree (a bare unit render) it uses the rail's width. */
export function useRailEdge(anchor: React.RefObject<HTMLElement | null>): number | null {
  const [edge, setEdge] = useState<number | null>(null);
  useEffect(() => {
    const measure = () => {
      if (window.innerWidth < MOBILE_BREAKPOINT) {
        setEdge(0);
        return;
      }
      const rail = anchor.current?.closest('[data-testid="world-rail"]');
      setEdge(Math.round(rail?.getBoundingClientRect().right || RAIL_WIDTH_FALLBACK));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [anchor]);
  return edge;
}

/** A nested dialog (for example a card's reject-feedback dialog) owns Escape while it is open. */
export function useEscapeToClose(panel: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const otherDialog = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].some(
        (dialog) => dialog !== panel.current,
      );
      if (!otherDialog) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [panel, onClose]);
}

/** Which row is open. A row that left the read is forgotten, not merely hidden: if a later read brings it back it starts closed. */
export function useOpenRow(keys: string[], loading: boolean) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const keysSignature = keys.join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keysSignature stands for keys
  useEffect(() => {
    if (!loading) setExpandedKey((current) => (current !== null && !keys.includes(current) ? null : current));
  }, [keysSignature, loading]);
  const openKey = expandedKey !== null && (loading || keys.includes(expandedKey)) ? expandedKey : null;
  return { openKey, toggle: (key: string) => setExpandedKey(openKey === key ? null : key) };
}
