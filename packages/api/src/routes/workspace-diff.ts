export interface WorkspaceChangedFile {
  status: string;
  path: string;
}

/** Parse the fixed two-column `git status --porcelain` prefix without trimming it away. */
export function parseWorkspaceChangedFiles(stdout: string): WorkspaceChangedFile[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const status = line.slice(0, 2).trim();
      let path = line.slice(3);
      if ((status.startsWith('R') || status.startsWith('C')) && path.includes(' -> ')) {
        path = path.slice(path.indexOf(' -> ') + 4);
      }
      return { status, path };
    });
}
