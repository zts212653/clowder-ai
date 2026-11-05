// Editing is outside this focus regression. Source admission, Home opening,
// scope, keyed preview, gallery and Lightbox remain production components.
export function F307OwnerSurfaceRenderer() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const present = () => setReady(true);
    window.addEventListener('fixture-present-owner', present);
    return () => window.removeEventListener('fixture-present-owner', present);
  }, []);
  return (
    <div data-testid="fixture-admitted-owner">
      {ready ? (
        <img data-testid="workspace-content-review-media" src="/uploads/focus-0.png" alt="原件布局夹具" />
      ) : null}
      <button type="button">原件控件</button>
    </div>
  );
}

import { useEffect, useState } from 'react';
