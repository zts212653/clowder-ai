'use client';

import { useEffect, useState } from 'react';

export function useCollectiveActionRef(): string {
  const [actionRef, setActionRef] = useState(currentActionRef);
  useEffect(() => {
    const onPopState = () => setActionRef(currentActionRef());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  return actionRef;
}

function currentActionRef(): string {
  return typeof window === 'undefined' ? '/collective' : `${window.location.pathname}${window.location.search}`;
}
