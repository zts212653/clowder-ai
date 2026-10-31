/** A display label does not rename the publication, file or Task. */
export function artworkTitle(title: string, generic: string): string {
  const name = title.replace(/^修改《(.+)》$/, '$1');
  return /^(?:codex|imagegen)-[a-f0-9_-]{8,}\.(?:png|mp4)$/i.test(name) ? generic : name;
}
