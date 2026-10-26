import { type CatId, readOutputMessageIdentity, sameOutputMessageIdentity } from '@cat-cafe/shared';
import type { AgentMessage } from '../types.js';

export interface OutputFragmentFacts {
  /** Host fragment application, separate from the unchanged native observation. */
  mode?: 'append';
  complete: boolean;
  changed: boolean;
}
export interface OutputStripper {
  push(content: string): string;
  flush(): string;
  hasPendingContent(): boolean;
  wasRewritten(): boolean;
}
export interface RoutedOutputTransform {
  transform(message: AgentMessage): AgentMessage[];
  outputFactsFor(message: AgentMessage): OutputFragmentFacts | undefined;
}

function sameSource(a: AgentMessage | undefined, b: AgentMessage): boolean {
  const first = readOutputMessageIdentity(a?.outputMessage);
  const second = readOutputMessageIdentity(b.outputMessage);
  return (
    !!first &&
    !!second &&
    sameOutputMessageIdentity(first, second) &&
    (a?.outputMessage?.channel === b.outputMessage?.channel ||
      (a?.outputMessage?.channel === 'unknown' &&
        a.outputMessage.complete === false &&
        b.outputMessage?.complete === true &&
        b.outputMessage.textMode === 'replace'))
  );
}

/** Invocation-local provenance for the existing streaming payload sanitizer. */
export function createRoutedOutputTransform(
  makeStripper: () => OutputStripper,
  explicitCatId?: CatId,
): RoutedOutputTransform {
  let stripper = makeStripper();
  let pendingSource: AgentMessage | undefined;
  let mixed = false;
  let rewritten = false;
  const facts = new WeakMap<AgentMessage, OutputFragmentFacts>();

  function prepareSource(message: AgentMessage): void {
    const pending = stripper.hasPendingContent();
    const replacement =
      message.textMode === 'replace' ||
      (pending && sameSource(pendingSource, message) && message.outputMessage?.textMode === 'replace');
    if (replacement) {
      stripper = makeStripper();
      pendingSource = undefined;
      mixed = false;
    } else if (pending && !sameSource(pendingSource, message)) mixed = true;
  }

  function rememberSource(message: AgentMessage): void {
    if (!stripper.hasPendingContent() || pendingSource) return;
    const { content: _content, ...source } = message;
    pendingSource = source;
  }

  function text(message: AgentMessage): AgentMessage[] {
    if (message.origin === 'callback' || message.extra?.isExplicitPost) return [message];
    prepareSource(message);
    const content = message.content ? stripper.push(message.content) : message.content;
    rewritten ||= stripper.wasRewritten();
    rememberSource(message);
    if (!content && !message.outputMessage) return [];
    const output: AgentMessage = { ...message, content, ...(mixed ? { outputMessage: undefined } : {}) };
    facts.set(output, {
      complete: message.outputMessage?.complete === true && !stripper.hasPendingContent(),
      changed: rewritten || mixed,
    });
    if (!stripper.hasPendingContent()) {
      pendingSource = undefined;
      mixed = false;
    }
    return [output];
  }

  return {
    outputFactsFor: (message) => facts.get(message),
    transform(message) {
      if (message.type === 'text') return text(message);
      if (message.type !== 'done') return [message];
      const content = stripper.flush();
      rewritten ||= stripper.wasRewritten();
      const source = mixed ? undefined : pendingSource;
      pendingSource = undefined;
      const output: AgentMessage = {
        ...source,
        type: 'text',
        catId: source?.catId ?? message.catId ?? explicitCatId,
        content,
        timestamp: source?.timestamp ?? message.timestamp,
      };
      facts.set(output, {
        mode: 'append',
        complete: source?.outputMessage?.complete === true,
        changed: rewritten || mixed,
      });
      mixed = false;
      return content ? [output, message] : [message];
    },
  };
}
