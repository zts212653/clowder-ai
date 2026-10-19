'use client';

import { collectiveText } from '@cat-cafe/ui';
import { useShellLanguage } from '../shell/shell-language';

export function useCollectiveText() {
  const language = useShellLanguage();
  return (text: string) => collectiveText(text, language);
}
