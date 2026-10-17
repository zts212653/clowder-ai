'use client';

import { useCallback } from 'react';
import { useOptionalConfirm } from '../../useConfirm';

/**
 * F202 W2-3 h1: an action whose manifest declares `confirm` must be confirmed by the owner before
 * every invocation, in the shared Console dialog rather than a browser prompt. A row's own
 * `confirm` may replace the wording, or ask where the action declares none, but it never removes
 * the step. With no dialog available the confirmation fails closed and nothing is invoked.
 */
export function useActionConfirmation() {
  const confirm = useOptionalConfirm();
  return useCallback(
    async (label: string, declared?: string, rowWording?: string): Promise<boolean> => {
      const message = rowWording ?? declared;
      if (message === undefined) return true;
      if (!confirm) return false;
      return confirm({ title: label, message, variant: 'danger' });
    },
    [confirm],
  );
}

/**
 * The check every renderer's request function applies before it sends anything. An action that
 * declares a confirmation is only sent right after the owner confirmed it; the Host never sends
 * one on its own — not when it mounts, refreshes, polls or follows `next`.
 */
export function invocationAllowed(declared: string | undefined, confirmed: boolean): boolean {
  return declared === undefined || confirmed;
}

/** Why the Host did not run an action by itself. */
export function awaitingOwnerMessage(label: string): string {
  return `“${label}” asks for your confirmation, so the Console does not run it on its own.`;
}
