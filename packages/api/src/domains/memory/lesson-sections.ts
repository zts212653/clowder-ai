/** The exact source unit hashed by the lesson index and checked by canonical readers. */
export interface LessonSection {
  anchor: string;
  title: string;
  content: string;
  start: number;
}

export function lessonSections(content: string): LessonSection[] {
  const headings = [...content.matchAll(/^### /gm)];
  const sections: LessonSection[] = [];
  for (const [index, heading] of headings.entries()) {
    const start = heading.index;
    const section = content.slice(start, headings[index + 1]?.index ?? content.length);
    const title = /^### (LL-\d+):\s*(.+)/.exec(section);
    const anchor = title?.[1];
    const label = title?.[2];
    if (!anchor || !label) continue;
    sections.push({ anchor, title: `${anchor}: ${label.trim()}`, content: section, start });
  }
  return sections;
}
