import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface ServiceState {
  features: string[];
  status: 'healthy' | 'unhealthy' | 'not_configured';
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
        const anyHealthy = data.services.some(
          (s) => s.status === 'healthy' && s.features.some((f) => VOICE_FEATURES.includes(f)),
        );
        if (!cancelled) setAvailable(anyHealthy);
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
