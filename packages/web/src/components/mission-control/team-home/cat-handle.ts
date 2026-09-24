import type { CatId } from '@cat-cafe/shared';
import type { TeamHomeParticipantId } from './types';

const DISPLAY_NAME_MAP: Record<string, string> = {
  codex: 'Codex',
  kiimi: 'KK',
  claude: 'Claude',
  opus: 'Opus',
  gemini: 'Gemini',
  'co-creator': '铲屎官',
};

export function formatHandle(id: TeamHomeParticipantId): string {
  return `@${id}`;
}

export function formatName(id: TeamHomeParticipantId): string {
  return DISPLAY_NAME_MAP[id] ?? id;
}

export function formatHandleWithName(id: TeamHomeParticipantId): string {
  const name = formatName(id);
  const handle = formatHandle(id);
  return name === handle ? handle : `${name} (${handle})`;
}

export function isHuman(id: TeamHomeParticipantId): boolean {
  return id === 'co-creator';
}

export function toCatId(id: TeamHomeParticipantId): CatId {
  if (isHuman(id)) {
    throw new Error(`Cannot convert human participant ${id} to CatId`);
  }
  return id as CatId;
}
