'use client';

import { useEffect } from 'react';
import { API_URL } from '@/utils/api-client';

let established = false;

export function SessionBootstrap() {
  useEffect(() => {
    if (established) return;
    established = true;
    fetch(`${API_URL}/api/session`, { credentials: 'include' }).catch(() => {});
  }, []);
  return null;
}
