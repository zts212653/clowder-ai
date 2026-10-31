/** Transient UI navigation to the one v2 consumer. This carries no approval state or authority. */
export const MAILBOX_NAVIGATE_EVENT = 'cat-cafe:mailbox-navigate';
export type MailboxSection = 'pending' | 'history' | 'tools' | 'records' | 'ignored';
export interface MailboxNavigation {
  section: MailboxSection;
  proposalId?: string | null;
}
export function openMailbox(input: MailboxNavigation = { section: 'pending' }): void {
  window.dispatchEvent(new CustomEvent(MAILBOX_NAVIGATE_EVENT, { detail: input }));
}
