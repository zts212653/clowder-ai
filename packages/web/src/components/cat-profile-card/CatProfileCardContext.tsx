'use client';

import {
  createContext,
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';

export interface CatProfileCardController {
  open(catId: string, anchor: HTMLElement): void;
  registerComposer(insert: (text: string) => void): () => void;
}

export const CatProfileCardContext = createContext<CatProfileCardController | null>(null);
export const useCatProfileCard = () => useContext(CatProfileCardContext);

/** Registers the actual composer; its blurred selection survives opening a nameplate card. */
export function useCatCardComposer(
  input: string,
  setInput: Dispatch<SetStateAction<string>>,
  textarea: RefObject<HTMLTextAreaElement>,
) {
  const card = useCatProfileCard();
  const caret = useRef<number | null>(null);
  useEffect(
    () =>
      card?.registerComposer((text) => {
        const node = textarea.current;
        const start = node?.selectionStart ?? input.length;
        const end = node?.selectionEnd ?? start;
        const prefix = start > 0 && !/\s/.test(input[start - 1]) ? ' ' : '';
        const inserted = prefix + text;
        caret.current = start + inserted.length;
        setInput(input.slice(0, start) + inserted + input.slice(end));
      }),
    [card, input, setInput, textarea],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore the caret after the inserted input has committed.
  useLayoutEffect(() => {
    if (caret.current === null || !textarea.current) return;
    textarea.current.focus({ preventScroll: true });
    textarea.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [input, textarea]);
}
