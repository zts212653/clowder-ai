import { collectiveText } from '@cat-cafe/ui';
import { useSyncExternalStore } from 'react';
import { hostAppearance } from './host-appearance.js';

export function useCollectiveLanguage(): 'zh' | 'en' {
  const store = hostAppearance();
  const read = () => store.getState().language;
  const host = useSyncExternalStore(store.subscribe, read, read);
  return (
    host ?? (typeof location !== 'undefined' && new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh')
  );
}
export function useCollectiveText() {
  const language = useCollectiveLanguage();
  return (text: string) => collectiveText(text, language);
}
