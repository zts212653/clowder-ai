'use client';

/**
 * F112 Phase C: VAD Interrupt — uses @ricky0123/vad-web (Silero VAD v5 ONNX)
 * to detect user speech and interrupt PlaybackManager.
 *
 * Lifecycle: voiceMode on → init MicVAD → listen when playing → pause when idle → destroy on voiceMode off.
 * Dynamic import avoids SSR issues (MicVAD requires browser AudioWorklet/getUserMedia).
 */

import type { MicVAD as MicVADType } from '@ricky0123/vad-web';
import { useEffect, useRef, useState } from 'react';
import { useVoiceSessionStore } from '@/stores/voiceSessionStore';

const ONNX_WASM_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
const VAD_ASSETS_CDN = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/';

export type VadState = 'inactive' | 'loading' | 'listening' | 'paused' | 'error';

export function handleVadSpeechStart(): void {
  const store = useVoiceSessionStore.getState();
  if (store.session?.playbackState === 'playing') {
    store.stopAllAudio();
  }
}

export function useVadInterrupt(): { vadState: VadState } {
  const voiceMode = useVoiceSessionStore((s) => s.session?.voiceMode ?? false);
  const playbackState = useVoiceSessionStore((s) => s.session?.playbackState ?? 'idle');

  const vadRef = useRef<MicVADType | null>(null);
  const [vadState, setVadState] = useState<VadState>('inactive');

  useEffect(() => {
    if (!voiceMode) {
      if (vadRef.current) {
        vadRef.current.destroy().catch(() => {});
        vadRef.current = null;
        setVadState('inactive');
      }
      return;
    }

    let cancelled = false;

    async function initVad() {
      setVadState('loading');
      try {
        const { MicVAD } = await import('@ricky0123/vad-web');
        if (cancelled) return;

        const vad = await MicVAD.new({
          model: 'v5',
          baseAssetPath: VAD_ASSETS_CDN,
          onnxWASMBasePath: ONNX_WASM_CDN,
          startOnLoad: false,
          onSpeechStart: handleVadSpeechStart,
          onSpeechEnd: () => {},
          onVADMisfire: () => {},
        });

        if (cancelled) {
          await vad.destroy();
          return;
        }

        vadRef.current = vad;
        setVadState('paused');
      } catch (err) {
        if (!cancelled) {
          console.error('[VAD] Initialisation failed:', err);
          setVadState('error');
        }
      }
    }

    initVad();

    return () => {
      cancelled = true;
      if (vadRef.current) {
        vadRef.current.destroy().catch(() => {});
        vadRef.current = null;
        setVadState('inactive');
      }
    };
  }, [voiceMode]);

  useEffect(() => {
    const vad = vadRef.current;
    if (!vad || vadState === 'loading' || vadState === 'error') return;

    if (playbackState === 'playing') {
      if (!vad.listening) {
        vad
          .start()
          .then(() => {
            setVadState('listening');
          })
          .catch((err) => {
            console.error('[VAD] start() failed:', err);
            setVadState('error');
          });
      }
    } else {
      if (vad.listening) {
        vad
          .pause()
          .then(() => {
            setVadState('paused');
          })
          .catch(() => {});
      }
    }
  }, [playbackState, vadState]);

  return { vadState };
}
