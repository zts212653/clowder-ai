export const CHAT_READING_INPUT_FENCE_EVENT = 'catcafe:chat-reading-input-fence';

export interface ChatReadingInputFence {
  result: Promise<boolean>;
  cancel: () => void;
}

interface InputFenceRequest {
  viewport: HTMLElement;
  enroll: (fence: ChatReadingInputFence) => void;
}

export function readChatReadingInputFenceRequest(event: Event): InputFenceRequest | null {
  if (!(event instanceof CustomEvent)) return null;
  const request = (event as CustomEvent<InputFenceRequest>).detail;
  return request?.viewport instanceof HTMLElement && typeof request.enroll === 'function' ? request : null;
}

/** Collect only bridges mounted inside this owner; an absent bridge adds no wait. */
export function requestChatReadingInputFence(viewport: HTMLElement): ChatReadingInputFence | null {
  const participants: ChatReadingInputFence[] = [];
  window.dispatchEvent(
    new CustomEvent<InputFenceRequest>(CHAT_READING_INPUT_FENCE_EVENT, {
      detail: { viewport, enroll: (participant) => participants.push(participant) },
    }),
  );
  if (participants.length === 0) return null;
  return {
    result: Promise.all(participants.map((participant) => participant.result)).then((results) =>
      results.every(Boolean),
    ),
    cancel: () => {
      for (const participant of participants) participant.cancel();
    },
  };
}
