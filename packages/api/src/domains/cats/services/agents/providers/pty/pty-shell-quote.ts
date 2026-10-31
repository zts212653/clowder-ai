/** Quote values for the tmux command parser and the pane shell. */
export function shellQuoteArg(s: string): string {
  // Wrap in single quotes; escape embedded single quotes as '\''
  return `'${s.replace(/'/g, "'\\''")}'`;
}
