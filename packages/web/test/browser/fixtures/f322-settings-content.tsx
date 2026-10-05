// Domain rendering is outside the shell journey. The real SettingsShell owns selection,
// query preservation and pin controls; this boundary reveals which owner it selected.
export function SettingsContent({ section, initialEditCatId }: { section: string; initialEditCatId?: string }) {
  return (
    <section data-testid="settings-owner" data-section={section} data-cat={initialEditCatId ?? ''}>
      {section}
    </section>
  );
}
export function OklchTuner() {
  return null;
}
export default OklchTuner;
