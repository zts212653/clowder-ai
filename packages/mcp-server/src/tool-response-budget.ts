export interface BoundedToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  [key: string]: unknown;
}

export const TOOL_TEXT_RESPONSE_MAX_CHARS = 24_000;
const FRESHNESS_NOTICE_RESERVED_CHARS = 1_502;

const PURE_READERS_WITH_SOURCE_BUDGET = new Set([
  'cat_cafe_search_evidence',
  'cat_cafe_graph_resolve',
  'cat_cafe_list_recent',
  'cat_cafe_read_file_slice',
  'cat_cafe_list_events',
  'cat_cafe_list_session_chain',
  'cat_cafe_read_session_events',
  'cat_cafe_read_session_digest',
  'cat_cafe_read_invocation_detail',
]);

function textChars(result: BoundedToolResult): number {
  return result.content.reduce((sum, block) => sum + (typeof block.text === 'string' ? block.text.length : 0), 0);
}

function projectedChars(result: BoundedToolResult): number {
  let chars = textChars(result);
  const topLevel = Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'content' && key !== 'isError'));
  if (Object.keys(topLevel).length > 0) chars += JSON.stringify(topLevel).length;
  const blockMetadata = result.content.map((block) =>
    Object.fromEntries(Object.entries(block).filter(([key]) => key !== 'type' && key !== 'text')),
  );
  if (blockMetadata.some((block) => Object.keys(block).length > 0)) chars += JSON.stringify(blockMetadata).length;
  return chars;
}

function hasNonText(result: BoundedToolResult): boolean {
  return result.content.some((block) => block.type !== 'text');
}

/** API records notice_attached before returning; only request when its full text can fit. */
export function canRequestFreshnessNotice(result: BoundedToolResult): boolean {
  const chars = hasNonText(result) ? textChars(result) : projectedChars(result);
  return chars <= TOOL_TEXT_RESPONSE_MAX_CHARS - FRESHNESS_NOTICE_RESERVED_CHARS;
}

export function protectToolResponse<T extends BoundedToolResult>(toolName: string, result: T, isReadOnly: boolean): T {
  if (hasNonText(result)) return result;
  if (projectedChars(result) <= TOOL_TEXT_RESPONSE_MAX_CHARS) return result;
  // A write may already have committed. Some reads also record exact body
  // exposure; replacing their result after the handler would leave a false
  // seen fact. Non-text content has a separate media contract.
  if (!isReadOnly || !PURE_READERS_WITH_SOURCE_BUDGET.has(toolName)) return result;
  return {
    content: [
      {
        type: 'text',
        text: `The ${toolName} source reader exceeded the 24,000-character response budget before delivery. No source continuation was invented; retry through a narrower source read and report this reader contract failure.`,
      },
    ],
    isError: true,
  } as T;
}

export function appendFreshnessNoticeWithinBudget<T extends BoundedToolResult>(
  result: T,
  noticeText: string,
): { result: T; appended: boolean } {
  const addedText = `\n\n${noticeText}`;
  const chars = hasNonText(result) ? textChars(result) : projectedChars(result);
  if (chars + addedText.length > TOOL_TEXT_RESPONSE_MAX_CHARS) {
    return { result, appended: false };
  }
  return {
    result: { ...result, content: [...result.content, { type: 'text', text: addedText }] },
    appended: true,
  };
}
