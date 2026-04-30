import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface ServiceState {
  manifest: { id: string; enablesFeatures: string[] };
  status: string;
}

const VOICE_FEATURES = ['voice-input', 'voice-output', 'voice-companion'];

export function useVoiceServicesAvailable(): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/services');
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { services: ServiceState[] };
        const voiceServices = data.services.filter((s) =>
          s.manifest.enablesFeatures.some((f) => VOICE_FEATURES.includes(f)),
        );
        const anyRunning = voiceServices.some((s) => s.status === 'running');
        if (!cancelled) setAvailable(anyRunning);
      } catch {
        /* network error — stay hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return available;
}
