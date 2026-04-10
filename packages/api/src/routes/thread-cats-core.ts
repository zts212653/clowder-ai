/**
 * Thread cats categorization core — shared by F142 route and TD #408 callback.
 * Single source of truth for participant/routable/notRoutable classification.
 */

export interface ParticipantActivityInput {
  catId: string;
  lastMessageAt: number;
  messageCount: number;
}

export interface CatEntry {
  catId: string;
  displayName: string;
}

export interface ThreadCatsCategorization {
  participants: Array<CatEntry & { lastMessageAt: number; messageCount: number }>;
  routableNow: CatEntry[];
  routableNotJoined: CatEntry[];
  notRoutable: CatEntry[];
}

export interface CategorizeThreadCatsInput {
  participantActivity: ParticipantActivityInput[];
  registeredServices: Map<string, unknown>;
  allCatIds: string[];
  getCatDisplayName: (catId: string) => string;
  isCatAvailable: (catId: string) => boolean;
}

/**
 * Categorize cats for a thread (KD-9 logic).
 * - routableNow: participants with active service + available
 * - routableNotJoined: non-participants with active service + available
 * - notRoutable: non-participants with available=false
 */
export function categorizeThreadCats(input: CategorizeThreadCatsInput): ThreadCatsCategorization {
  const { participantActivity, registeredServices, allCatIds, getCatDisplayName, isCatAvailable } = input;
  const participantIds = new Set(participantActivity.map((p) => p.catId));

  const routableNow: CatEntry[] = [];
  const routableNotJoined: CatEntry[] = [];
  const notRoutable: CatEntry[] = [];

  for (const catId of allCatIds) {
    const hasService = registeredServices.has(catId);
    const available = isCatAvailable(catId);
    const isParticipant = participantIds.has(catId);

    if (!available && !isParticipant) {
      notRoutable.push({ catId, displayName: getCatDisplayName(catId) });
    } else if (hasService && available && !isParticipant) {
      routableNotJoined.push({ catId, displayName: getCatDisplayName(catId) });
    }
  }

  for (const p of participantActivity) {
    if (registeredServices.has(p.catId) && isCatAvailable(p.catId)) {
      routableNow.push({ catId: p.catId, displayName: getCatDisplayName(p.catId) });
    }
  }

  const participants = participantActivity.map((p) => ({
    catId: p.catId,
    displayName: getCatDisplayName(p.catId),
    lastMessageAt: p.lastMessageAt,
    messageCount: p.messageCount,
  }));

  return { participants, routableNow, routableNotJoined, notRoutable };
}
