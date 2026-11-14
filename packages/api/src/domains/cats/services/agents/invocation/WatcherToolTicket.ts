/** Host-issued, durable, single-use callback admission. Claimed without a receipt is an unknown result, never permission to repeat. */
export interface WatcherToolTicket {
  toolName: string;
  route: string;
  requestHash?: string;
  response?: { statusCode: number; body: string };
}
export type WatcherTicketClaim =
  | { kind: 'claimed' }
  | { kind: 'denied' | 'in_progress' }
  | { kind: 'completed'; response: { statusCode: number; body: string } };

export const WATCHER_TOOL_ROUTES: Readonly<Record<string, readonly string[]>> = {
  cat_cafe_get_thread_context: ['GET /api/callbacks/thread-context'],
  cat_cafe_get_message: ['GET /api/callbacks/get-message'],
  cat_cafe_read_profile: ['GET /api/callbacks/profile'],
  cat_cafe_propose_profile_update: ['POST /api/callbacks/propose-profile-update'],
  cat_cafe_propose_taste: ['POST /api/callbacks/propose-taste'],
  cat_cafe_list_memory_matters: ['GET /api/callbacks/memory-matters'],
  cat_cafe_read_memory_matter: ['GET /api/callbacks/memory-matters/:matterId'],
  cat_cafe_write_memory_matter: ['POST /api/callbacks/memory-matters/write'],
  cat_cafe_offer_suggestion: ['POST /api/callbacks/suggestions'],
  cat_cafe_post_action_receipt: ['POST /api/callbacks/suggestion-receipts'],
  cat_cafe_bring_to_desk: ['POST /api/callbacks/desk-deliveries'],
  cat_cafe_suggestion_facts: ['POST /api/callbacks/suggestion-facts'],
  cat_cafe_watcher_nudge: ['POST /api/callbacks/watcher-nudge'],
};

export function claimWatcherTicket(
  ticket: WatcherToolTicket | undefined,
  route: string,
  requestHash: string,
): WatcherTicketClaim {
  if (!ticket || ticket.route !== route || (ticket.requestHash && ticket.requestHash !== requestHash))
    return { kind: 'denied' };
  if (ticket.response) return { kind: 'completed', response: ticket.response };
  if (ticket.requestHash) return { kind: 'in_progress' };
  ticket.requestHash = requestHash;
  return { kind: 'claimed' };
}
