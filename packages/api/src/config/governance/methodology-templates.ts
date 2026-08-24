/**
 * F070: Methodology skeleton templates
 *
 * Minimal templates generated in external projects on first bootstrap.
 * Only created if the target file does not already exist (no-overwrite).
 */

export interface MethodologyTemplate {
  readonly relativePath: string;
  readonly content: string;
}

export interface ProjectCommand {
  readonly script: string;
  readonly command: string;
}

const BACKLOG_TEMPLATE = `---
topics: [backlog]
doc_kind: note
created: {{DATE}}
---

# Feature Roadmap

> **Rules**: Only active Features (idea/spec/in-progress/review). Move to done after completion.
> Details in \`docs/features/Fxxx-*.md\`.

| ID | Name | Status | Owner | Link |
|----|------|--------|-------|------|
`;

function buildSopTemplate(commands: readonly ProjectCommand[]): string {
  const commandRows =
    commands.length > 0
      ? commands.map(({ script, command }) => `| ${script} | \`${command}\` |`).join('\n')
      : "| unknown | Inspect this repository's manifests and CI configuration before running commands. |";

  return `---
topics: [sop, workflow]
doc_kind: note
created: {{DATE}}
---

# Standard Operating Procedure

## Workflow

1. Read this repository's own instructions and current work item.
2. Make an isolated, reviewable change.
3. Run only commands verified below or discovered from the repository.
4. Review the final diff and use the repository's normal merge process.

## Discovered package scripts

| Script | Command |
|--------|---------|
${commandRows}
`;
}

const FEATURE_TEMPLATE = `---
feature_ids: [Fxxx]
related_features: []
topics: []
doc_kind: spec
created: {{DATE}}
---

# Fxxx: Feature Name

> Status: spec | Owner: TBD

## Why
## What
## Acceptance Criteria
- [ ] AC-1: ...

## Dependencies
## Risk
## Open Questions
`;

export function getMethodologyTemplates(commands: readonly ProjectCommand[] = []): MethodologyTemplate[] {
  const date = new Date().toISOString().slice(0, 10);
  const fill = (tpl: string) => tpl.replace(/\{\{DATE\}\}/g, date);

  return [
    { relativePath: 'BACKLOG.md', content: fill(BACKLOG_TEMPLATE) },
    { relativePath: 'docs/SOP.md', content: fill(buildSopTemplate(commands)) },
    { relativePath: 'docs/features/.gitkeep', content: '' },
    { relativePath: 'docs/decisions/.gitkeep', content: '' },
    { relativePath: 'docs/discussions/.gitkeep', content: '' },
    { relativePath: 'docs/features/TEMPLATE.md', content: fill(FEATURE_TEMPLATE) },
  ];
}
