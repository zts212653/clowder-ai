var
  ExistingInstallDir: String;

<event('InitializeWizard')>
procedure InitializeInstallDirectory;
begin
  ExistingInstallDir := WizardForm.PrevAppDir;
  if (ExistingInstallDir <> '') and DirExists(ExistingInstallDir) then
    WizardForm.DirEdit.Text := ExistingInstallDir
  else
    ExistingInstallDir := '';
end;

<event('ShouldSkipPage')>
function SkipExistingInstallDirectory(PageID: Integer): Boolean;
begin
  Result := (PageID = wpSelectDir) and (ExistingInstallDir <> '');
end;

<event('CurPageChanged')>
procedure ShowExistingInstallDirectory(PageID: Integer);
begin
  if (PageID = wpReady) and (ExistingInstallDir <> '') then begin
    WizardForm.ReadyMemo.Lines.Add('');
    WizardForm.ReadyMemo.Lines.Add(FmtMessage(CustomMessage('SetupExistingInstallation'), [ExistingInstallDir]));
  end;
end;
