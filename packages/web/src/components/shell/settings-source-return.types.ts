/** Presentation contract. The C navigation owner supplies the real origin and restore action. */
export type SettingsSourceReturn = Readonly<{
  /** The source conversation's real title; the Settings shell supplies translated surrounding copy. */
  label: string;
  onReturn: () => void;
}> | null;
