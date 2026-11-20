'use client';
import type { SessionCacheWarmth } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';

/** Cache information shares no execution dot, color or liveness authority. */
export function SessionCacheStatus({ warmth }: { warmth?: SessionCacheWarmth }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  if (
    !warmth ||
    warmth.source !== 'cache_retention' ||
    warmth.retaining !== true ||
    warmth.status !== 'warm' ||
    warmth.expiresAt === undefined ||
    warmth.expiresAt <= now
  )
    return null;
  return (
    <p className="mt-1 text-xs text-cafe-secondary" title="根据最近一次缓存维护估算，不表示猫正在执行工作。">
      缓存保留至 {new Date(warmth.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </p>
  );
}
