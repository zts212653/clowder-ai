'use client';

/* eslint-disable cafe/no-hardcoded-colors -- OKLCH Tuner is the design-token EDITOR itself;
 * preview swatches must render dynamic oklch() literals computed from live params.
 * This file is the documented AC-E11 exception (as OklchTuner.tsx). */

import type { Dispatch, SetStateAction } from 'react';
import type { NamePlateResult } from '@/lib/readable-name-plate';
import { type Mode, type TunerState } from './oklch-tuner-engine';
import { TagIcon } from './oklch-tuner-extra';
import { NameRoleHint } from './oklch-tuner-name-hint';
import { Slider } from './oklch-tuner-slider';

/**
 * The cat-name text role (one H/L/C for all cats, it does not follow a member's colour) and what the Tuner says about how it
 * is drawn: the hint under the sliders is "显示时已调到可读" / "这组颜色下名字读不清" when the saved value is not what is drawn.
 */
export function CatNameSection({
  params,
  mode,
  setParams,
  drawn,
}: {
  params: TunerState;
  mode: Mode;
  setParams: Dispatch<SetStateAction<TunerState>>;
  drawn: NamePlateResult;
}) {
  const savedL = mode === 'light' ? params.catTextLightL : params.catTextDarkL;
  return (
    <div className="space-y-0.5 pb-2 border-b border-[var(--console-border-soft)]" data-testid="tuner-cat-name">
      <div className="flex items-center gap-2">
        <div className="text-[10px] text-cafe-muted font-bold flex items-center gap-1">
          <TagIcon /> 猫名文字 (统一)
        </div>
        <div
          className="w-4 h-4 rounded border border-[var(--console-border-soft)] shrink-0 ml-auto"
          style={{ background: `oklch(${savedL} ${params.catTextC} ${params.catTextH})` }}
        />
      </div>
      <Slider
        label="H"
        value={params.catTextH}
        min={0}
        max={360}
        step={1}
        fmt={`${params.catTextH}`}
        onChange={(v) => setParams((p) => ({ ...p, catTextH: v }))}
      />
      <Slider
        label="L"
        value={savedL}
        min={0}
        max={1}
        step={0.01}
        fmt={savedL.toFixed(2)}
        onChange={(v) => {
          const key = mode === 'light' ? 'catTextLightL' : 'catTextDarkL';
          setParams((p) => ({ ...p, [key]: v }));
        }}
      />
      <Slider
        label="C"
        value={params.catTextC}
        min={0}
        max={0.3}
        step={0.005}
        fmt={params.catTextC.toFixed(3)}
        onChange={(v) => setParams((p) => ({ ...p, catTextC: v }))}
      />
      <NameRoleHint
        saved={{ nameL: savedL, plateL: params[mode].surface.L, c: params.catTextC, h: params.catTextH }}
        drawn={drawn}
      />
    </div>
  );
}
