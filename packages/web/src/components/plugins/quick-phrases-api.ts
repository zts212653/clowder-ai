import { useEffect, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '@/utils/api-client';
import { requestPluginHttp } from './plugin-panel-http';

const entriesSchema = z.object({
  entries: z.array(
    z.object({
      pluginId: z.literal('official.quick-phrases'),
      instanceId: z.string(),
      resourcePath: z.string(),
      generation: z.string(),
    }),
  ),
});
export type QuickPhrasesEntry = z.infer<typeof entriesSchema>['entries'][number];
const phraseSchema = z.object({ id: z.string(), text: z.string() });
export type QuickPhrase = z.infer<typeof phraseSchema>;
const pageSchema = z.object({
  items: z.array(phraseSchema).max(5),
  page: z.number().int().positive(),
  totalPages: z.number().int().positive(),
});

export function useQuickPhrasesEntry() {
  const [entry, setEntry] = useState<QuickPhrasesEntry>();
  useEffect(() => {
    const lifetime = new AbortController();
    const refresh = () =>
      apiFetch('/api/plugin-ui?group=composer.quick-phrases', { signal: lifetime.signal })
        .then(async (response) => {
          const parsed = entriesSchema.safeParse(response.ok ? await response.json() : null);
          if (!lifetime.signal.aborted) setEntry(parsed.success ? parsed.data.entries[0] : undefined);
        })
        .catch(() => {
          // Discovery recovers on focus and on the next lifecycle poll.
        });
    void refresh();
    window.addEventListener('focus', refresh);
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      lifetime.abort();
      window.removeEventListener('focus', refresh);
      window.clearInterval(timer);
    };
  }, []);
  return entry;
}

export async function readQuickPhrases(entry: QuickPhrasesEntry, query: string, page: number, signal: AbortSignal) {
  const params = new URLSearchParams({ q: query, page: String(page) });
  const response = await requestPluginHttp(entry, { method: 'GET', path: `${entry.resourcePath}?${params}` }, signal);
  if (response.status !== 200) throw new Error('Could not read quick phrases');
  return pageSchema.parse(response.body);
}

export type QuickPhrasesPage = Awaited<ReturnType<typeof readQuickPhrases>>;
