/** Only the initial routing salutation is generated from assignments; body/code/quoted mentions remain prose. */
export function stripProposalLeadingMentions(text: string, handles: readonly string[]): string {
  let body = text.trimStart();
  const ordered = [...new Set(handles)].sort((a, b) => b.length - a.length);
  while (body.startsWith('@')) {
    const handle = ordered.find(
      (value) => body.startsWith(value) && (body.length === value.length || /\s/.test(body.charAt(value.length))),
    );
    if (!handle) break;
    body = body.slice(handle.length).trimStart();
  }
  return body;
}
