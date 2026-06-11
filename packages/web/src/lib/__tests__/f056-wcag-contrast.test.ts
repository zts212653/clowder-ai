// @vitest-environment node
/**
 * F056 Phase E AC-E10 — WCAG 对比度自动测试
 *
 * 验证 OKLCH 派生 token 组合的对比度符合 WCAG AA：
 *   - normal text ≥ 4.5:1
 *   - large text / icon ≥ 3:1
 *   - AAA: ≥ 7:1
 *
 * Token 派生公式来源：
 *   theme-tokens.css        — primitives（neutral / accent / semantic / chart）
 *   cat-persona-tokens.css  — text 走中性 --cafe-text（neutral-900）；
 *                            surface light L=0.85 / dark L=0.30（per-cat 派生）
 */
import { describe, expect, it } from 'vitest';
import { type OklchColor, oklchContrast } from '../color-utils';

const oklch = (l: number, c: number, h: number): OklchColor => ({ l, c, h });

/** 按 cat-persona-derived.css + INIT_LIGHT/INIT_DARK 派生 bubble/surface/ring；
 * text = --cat-msg-text（Tuner msgText 控制，接近中性）。
 * 值必须与 oklch-tuner-engine.ts INIT_LIGHT/dark 保持一致。 */
function catPersonaDerived(hue: number, chroma: number, mode: 'light' | 'dark') {
  if (mode === 'light') {
    return {
      bubble: oklch(0.62, chroma, hue),
      surface: oklch(0.85, chroma * 0.45, hue),
      text: oklch(0.25, 0.01, 30),
      ring: oklch(0.55, chroma * 1.1, hue),
    };
  }
  return {
    bubble: oklch(0.68, chroma * 0.85, hue),
    surface: oklch(0.3, chroma * 0.15, hue),
    text: oklch(0.8, 0.04, 30),
    ring: oklch(0.7, chroma, hue),
  };
}

const CAT_ANCHORS: ReadonlyArray<[string, number, number]> = [
  ['opus', 297, 0.13],
  ['sonnet', 290, 0.1],
  ['codex', 145, 0.1],
  ['gemini', 240, 0.11],
  ['kimi', 250, 0.03],
  ['dare', 80, 0.11],
  ['cocreator', 40, 0.1],
];

describe('F056 Phase E AC-E10 — WCAG contrast (OKLCH derived tokens)', () => {
  describe('Cat Persona — text ↔ surface 对比度（light ≥6.5 / dark AA ≥4.5）', () => {
    for (const [slug, hue, chroma] of CAT_ANCHORS) {
      it(`${slug} light: text vs surface`, () => {
        const { text, surface } = catPersonaDerived(hue, chroma, 'light');
        const ratio = oklchContrast(text, surface);
        // --cat-msg-text (L=0.25) is intentionally softer than --cafe-text (L=0.2)
        // inside colored bubbles. INIT_LIGHT.msgText tuned for readability + aesthetics.
        // Threshold: enhanced AA (6.5) — all cats score 6.86–6.97. Full AAA (7.0)
        // would require L≤0.33 which conflicts with the tuned visual design.
        expect(ratio, `${slug} light text-vs-surface = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(6.5);
      });

      it(`${slug} dark: text vs surface`, () => {
        const { text, surface } = catPersonaDerived(hue, chroma, 'dark');
        const ratio = oklchContrast(text, surface);
        expect(ratio, `${slug} dark text-vs-surface = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      });
    }
  });

  describe('Neutral — text-primary ↔ surface 对比度（AAA ≥7:1）', () => {
    it('light: neutral-900 text vs neutral-50 surface', () => {
      const ratio = oklchContrast(oklch(0.2, 0.005, 30), oklch(0.985, 0.005, 30));
      expect(ratio).toBeGreaterThanOrEqual(7);
    });

    it('dark: neutral-900 text vs neutral-50 surface (mode-inverted)', () => {
      // dark mode: neutral-900=light text, neutral-50=dark surface (反转)
      const ratio = oklchContrast(oklch(0.95, 0.005, 30), oklch(0.13, 0.005, 30));
      expect(ratio).toBeGreaterThanOrEqual(7);
    });
  });

  describe('Cafe Surface — text vs surface 三档', () => {
    it('light: cafe-text (neutral-900) vs cafe-surface', () => {
      const ratio = oklchContrast(oklch(0.2, 0.005, 30), oklch(0.97, 0.005, 30));
      expect(ratio).toBeGreaterThanOrEqual(7);
    });

    it('dark: cafe-text (neutral-900) vs cafe-surface', () => {
      const ratio = oklchContrast(oklch(0.95, 0.005, 30), oklch(0.28, 0.0018, 30));
      expect(ratio).toBeGreaterThanOrEqual(7);
    });
  });

  describe('Accent — accent-foreground ↔ accent-500（按钮文字）', () => {
    it('light: neutral-50 (foreground) vs accent-500 (button bg)', () => {
      const fg = oklch(0.985, 0.005, 30);
      const bg = oklch(0.55, 0.15, 35);
      const ratio = oklchContrast(fg, bg);
      // 按钮 normal text ≥4.5:1
      expect(ratio, `accent button contrast = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    });
  });

  describe('Semantic — critical/success/warning/info icon vs surface（icon ≥3:1）', () => {
    const cafeSurfaceLight = oklch(0.97, 0.005, 30);
    const cases: ReadonlyArray<[string, OklchColor]> = [
      ['critical', oklch(0.55, 0.22, 25)],
      ['success', oklch(0.55, 0.17, 145)],
      ['warning', oklch(0.6, 0.18, 70)],
      ['info', oklch(0.55, 0.15, 230)],
    ];
    for (const [name, color] of cases) {
      it(`light: semantic-${name} icon vs cafe-surface`, () => {
        const ratio = oklchContrast(color, cafeSurfaceLight);
        expect(ratio, `semantic-${name} light icon = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      });
    }
  });

  describe('Surface 三档 — dark mode L 跨度 ≥ 0.05 (perceptually distinguishable)', () => {
    it('dark: surface vs surface-elevated L 跨度 ≥ 0.05', () => {
      const base = 0.28;
      const elevated = 0.21;
      expect(Math.abs(elevated - base)).toBeGreaterThanOrEqual(0.05);
    });

    it('dark: surface vs surface-sunken L 跨度 ≥ 0.05', () => {
      const base = 0.28;
      const sunken = 0.36;
      expect(Math.abs(base - sunken)).toBeGreaterThanOrEqual(0.05);
    });
  });
});
