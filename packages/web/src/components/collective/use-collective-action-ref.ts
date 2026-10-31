'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

export function useCollectiveActionRef(): string {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [browserActionRef, setBrowserActionRef] = useState(currentActionRef);
  useEffect(() => {
    const onPopState = () => setBrowserActionRef(currentActionRef());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Next can render the destination before it commits window.location, and its
  // client navigation does not fire popstate. Its route snapshot is therefore
  // the authority inside the App Router; the browser fallback keeps isolated
  // consumers and native history transitions working outside that provider.
  if (pathname !== '/collective') return browserActionRef;
  const search = searchParams?.toString();
  return search ? `${pathname}?${search}` : pathname;
}

function currentActionRef(): string {
  return typeof window === 'undefined' ? '/collective' : `${window.location.pathname}${window.location.search}`;
}
