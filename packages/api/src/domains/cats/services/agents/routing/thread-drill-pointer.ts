export function formatThreadContextDrill(threadId: string): string {
  return `cat_cafe_get_thread_context({ threadId: ${JSON.stringify(threadId)} })`;
}

/** Exact full-body read around one message coordinate (F332 cold-resume entries). */
export function formatThreadMessageDrill(threadId: string, messageId: string): string {
  return `cat_cafe_get_thread_context({ threadId: ${JSON.stringify(threadId)}, messageId: ${JSON.stringify(messageId)}, responseMode: "full" })`;
}

export function formatThreadDrill(threadId: string, semanticSearchTerms?: readonly string[]): string {
  const query = semanticSearchTerms
    ?.map((term) => term.trim())
    .find((term) => term.length > 0 && term !== threadId && !/[\r\n]/u.test(term));
  if (query) {
    return `cat_cafe_search_evidence({ query: ${JSON.stringify(query)}, threadId: ${JSON.stringify(threadId)}, scope: "threads", mode: "hybrid" })`;
  }

  return formatThreadContextDrill(threadId);
}
