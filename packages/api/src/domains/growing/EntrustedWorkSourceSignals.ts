const ZH_TIME_BOUND =
  /(?:今天|今晚|明天|后天|本周|这周|下周|周[一二三四五六日天]|月底|月末|年底|\d{1,2}\s*月\s*\d{1,2}\s*[日号]?|\d{1,2}\s*(?:点|时)(?:\s*\d{1,2}\s*分)?|之前|以内|截止|到期|deadline)/iu;

const EN_TIME_BOUND =
  /\b(?:today|tonight|tomorrow|next week|this week|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d)|before |deadline|due )\b/i;

export function containsEntrustedWorkTimeSignal(message: string): boolean {
  return ZH_TIME_BOUND.test(message) || EN_TIME_BOUND.test(message);
}
