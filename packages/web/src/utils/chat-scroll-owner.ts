export interface ChatUserScrollGesture {
  scrollTo(top: number): boolean;
  end(): void;
}

// Floating controls look up the existing viewport owner; no geometry or intent
// is kept here. Each hook registration can retire only its own callback.
const owners = new WeakMap<HTMLElement, () => ChatUserScrollGesture | null>();

export function registerChatScrollOwner(viewport: HTMLElement, begin: () => ChatUserScrollGesture | null) {
  owners.set(viewport, begin);
  return () => {
    if (owners.get(viewport) === begin) owners.delete(viewport);
  };
}

export function beginChatScroll(viewport: HTMLElement): ChatUserScrollGesture | null {
  return owners.get(viewport)?.() ?? null;
}
