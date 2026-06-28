/* F056 OKLCH Tuner engine — types, INIT defaults, CSS generation, export. */
export interface TierP {
  L: number;
  Cmul: number;
}
export interface FixedP {
  L: number;
  C: number;
}
export interface SurfaceP {
  sunken: number;
  base: number;
  elevated: number;
  canvas: number;
}
export interface ModeP {
  primary: TierP;
  surface: TierP;
  text: TierP;
  inset: TierP;
  ring: TierP;
  insetText: FixedP;
  msgText: FixedP;
  elev: SurfaceP;
}
export interface SemanticP {
  criticalH: number;
  successH: number;
  warningH: number;
  infoH: number;
  L: number;
  C: number;
  surfL: number;
  surfC: number;
}
export interface QueueP {
  H: number;
  C: number;
  L: number;
}
export interface NeutralP {
  textL: number;
  secondaryL: number;
  mutedL: number;
  interactiveL: number;
  borderL: number;
  borderSubtleL: number;
  codeBgL: number;
  codeTextL: number;
}
export type Mode = 'light' | 'dark';
export interface TunerState {
  accentHue: number;
  accentChroma: number;
  surfaceHue: number /* warm beige ~80 (light) / ~30 (dark), independent of accent (KD-34) */;
  surfaceChroma: number /* multiplier on shared --surface-chroma base 0.01, default 1.0 */;
  light: ModeP;
  dark: ModeP;
  semanticLight: SemanticP;
  semanticDark: SemanticP;
  queue: QueueP;
  neutralHue: number;
  neutralChroma: number;
  neutralLight: NeutralP;
  neutralDark: NeutralP;
  /* Cat name text — unified across all cats (not per-cat hue derived) */
  catTextH: number;
  catTextC: number;
  catTextLightL: number;
  catTextDarkL: number;
}
export interface HcOverride {
  on: boolean;
  hue: number;
  chroma: number;
}

/* ── Constants ── */
export const CAT_TIERS = ['primary', 'surface', 'text', 'inset', 'ring'] as const;
export type CatTier = (typeof CAT_TIERS)[number];
export const SURF_KEYS = ['sunken', 'base', 'elevated', 'canvas'] as const;
export const SEMANTIC_KEYS = ['critical', 'success', 'warning', 'info'] as const;
export type SemanticKey = (typeof SEMANTIC_KEYS)[number];
export const SEMANTIC_LABELS: Record<SemanticKey, string> = {
  critical: '危险/错误 (删除/失败)',
  success: '成功/健康 (通过/完成)',
  warning: '警告 (静默/降级)',
  info: '信息/蓝 (跨帖/链接)',
};
export const SEMANTIC_H_FIELD: Record<SemanticKey, keyof SemanticP> = {
  critical: 'criticalH',
  success: 'successH',
  warning: 'warningH',
  info: 'infoH',
};

export const TIER_LABELS: Record<CatTier | 'insetText' | 'msgText', string> = {
  primary: '主色 (图标/头像环)',
  surface: '消息气泡背景',
  text: '猫名文字',
  inset: '嵌套块 (Thinking/CLI)',
  ring: '聚焦环线',
  insetText: '嵌套块文字',
  msgText: '消息文字',
};

export const SURF_LABELS: Record<keyof SurfaceP, string> = {
  sunken: '层 1 · 基底 (L)',
  base: '层 2 · 承载 (L)',
  elevated: '层 3 · 抬升 (L)',
  canvas: '层 4 · 浮出 (L)',
};

export const NEUTRAL_ROWS: [keyof NeutralP, string][] = [
  ['textL', '正文'],
  ['secondaryL', '二级'],
  ['mutedL', '弱/三级'],
  ['interactiveL', '交互'],
  ['borderL', '边框'],
  ['borderSubtleL', '细线'],
  ['codeBgL', '代码底'],
  ['codeTextL', '代码字'],
];

/* ── Per-theme INIT defaults (operator-tuned 2026-06-10) ──
 * Light and Dark themes have different accent hue, inset/msgText tuning,
 * surface elevation, and catText color. INIT = INIT_DARK (migration fallback). */
export const INIT_LIGHT: TunerState = {
  accentHue: 50,
  accentChroma: 0.14,
  surfaceHue: 80,
  surfaceChroma: 1.0,
  light: {
    primary: { L: 0.62, Cmul: 1.0 },
    surface: { L: 0.85, Cmul: 0.45 },
    text: { L: 0.24, Cmul: 0.8 },
    inset: { L: 0.25, Cmul: 0.15 },
    ring: { L: 0.55, Cmul: 1.1 },
    insetText: { L: 0.85, C: 0.03 },
    msgText: { L: 0.25, C: 0.01 },
    elev: { sunken: 0.92, base: 0.95, elevated: 0.99, canvas: 0.995 },
  },
  dark: {
    primary: { L: 0.68, Cmul: 0.85 },
    surface: { L: 0.28, Cmul: 0.25 },
    text: { L: 0.88, Cmul: 0.6 },
    inset: { L: 0.24, Cmul: 0.1 },
    ring: { L: 0.7, Cmul: 1.0 },
    insetText: { L: 0.8, C: 0.02 },
    msgText: { L: 0.8, C: 0.02 },
    elev: { sunken: 0.275, base: 0.18, elevated: 0.1, canvas: 0.18 },
  },
  // biome-ignore format: compact INIT block
  semanticLight: { criticalH: 35, successH: 135, warningH: 45, infoH: 210, L: 0.55, C: 0.12, surfL: 0.96, surfC: 0.03 },
  semanticDark: { criticalH: 25, successH: 145, warningH: 70, infoH: 230, L: 0.7, C: 0.17, surfL: 0.25, surfC: 0.05 },
  queue: { H: 300, C: 0.12, L: 0.5 },
  neutralHue: 30,
  neutralChroma: 0.005,
  neutralLight: {
    textL: 0.2,
    secondaryL: 0.45,
    mutedL: 0.56,
    interactiveL: 0.36,
    borderL: 0.84,
    borderSubtleL: 0.915,
    codeBgL: 0.9,
    codeTextL: 0.19,
  },
  neutralDark: {
    textL: 0.94,
    secondaryL: 0.76,
    mutedL: 0.66,
    interactiveL: 0.84,
    borderL: 0.32,
    borderSubtleL: 0.24,
    codeBgL: 0.2,
    codeTextL: 0.92,
  },
  catTextH: 5,
  catTextC: 0.025,
  catTextLightL: 0.15,
  catTextDarkL: 0.88,
};

export const INIT_DARK: TunerState = {
  accentHue: 35,
  accentChroma: 0.08,
  surfaceHue: 30,
  surfaceChroma: 0.15,
  light: {
    primary: { L: 0.62, Cmul: 1.0 },
    surface: { L: 0.9, Cmul: 0.5 },
    text: { L: 0.24, Cmul: 0.8 },
    inset: { L: 0.3, Cmul: 0.1 },
    ring: { L: 0.55, Cmul: 1.1 },
    insetText: { L: 0.85, C: 0.03 },
    msgText: { L: 0.2, C: 0.005 },
    elev: { sunken: 0.92, base: 0.95, elevated: 0.985, canvas: 0.996 },
  },
  dark: {
    primary: { L: 0.68, Cmul: 0.85 },
    surface: { L: 0.3, Cmul: 0.15 },
    text: { L: 0.88, Cmul: 0.6 },
    inset: { L: 0.24, Cmul: 0.1 },
    ring: { L: 0.7, Cmul: 1.0 },
    insetText: { L: 0.8, C: 0.02 },
    msgText: { L: 0.8, C: 0.04 },
    elev: { sunken: 0.36, base: 0.28, elevated: 0.21, canvas: 0.24 },
  },
  // biome-ignore format: compact INIT block
  semanticLight: { criticalH: 35, successH: 135, warningH: 45, infoH: 210, L: 0.55, C: 0.12, surfL: 0.96, surfC: 0.03 },
  semanticDark: { criticalH: 25, successH: 145, warningH: 70, infoH: 230, L: 0.7, C: 0.17, surfL: 0.25, surfC: 0.05 },
  queue: { H: 290, C: 0.15, L: 0.6 },
  neutralHue: 30,
  neutralChroma: 0.005,
  neutralLight: {
    textL: 0.2,
    secondaryL: 0.45,
    mutedL: 0.56,
    interactiveL: 0.36,
    borderL: 0.84,
    borderSubtleL: 0.915,
    codeBgL: 0.985,
    codeTextL: 0.22,
  },
  neutralDark: {
    textL: 0.95,
    secondaryL: 0.75,
    mutedL: 0.66,
    interactiveL: 0.84,
    borderL: 0.35,
    borderSubtleL: 0.4,
    codeBgL: 0.25,
    codeTextL: 0.9,
  },
  catTextH: 25,
  catTextC: 0.1,
  catTextLightL: 0.24,
  catTextDarkL: 0.95,
};

/** Migration fallback — used by migrateTunerState() when base is unknown. */
export const INIT = INIT_DARK;

/** Select INIT preset matching the theme's base mode. */
export function initForBase(base: 'light' | 'dark'): TunerState {
  return base === 'light' ? INIT_LIGHT : INIT_DARK;
}

export const STYLE_ID = 'oklch-tuner-override';

/** Deep-merge SurfaceP to handle fields added after a user saved their theme. */
function migrateElev(e: Partial<SurfaceP> | undefined, fallback: SurfaceP): SurfaceP {
  if (!e) return fallback;
  return {
    sunken: e.sunken ?? fallback.sunken,
    base: e.base ?? fallback.base,
    elevated: e.elevated ?? fallback.elevated,
    canvas: e.canvas ?? fallback.canvas,
  };
}

/** Patch missing ModeP fields from INIT (forward-compat for schema additions). */
function migrateModeP(m: Partial<ModeP>, fallback: ModeP): ModeP {
  return {
    primary: m.primary ?? fallback.primary,
    surface: m.surface ?? fallback.surface,
    text: m.text ?? fallback.text,
    inset: m.inset ?? fallback.inset,
    ring: m.ring ?? fallback.ring,
    insetText: m.insetText ?? fallback.insetText,
    msgText: m.msgText ?? fallback.msgText,
    elev: migrateElev(m.elev as Partial<SurfaceP> | undefined, fallback.elev),
  };
}

/** Deep-merge NeutralP to handle fields added after a user saved their theme. */
function migrateNeutralP(n: Partial<NeutralP> | undefined, fallback: NeutralP): NeutralP {
  if (!n) return fallback;
  return {
    textL: n.textL ?? fallback.textL,
    secondaryL: n.secondaryL ?? fallback.secondaryL,
    mutedL: n.mutedL ?? fallback.mutedL,
    interactiveL: n.interactiveL ?? fallback.interactiveL,
    borderL: n.borderL ?? fallback.borderL,
    borderSubtleL: n.borderSubtleL ?? fallback.borderSubtleL,
    codeBgL: n.codeBgL ?? fallback.codeBgL,
    codeTextL: n.codeTextL ?? fallback.codeTextL,
  };
}

/** Deep-merge SemanticP to handle surfL/surfC added after initial release. */
function migrateSemanticP(sem: Partial<SemanticP> | undefined, fallback: SemanticP): SemanticP {
  if (!sem) return fallback;
  return {
    criticalH: sem.criticalH ?? fallback.criticalH,
    successH: sem.successH ?? fallback.successH,
    warningH: sem.warningH ?? fallback.warningH,
    infoH: sem.infoH ?? fallback.infoH,
    L: sem.L ?? fallback.L,
    C: sem.C ?? fallback.C,
    surfL: sem.surfL ?? fallback.surfL,
    surfC: sem.surfC ?? fallback.surfC,
  };
}

/** Patch missing TunerState fields with base-matched INIT defaults.
 *  @param base — the theme's mode; when provided, uses INIT_LIGHT or INIT_DARK
 *                so a light-based custom theme doesn't inherit dark defaults. */
export function migrateTunerState(s: Partial<TunerState>, base?: 'light' | 'dark'): TunerState {
  const fb = base ? initForBase(base) : INIT;
  return {
    ...fb,
    ...s,
    light: migrateModeP((s.light as Partial<ModeP>) ?? {}, fb.light),
    dark: migrateModeP((s.dark as Partial<ModeP>) ?? {}, fb.dark),
    neutralLight: migrateNeutralP(s.neutralLight as Partial<NeutralP> | undefined, fb.neutralLight),
    neutralDark: migrateNeutralP(s.neutralDark as Partial<NeutralP> | undefined, fb.neutralDark),
    semanticLight: migrateSemanticP(s.semanticLight as Partial<SemanticP> | undefined, fb.semanticLight),
    semanticDark: migrateSemanticP(s.semanticDark as Partial<SemanticP> | undefined, fb.semanticDark),
  };
}

/* buildCSS + exportText moved to oklch-tuner-css.ts (350-line split). */
