'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { TemplateCard } from './first-run-quest/TemplateStep';

export function useHubCatTemplates(enabled: boolean) {
  const [templates, setTemplates] = useState<TemplateCard[]>([]);
  const [loadingTemplates, setLoading] = useState(false);
  const [templatesError, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the explicit retry trigger for the same endpoint.
  useEffect(() => {
    if (!enabled) {
      setTemplates([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch('/api/cat-templates')
      .then(async (res) => {
        if (!res.ok) throw new Error('模板读取失败');
        const body = (await res.json()) as { templates?: TemplateCard[] };
        if (!Array.isArray(body.templates)) throw new Error('模板读取失败');
        if (!cancelled) setTemplates(body.templates);
      })
      .catch(() => {
        if (!cancelled) {
          setTemplates([]);
          setError('模板读取失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, revision]);
  return { templates, loadingTemplates, templatesError, retryTemplates: () => setRevision((v) => v + 1) };
}
