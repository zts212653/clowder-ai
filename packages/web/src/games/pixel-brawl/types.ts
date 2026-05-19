export type FighterId = 'opus46' | 'opus45' | 'codex' | 'gpt54';
export type FighterState = 'idle' | 'run' | 'jump' | 'attack' | 'hurt' | 'skill';
export type Facing = 'left' | 'right';
export type GameMode = 'pvai' | 'aivai';

export const ALL_FIGHTER_IDS: readonly FighterId[] = ['opus46', 'opus45', 'codex', 'gpt54'];

export interface Fighter {
  id: FighterId;
  name: string;
  teamColor: string;
  hp: number;
  maxHp: number;
  x: number;
  y: number;
  facing: Facing;
  state: FighterState;
  attackCooldownMs: number;
  /** true while the current swing has already landed a hit */
  hitLanded: boolean;
  /** remaining cooldown for special skill */
  skillCooldownMs: number;
  /** remaining duration of active skill effect */
  skillActiveMs: number;
  /** remaining stun duration (from opponent skill) */
  stunMs: number;
}

export interface GameConfig {
  width: 640;
  height: 360;
  zoom: 2;
  seed: number;
  mode: GameMode;
}

export interface HitResult {
  attackerId: FighterId;
  defenderId: FighterId;
  damage: number;
  knockback: number;
}

export const TEAM_COLORS: Record<FighterId, string> = {
  opus46: '#2C57A6',
  opus45: '#79C9FF',
  codex: '#2FA56E',
  gpt54: '#D7AB43',
};

export const FIGHTER_NAMES: Record<FighterId, string> = {
  opus46: 'OPUS 4.6',
  opus45: 'OPUS 4.5',
  codex: 'CODEX',
  gpt54: 'GPT 5.4',
};

export const PALETTE = {
  ink: '#111318',
  slate: '#1E2430',
  steel: '#3A4658',
  bone: '#E8DFC7',
  danger: '#D84E3B',
  flash: '#F1E28A',
  dj: '#8D6BFF',
} as const;

export const GROUND_Y = 300;
export const ATTACK_COOLDOWN_MS = 650; // R4 tuning: longer window between swings
export const ATTACK_RANGE = 55; // was 60 — slightly tighter
export const HURT_DURATION_MS = 300;
export const KNOCKBACK_FORCE = 100; // was 120 — less ping-pong

// --- Skill System ---

export type SkillId =
  | 'architecture_lock' // 宪宪 4.6 — 架构禁锢
  | 'logic_threads' // 宪宪 4.5 — 逻辑丝线
  | 'code_flood' // 砚砚 Codex — 代码洪流
  | 'golden_review'; // 砚砚 GPT-5.4 — 金级 Review

export interface SkillDef {
  id: SkillId;
  name: string;
  cooldownMs: number;
  durationMs: number; // 0 = instant
  damage: number;
  range: number;
}

export const SKILLS: Record<SkillId, SkillDef> = {
  architecture_lock: {
    id: 'architecture_lock',
    name: '架构禁锢',
    cooldownMs: 8000,
    durationMs: 2000,
    damage: 5,
    range: 80,
  },
  logic_threads: {
    id: 'logic_threads',
    name: '逻辑丝线',
    cooldownMs: 6000,
    durationMs: 1500,
    damage: 15,
    range: 70,
  },
  code_flood: {
    id: 'code_flood',
    name: '代码洪流',
    cooldownMs: 7000,
    durationMs: 0,
    damage: 12,
    range: 100,
  },
  golden_review: {
    id: 'golden_review',
    name: '金级 Review',
    cooldownMs: 9000,
    durationMs: 1000,
    damage: 18,
    range: 90,
  },
};

export interface FighterStatsDef {
  skillId: SkillId;
  moveSpeed: number;
  attackDamage: number;
}

export const FIGHTER_STATS: Record<FighterId, FighterStatsDef> = {
  opus46: { skillId: 'architecture_lock', moveSpeed: 150, attackDamage: 7 },
  opus45: { skillId: 'logic_threads', moveSpeed: 140, attackDamage: 8 },
  codex: { skillId: 'code_flood', moveSpeed: 170, attackDamage: 6 },
  gpt54: { skillId: 'golden_review', moveSpeed: 155, attackDamage: 9 },
};
