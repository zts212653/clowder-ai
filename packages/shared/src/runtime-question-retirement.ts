/** One response for cached MCP callers and the authenticated legacy callback. */
export const RUNTIME_QUESTION_RETIREMENT = {
  status: 'retired',
  reasonCode: 'blocking_question_tool_retired',
  approvalGranted: false,
  questionCreated: false,
  message:
    'This blocking question tool is retired. No question was published and this is not an approval. ' +
    'Routine work needs no approval through this tool: continue already-authorized work using the available context. ' +
    'For a genuinely missing owner decision or new authorization, use the existing feature-owned decision surface, ' +
    'or ask clearly in the current conversation. Do not retry this tool or treat its retirement as user consent.',
} as const;
