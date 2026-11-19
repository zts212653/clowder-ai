/**
 * F258 Visible Café — /starry page
 *
 * Full-screen star room view. iPad viewport friendly.
 * Shows the main planet living room with xianxian cat + star window lights.
 *
 * Focused scene page — keeps the global ActivityBar, hides the chat ThreadSidebar,
 * and owns its visible-cafe presence adapter.
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import { CatHomePanel } from '@/components/visible-cafe/cat-home/CatHomePanel';
import { availableHomeCats, pickSkinCat } from '@/components/visible-cafe/cat-home/cat-home-selection';
import { StarryRoom } from '@/components/visible-cafe/StarryRoom';
import { useCatData } from '@/hooks/useCatData';
import { useVisibleCafePresence } from '@/hooks/useVisibleCafePresence';
import type { SkinManifest } from '@/lib/visible-cafe/asset-config';
import { XIANXIAN_SKIN } from '@/lib/visible-cafe/asset-config';
import { getUserId } from '@/utils/userId';

export default function StarryPage() {
  const [skin, setSkin] = useState<SkinManifest | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [homeOpen, setHomeOpen] = useState(false);
  const [selectedCatId, setSelectedCatId] = useState<string | null>(null);
  const { cats } = useCatData();
  const homeCats = useMemo(() => availableHomeCats(cats), [cats]);
  const selectedCat = homeCats.find((cat) => cat.id === selectedCatId) ?? null;

  // Load userId on mount
  useEffect(() => {
    setUserId(getUserId());
  }, []);

  useEffect(() => {
    if (!skin || selectedCat) return;
    setSelectedCatId(pickSkinCat(cats, skin)?.id ?? null);
  }, [cats, selectedCat, skin]);

  // Load skin manifest
  useEffect(() => {
    fetch(XIANXIAN_SKIN.manifest)
      .then((res) => res.json())
      .then((data: SkinManifest) => setSkin(data))
      .catch((err) => console.error('[visible-cafe] Failed to load skin manifest:', err));
  }, []);

  // Connect presence adapter
  useVisibleCafePresence({
    userId,
    enabled: !!userId && !!skin,
  });

  if (!skin) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: '#1a0a2e',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#a090c0',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        Loading starry room...
      </div>
    );
  }

  return (
    <>
      {/* iPad viewport meta */}
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />

      <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
        <StarryRoom skin={skin} onCatHomeOpen={selectedCat ? () => setHomeOpen(true) : undefined} />
        {homeOpen && selectedCat && (
          <CatHomePanel
            cat={selectedCat}
            availableCats={homeCats}
            onSelectCat={setSelectedCatId}
            onClose={() => setHomeOpen(false)}
          />
        )}
      </div>
    </>
  );
}
