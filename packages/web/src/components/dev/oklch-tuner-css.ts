/* F056 OKLCH Tuner — CSS generation + export text.
 * Split from oklch-tuner-engine.ts to stay under 350-line hard limit. */
import type { CatTier, HcOverride, Mode, ModeP, NeutralP, SemanticP, SurfaceP, TunerState } from './oklch-tuner-engine';
import { CAT_TIERS, INIT } from './oklch-tuner-engine';

/* ── CSS generation ── */
export function buildCSS(p: TunerState, hc: HcOverride): string {
  const ok = (m: ModeP, t: CatTier, h: string, c: string) => `oklch(${m[t].L} calc(${c} * ${m[t].Cmul}) ${h})`;
  const it = (m: ModeP) => `oklch(${m.insetText.L} ${m.insetText.C} 250)`;
  /* Defensive: old persisted data may lack msgText (added mid-PR) */
  const mt = (m: ModeP) => {
    const msg = m.msgText ?? INIT.light.msgText;
    return `oklch(${msg.L} ${msg.C} ${p.neutralHue})`;
  };

  // 1. Accent + surface hue/chroma — accent cascades to --accent-*, surface hue+chroma independent (KD-34)
  const sH = p.surfaceHue ?? 80;
  const sC = +(0.01 * (p.surfaceChroma ?? 1)).toFixed(4);
  const accent = `:root{--accent-hue:${p.accentHue};--accent-chroma:${p.accentChroma};--surface-hue:${sH};--surface-chroma:${sC};}`;

  // 1b. Cat tier gradients — per-slug tokens in cat-persona-tokens.css consume these
  const catGrads = (m: ModeP, dark: boolean) => {
    const sel = dark ? '[data-theme="dark"]' : ':root';
    /* Defensive: old persisted data may lack msgText */
    const msg = m.msgText ?? (dark ? INIT.dark.msgText : INIT.light.msgText);
    /* Cat name text: unified H/L/C across all cats. CSS formulas in
     * cat-persona-tokens.css consume --cat-name-l/c/h (not per-cat hue).
     * This avoids fragile source-order override of final --color-{slug}-text. */
    const nameL = dark ? p.catTextDarkL : p.catTextLightL;
    return (
      `${sel}{` +
      `--cat-bubble-l:${m.primary.L};--cat-bubble-cmul:${m.primary.Cmul};` +
      `--cat-surface-l:${m.surface.L};--cat-surface-cmul:${m.surface.Cmul};` +
      `--cat-text-l:${m.text.L};--cat-text-cmul:${m.text.Cmul};` +
      `--cat-ring-l:${m.ring.L};--cat-ring-cmul:${m.ring.Cmul};` +
      `--cat-inset-l:${m.inset.L};--cat-inset-cmul:${m.inset.Cmul};` +
      `--cat-inset-text-l:${m.insetText.L};--cat-inset-text-c:${m.insetText.C};` +
      `--cat-msg-text-l:${msg.L};--cat-msg-text-c:${msg.C};` +
      `--cat-name-l:${nameL};--cat-name-c:${p.catTextC};--cat-name-h:${p.catTextH};}`
    );
  };

  // 2. Surface elevation — chroma = --surface-chroma × layer factor (1.5/1.2/0.5/0.3)
  const SURF_FACTORS = [1.5, 1.2, 0.5, 0.3] as const;
  const surf = (e: SurfaceP, dark: boolean) => {
    const sel = dark ? '[data-theme="dark"]' : ':root';
    const ch = SURF_FACTORS.map((f) => +(sC * f).toFixed(4));
    return (
      `${sel}{` +
      `--cafe-surface-sunken:oklch(${e.sunken} ${ch[0]} ${sH});` +
      `--cafe-surface:oklch(${e.base} ${ch[1]} ${sH});` +
      `--cafe-surface-elevated:oklch(${e.elevated} ${ch[2]} ${sH});` +
      `--cafe-surface-canvas:oklch(${e.canvas} ${ch[3]} ${sH});}`
    );
  };

  // 3. Runtime message derived (.cat-persona-derived)
  const mH = hc.on ? `${hc.hue}` : 'var(--msg-hue,297)';
  const mC = hc.on ? `${hc.chroma}` : 'var(--msg-chroma,0.1)';
  const drv = (m: ModeP, dark: boolean) => {
    const sel = dark ? '[data-theme="dark"] .cat-persona-derived' : '.cat-persona-derived';
    return (
      `${sel}{` +
      `--cat-msg-bubble:${ok(m, 'primary', mH, mC)};` +
      `--cat-msg-surface:${ok(m, 'surface', mH, mC)};` +
      `--cat-msg-inset:${ok(m, 'inset', mH, mC)};` +
      `--cat-msg-inset-text:${it(m)};` +
      `--cat-msg-text:${mt(m)};` +
      `--cat-msg-ring:${ok(m, 'ring', mH, mC)};}`
    );
  };

  // 5. Force all cats to same H/C (!important to beat inline styles)
  const force = hc.on ? `.cat-persona-derived{--msg-hue:${hc.hue}!important;--msg-chroma:${hc.chroma}!important;}` : '';

  // 6. Semantic status colors (critical / success / warning / info + surface variants)
  const semCSS = (s: SemanticP, dark: boolean) => {
    const sel = dark ? '[data-theme="dark"]' : ':root';
    return (
      `${sel}{` +
      `--semantic-critical:oklch(${s.L} ${s.C} ${s.criticalH});` +
      `--semantic-success:oklch(${s.L} ${s.C} ${s.successH});` +
      `--semantic-warning:oklch(${s.L} ${s.C} ${s.warningH});` +
      `--semantic-info:oklch(${s.L} ${s.C} ${s.infoH});` +
      `--semantic-spotlight:oklch(${s.L + 0.1} ${s.C} ${s.warningH});` +
      `--semantic-critical-surface:oklch(${s.surfL} ${s.surfC} ${s.criticalH});` +
      `--semantic-success-surface:oklch(${s.surfL} ${s.surfC} ${s.successH});` +
      `--semantic-warning-surface:oklch(${s.surfL} ${s.surfC + 0.01} ${s.warningH});` +
      `--semantic-info-surface:oklch(${s.surfL} ${s.surfC} ${s.infoH});` +
      `--semantic-spotlight-surface:oklch(${s.surfL} ${s.surfC + 0.01} ${s.warningH});}`
    );
  };

  // 7. Queue accent (overrides fixed hex with OKLCH)
  const q = p.queue;
  const qLight =
    `:root{--queue-accent:oklch(${q.L} ${q.C} ${q.H});` +
    `--queue-accent-hover:oklch(${q.L - 0.06} ${q.C + 0.01} ${q.H});` +
    `--queue-accent-surface:oklch(0.96 ${q.C * 0.2} ${q.H});` +
    `--queue-on-accent:oklch(1 0 0);}`;
  const qDark =
    `[data-theme="dark"]{--queue-accent:oklch(${q.L + 0.16} ${q.C + 0.02} ${q.H});` +
    `--queue-accent-hover:oklch(${q.L + 0.22} ${q.C + 0.04} ${q.H});` +
    `--queue-accent-surface:oklch(0.25 ${q.C * 0.4} ${q.H});` +
    `--queue-on-accent:oklch(0.18 0.03 ${q.H});}`;

  // 8. Neutral text/border (overrides --cafe-text/border aliases) + code tokens
  const nCSS = (n: NeutralP, dark: boolean) => {
    const sel = dark ? '[data-theme="dark"]' : ':root';
    const o = (l: number) => `oklch(${l} ${p.neutralChroma} ${p.neutralHue})`;
    const codeBg = `oklch(${n.codeBgL ?? (dark ? 0.2 : 0.985)} 0.005 ${p.neutralHue})`;
    const codeTx = `oklch(${n.codeTextL ?? (dark ? 0.92 : 0.22)} 0.02 ${p.neutralHue})`;
    return `${sel}{--cafe-text:${o(n.textL)};--cafe-text-secondary:${o(n.secondaryL)};--cafe-text-muted:${o(n.mutedL)};--cafe-interactive:${o(n.interactiveL)};--cafe-border:${o(n.borderL)};--cafe-border-subtle:${o(n.borderSubtleL)};--code-bg:${codeBg};--code-text:${codeTx};}`;
  };

  // 9. Hub editor preview — each preview class gets its own mode's values so light
  //    preview always has light text/surface and dark preview always has dark text/surface,
  //    regardless of the current [data-theme].
  const pvw = (m: ModeP, dark: boolean): string => {
    const cls = dark ? '.cat-persona-preview-dark' : '.cat-persona-preview-light';
    const msg = m.msgText ?? (dark ? INIT.dark.msgText : INIT.light.msgText);
    const mc = 'var(--msg-chroma,0.1)';
    const mh = 'var(--msg-hue,297)';
    return (
      `${cls}{` +
      `--cat-msg-surface:oklch(${m.surface.L} calc(${mc}*${m.surface.Cmul}) ${mh});` +
      `--cat-msg-inset:oklch(${m.inset.L} calc(${mc}*${m.inset.Cmul}) ${mh});` +
      `--cat-msg-inset-text:oklch(${m.insetText.L} ${m.insetText.C} 250);` +
      `--cat-msg-text:oklch(${msg.L} ${msg.C} ${p.neutralHue});}`
    );
  };

  return [
    accent,
    // --cat-{tier}-l/cmul → cat-persona-tokens.css per-slug formulas + CatHueInjector
    catGrads(p.light, false),
    catGrads(p.dark, true),
    surf(p.light.elev, false),
    surf(p.dark.elev, true),
    drv(p.light, false),
    drv(p.dark, true),
    force,
    semCSS(p.semanticLight, false),
    semCSS(p.semanticDark, true),
    qLight,
    qDark,
    nCSS(p.neutralLight, false),
    nCSS(p.neutralDark, true),
    pvw(p.light, false),
    pvw(p.dark, true),
  ]
    .filter(Boolean)
    .join('\n');
}

/* ── Export text (Copy button) — exports current mode only ── */
export function exportText(p: TunerState, activeMode: Mode): string {
  const r = (t: CatTier) =>
    `  ${t.padEnd(9)} L=${p[activeMode][t].L.toFixed(2)}  C*${p[activeMode][t].Cmul.toFixed(2)}`;
  const fx = (k: 'insetText' | 'msgText') =>
    `  ${k.padEnd(9)} L=${p[activeMode][k].L.toFixed(2)}  C=${p[activeMode][k].C.toFixed(3)}`;
  const e = p[activeMode].elev;
  const semP = activeMode === 'light' ? p.semanticLight : p.semanticDark;
  const neuP = activeMode === 'light' ? p.neutralLight : p.neutralDark;
  const catNameL = activeMode === 'light' ? p.catTextLightL : p.catTextDarkL;
  const sem = (s: SemanticP) =>
    `  H: crit=${s.criticalH} suc=${s.successH} warn=${s.warningH} info=${s.infoH}  L=${s.L.toFixed(2)} C=${s.C.toFixed(3)} surfL=${s.surfL.toFixed(2)} surfC=${s.surfC.toFixed(3)}`;
  const n = (np: NeutralP) =>
    `txt=${np.textL} sec=${np.secondaryL} mut=${np.mutedL} int=${np.interactiveL} bdr=${np.borderL} sub=${np.borderSubtleL} codeBg=${np.codeBgL} codeTx=${np.codeTextL}`;
  return [
    `OKLCH Token Values (${activeMode})`,
    `accent H=${p.accentHue} C=${p.accentChroma}`,
    `surface H=${p.surfaceHue} C*=${p.surfaceChroma}`,
    '='.repeat(30),
    `${activeMode}:`,
    ...CAT_TIERS.map((t) => r(t)),
    fx('insetText'),
    fx('msgText'),
    `  elevation: ${e.sunken}/${e.base}/${e.elevated}/${e.canvas}`,
    '',
    `semantic (${activeMode}):`,
    sem(semP),
    `queue: H=${p.queue.H} C=${p.queue.C} L=${p.queue.L}`,
    `neutral: H=${p.neutralHue} C=${p.neutralChroma}  ${n(neuP)}`,
    `catText: H=${p.catTextH} C=${p.catTextC} L=${catNameL}`,
  ].join('\n');
}
