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
var
  Explanation: String;
begin
  if (PageID = wpReady) and (ExistingInstallDir <> '') then begin
    Explanation := FmtMessage(CustomMessage('SetupExistingInstallation'), [ExistingInstallDir]);
    if Pos(Explanation, WizardForm.ReadyMemo.Text) = 0 then begin
      WizardForm.ReadyMemo.Lines.Add('');
      WizardForm.ReadyMemo.Lines.Add(Explanation);
    end;
  end;
end;
