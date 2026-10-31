'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { AccountsResponse, ProfileItem } from '../hub-accounts.types';

/** Both member presentations read the existing account owner, never a demo projection. */
export function useMemberAccounts() {
  const [accounts, setAccounts] = useState<ProfileItem[]>([]);
  useEffect(() => {
    let current = true;
    let requestNumber = 0;
    const readAccounts = () => {
      const request = ++requestNumber;
      void apiFetch('/api/accounts')
        .then(async (response) => {
          if (!response.ok) throw Error('accounts');
          return (await response.json()) as AccountsResponse;
        })
        .then((body) => {
          if (current && request === requestNumber) setAccounts(body.providers);
        })
        .catch(() => {});
    };
    readAccounts();
    window.addEventListener('accounts-changed', readAccounts);
    return () => {
      current = false;
      window.removeEventListener('accounts-changed', readAccounts);
    };
  }, []);
  return accounts;
}
