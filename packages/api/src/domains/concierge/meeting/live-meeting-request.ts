import type { MeetingAppSource } from './live-meeting-control-contract.js';

const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, '');

function commandText(text: string): string {
  const polite = /^(?:(?:你)?(?:能不能|能否|能|可以)(?:帮我|请)?|(?:can|could|would) you (?:please )?)/i;
  const value = text.trim();
  return polite.test(value)
    ? value
        .replace(polite, '')
        .replace(/(?:吗|么)?[?？。！!.]*$/, '')
        .trim()
    : value.replace(/^please /i, '').replace(/[。！!.]+$/, '');
}

/** Direct requests, including polite wording; instructions, quotations and conditions are not consent. */
export function meetingRequestSource(text: string, mode: 'start' | 'attach', sources: readonly MeetingAppSource[]) {
  const command = commandText(text);
  const pattern =
    mode === 'start'
      ? /^(?:请(?:你|帮我)?|帮我|麻烦你)?(?:开始(?:听|录制|录音|转写|记录)|start (?:listening to|recording|transcribing))\s*(.+)$/i
      : /^(?:请(?:你|帮我)?|帮我)?(?:接入(?:已有转写|转写)|分享(?:已有转写|转写)|attach (?:existing )?transcript (?:from )?)\s*(.+)$/i;
  const tail = pattern.exec(command)?.[1];
  if (!tail || /[?？“”"'「」\n]|不要|不许|不能|是否|能否|如果|假如|\b(?:not|never|don't|if)\b/i.test(tail)) return null;
  const matching = (target: string) =>
    sources.filter((source) => {
      const bundle = source.id.split('#pid=')[0];
      const shortName = bundle?.split('.').at(-1);
      return [source.id, source.name, shortName].some((name) => name && normalize(name) === target);
    });
  const exact = matching(normalize(tail));
  if (exact.length > 0) return exact.length === 1 ? exact[0] : null;
  const matches = matching(normalize(tail.replace(/(?:的会议|会议|音源|的声音)$/, '')));
  return matches.length === 1 ? matches[0] : null;
}

export function isMeetingStopRequest(text: string): boolean {
  return /^(?:请(?:你)?|帮我)?(?:停止|结束|取消)(?:听会|听会议|会议录音|会议转写|录音|录制|转写|采集|听)[。！!.]*$|^stop (?:listening|recording|transcribing|meeting capture)[。！!.]*$/i.test(
    commandText(text),
  );
}

/** Recording/transcription permission alone does not authorize a new Live transcript consumer. */
export function requestSharesTranscript(text: string, mode: 'start' | 'attach'): boolean {
  return mode === 'attach' || /^(?:请(?:你|帮我)?|帮我|麻烦你)?(?:开始听|start listening to)/i.test(commandText(text));
}
