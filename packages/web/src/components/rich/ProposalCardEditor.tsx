import { useShellCopy } from '@/components/shell/shell-copy';
import { DeclaredWorkModeEdit, EditField, ProjectPathEdit, ReportingModeEdit } from './ProposalCardFields';
import { ProposalInitialMessageEditor } from './ProposalInitialMessageEditor';
import { ProposalParentField } from './ProposalParentField';
import { proposalCardCopy } from './proposal-card.shell-copy';
import type { ProposalCardState } from './useProposalCardState';

/** All seven original override fields, sent by the original producer action. */
export function ProposalCardEditor({ state }: { state: ProposalCardState }) {
  const t = useShellCopy(proposalCardCopy);
  const { edits, setEdits } = state;
  const change =
    <K extends keyof typeof edits>(field: K) =>
    (value: (typeof edits)[K]) =>
      setEdits((p) => ({ ...p, [field]: value }));
  return (
    <fieldset
      disabled={state.loading}
      className="min-w-0 space-y-2 text-xs"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        state.setEditing(false);
      }}
    >
      <EditField label={t.title} value={edits.title} onChange={change('title')} />
      <ProposalParentField value={edits.parentThreadId} onChange={change('parentThreadId')} />
      <ProjectPathEdit
        value={edits.projectPath}
        onChange={change('projectPath')}
        existingProjects={state.existingProjects}
        defaultParent={state.needsProjectChoice}
        copy={{ label: t.projectEdit, choose: t.projectChoice, manual: t.projectManual, warning: t.projectWarning }}
      />
      <EditField label={t.members} value={edits.preferredCats} onChange={change('preferredCats')} />
      <DeclaredWorkModeEdit
        value={edits.declaredWorkMode}
        onChange={change('declaredWorkMode')}
        copy={{ label: t.collaboration, unknown: t.unknown, options: t.workMode }}
      />
      <ReportingModeEdit
        value={edits.reportingMode}
        onChange={change('reportingMode')}
        copy={{ label: t.reporting, options: t.reportingMode }}
      />
      <ProposalInitialMessageEditor value={edits.initialMessage} onChange={change('initialMessage')} />
    </fieldset>
  );
}
