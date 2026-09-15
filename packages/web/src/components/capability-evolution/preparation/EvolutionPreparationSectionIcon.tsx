import type { EvolutionPreparationSection } from '@cat-cafe/shared';

export function EvolutionPreparationSectionIcon({ section }: { section: EvolutionPreparationSection }) {
  switch (section) {
    case 'object_map':
      return (
        <svg
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.7"
          viewBox="0 0 24 24"
        >
          <circle cx="7" cy="7" r="2.5" />
          <circle cx="17" cy="7" r="2.5" />
          <circle cx="12" cy="17" r="2.5" />
          <path d="m8.8 8.8 2 5.8m4.4-5.8-2 5.8M9.5 7h5" />
        </svg>
      );
    case 'success_contract':
      return (
        <svg
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.7"
          viewBox="0 0 24 24"
        >
          <path d="M12 4v16M5 7h14M8 20h8" />
          <path d="m7 7-3 6h6L7 7Zm10 0-3 6h6l-3-6Z" />
        </svg>
      );
    case 'measurement_plan':
      return (
        <svg
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.7"
          viewBox="0 0 24 24"
        >
          <path d="M9 3h6m-5 0v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3" />
          <path d="M7 16h10" />
        </svg>
      );
    case 'baseline_diagnosis':
      return (
        <svg
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.7"
          viewBox="0 0 24 24"
        >
          <circle cx="10" cy="10" r="6" />
          <path d="m14.5 14.5 5 5M6.5 10H9l1.2-2.2 2.1 4.4 1.2-2.2H15" />
        </svg>
      );
  }
}
