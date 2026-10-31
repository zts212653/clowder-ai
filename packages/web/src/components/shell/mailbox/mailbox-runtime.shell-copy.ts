import { CLASSIC_RUNTIME_INTERACTION_COPY } from '../../rich/RuntimeInteractionCopy';
import { defineShellCopy } from '../shell-copy';

export const mailboxRuntimeCopy = defineShellCopy(
  {
    zh: { ...CLASSIC_RUNTIME_INTERACTION_COPY },
    en: {
      loading: 'Syncing request…',
      preparing: 'Preparing request…',
      readonly: 'This request changed or could not be verified. Open the original message to continue.',
      syncFailed: 'Could not sync the request',
      submitFailed: 'Could not submit',
      kind: { approval: 'Confirmation', question: 'Question', elicitation: 'More information', unknown: 'Request' },
      status: {
        staged: 'Syncing',
        pending: 'Waiting for you',
        answered: 'Handled',
        declined: 'Declined',
        cancelled: 'Cancelled',
        invalidated: 'Expired',
      },
      terminal: {
        answered: 'Answer submitted.',
        handled: 'Request handled.',
        rejected: 'You declined this request.',
        cancelled: 'You cancelled this request.',
        restarted: 'This old request expired when the service restarted.',
        lost: 'This request expired after the connection was lost.',
        unavailable: 'Confirmation is unavailable for this run.',
        publicationFailed: 'The request could not be shown. No action ran.',
        invalid: 'This request expired and can no longer be submitted.',
      },
      elicitation: {
        open: (host: string) => `Open ${host}`,
        unavailable: 'The link is unavailable; you can still decline or cancel this request.',
        choose: 'Choose an option',
        yes: 'Yes',
        no: 'No',
      },
      form: {
        skip: 'Do not answer',
        submit: 'Submit answer',
        choose: 'Choose an option',
        other: 'Another answer',
        otherLabel: (question: string) => `Another answer: ${question}`,
      },
    },
  },
  { samples: { 'form.otherLabel': [['A'], ['B']], 'elicitation.open': [['example.com'], ['provider.test']] } },
);
