/* F056 OKLCH Tuner — extracted update callbacks to keep OklchTuner.tsx under 350 lines. */
import { type Dispatch, type SetStateAction, useCallback } from 'react';
import type { CatTier, Mode, NeutralP, SemanticP, SurfaceP, TunerState } from './oklch-tuner-engine';

type Setter = Dispatch<SetStateAction<TunerState>>;

/** All per-section update callbacks consumed by OklchTuner JSX. */
export function useOklchTunerActions(mode: Mode, setParams: Setter) {
  const updateTier = useCallback(
    (tier: CatTier | 'insetText' | 'msgText', field: 'L' | 'Cmul' | 'C', value: number) => {
      setParams((prev) => ({
        ...prev,
        [mode]: { ...prev[mode], [tier]: { ...prev[mode][tier], [field]: value } },
      }));
    },
    [mode, setParams],
  );

  const updateElev = useCallback(
    (key: keyof SurfaceP, value: number) => {
      setParams((prev) => ({
        ...prev,
        [mode]: { ...prev[mode], elev: { ...prev[mode].elev, [key]: value } },
      }));
    },
    [mode, setParams],
  );

  const updateSemantic = useCallback(
    (field: keyof SemanticP, value: number) => {
      const key = mode === 'light' ? 'semanticLight' : 'semanticDark';
      setParams((prev) => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
    },
    [mode, setParams],
  );

  const updateQueue = useCallback(
    (field: 'H' | 'C' | 'L', value: number) => {
      setParams((prev) => ({ ...prev, queue: { ...prev.queue, [field]: value } }));
    },
    [setParams],
  );

  const updateNeutral = useCallback(
    (field: keyof NeutralP, value: number) => {
      const key = mode === 'light' ? 'neutralLight' : 'neutralDark';
      setParams((prev) => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
    },
    [mode, setParams],
  );

  return { updateTier, updateElev, updateSemantic, updateQueue, updateNeutral };
}
