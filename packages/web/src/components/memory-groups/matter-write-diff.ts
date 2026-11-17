/** Keep the changed range, excluding identical leading/trailing lines. Text is rendered by React. */
export function matterWriteDiff(before: string, after: string) {
  const oldLines = before.split('\n'),
    newLines = after.split('\n');
  let start = 0,
    oldEnd = oldLines.length,
    newEnd = newLines.length;
  while (start < oldEnd && start < newEnd && oldLines[start] === newLines[start]) start++;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return { removed: oldLines.slice(start, oldEnd).join('\n'), added: newLines.slice(start, newEnd).join('\n') };
}
