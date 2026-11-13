type
  TFileUseStage = (fuNone, fuPending, fuChecking, fuPrompt);

var
  FileUseStage: TFileUseStage;
  PreparationStartedAt, FileUseStartedAt, ReplacementStartedAt: Cardinal;
  ReadyCaption: String;
  ReadyMemoWasVisible: Boolean;

function GetTickCount: Cardinal;
  external 'GetTickCount@kernel32.dll stdcall setuponly';

procedure FinishSetupStage(const Stage: String; StartedAt: Cardinal; const Detail: String);
begin
  Log('Setup stage ' + Stage + ': finished, elapsedMs=' + IntToStr(GetTickCount - StartedAt) + Detail);
end;

procedure ShowPreparationBody(LabelControl: TNewStaticText; const MessageKey: String);
begin
  LabelControl.Caption := CustomMessage(MessageKey) + #13#10#13#10 + CustomMessage('SetupPreparingHint');
  WizardForm.AdjustLabelHeight(LabelControl);
  LabelControl.Visible := True;
  LabelControl.Update;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = wpReady then begin
    // Inno can do native checks before it switches to wpPreparing.
    FileUseStage := fuNone;
    PreparationStartedAt := GetTickCount;
    if not WizardSilent then begin
      ReadyCaption := WizardForm.ReadyLabel.Caption;
      ReadyMemoWasVisible := WizardForm.ReadyMemo.Visible;
      WizardForm.ReadyMemo.Visible := False;
      WizardForm.PageNameLabel.Caption := SetupMessage(msgWizardPreparing);
      WizardForm.PageDescriptionLabel.Caption := '';
      ShowPreparationBody(WizardForm.ReadyLabel, 'SetupBeforePreparing');
      WizardForm.ReadyPage.Update;
      WizardForm.PageNameLabel.Update;
      WizardForm.PageDescriptionLabel.Update;
    end;
    Log('Setup stage native-preparation: ready confirmed');
  end else if (CurPageID = wpPreparing) and (FileUseStage = fuPrompt) then begin
    FinishSetupStage('file-use-prompt', FileUseStartedAt, ', outcome=continue-requested');
    FileUseStage := fuNone;
  end;
end;

function ExtractPreparationHelper(const FileName, Stage, MessageKey: String): Boolean;
var
  StartedAt: Cardinal;
begin
  ShowPreparationBody(WizardForm.PreparingLabel, MessageKey);
  Log('Setup stage ' + Stage + ': started');
  StartedAt := GetTickCount;
  try
    ExtractTemporaryFile(FileName);
    FinishSetupStage(Stage, StartedAt, '');
    Result := True;
  except
    FinishSetupStage(Stage, StartedAt, ', error=' + GetExceptionMessage);
    Result := False;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
  Cmd, AppDir, InstanceRoot, FrontendPort, ApiPort, RedisPort: String;
  Started: Boolean;
  StartedAt: Cardinal;
begin
  Result := '';
  NeedsRestart := False;
  AppDir := ExpandConstant('{app}');
  InstanceRoot := ExpandConstant('{param:DesktopInstanceRoot|}');
  FrontendPort := ExpandConstant('{param:FrontendPort|}');
  ApiPort := ExpandConstant('{param:ApiPort|}');
  RedisPort := ExpandConstant('{param:RedisPort|}');
  // Isolated ports require a data root. Reject them before touching the target.
  if (InstanceRoot = '') and
     ((FrontendPort <> '') or (ApiPort <> '') or (RedisPort <> '')) then begin
    Log('Identity helper rejected: isolated port parameters require DesktopInstanceRoot');
    Result := 'Isolated ports require an explicit DesktopInstanceRoot.';
    exit;
  end;
  // Save/validate identity before InstallDelete replaces desktop-dist.
  if not ExtractPreparationHelper('configure-desktop-instance.ps1', 'identity-extract', 'SetupLoadIdentity') then begin
    Result := CustomMessage('SetupHelperFailed');
    exit;
  end;
  Cmd := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}') +
         '\configure-desktop-instance.ps1" -AppDir "' + AppDir + '"';
  // PowerShell may bind the next switch as the value of an empty argument.
  if InstanceRoot <> '' then begin
    Cmd := Cmd + ' -InstanceRoot "' + InstanceRoot + '"';
    if FrontendPort <> '' then Cmd := Cmd + ' -FrontendPort "' + FrontendPort + '"';
    if ApiPort <> '' then Cmd := Cmd + ' -ApiPort "' + ApiPort + '"';
    if RedisPort <> '' then Cmd := Cmd + ' -RedisPort "' + RedisPort + '"';
  end;
  ShowPreparationBody(WizardForm.PreparingLabel, 'SetupCheckIdentity');
  Log('Setup stage identity-check: started');
  Log('Identity helper command: ' + Cmd);
  StartedAt := GetTickCount;
  Started := ExecAndLogOutput(
    'powershell.exe', Cmd, '', SW_HIDE, ewWaitUntilTerminated, ExitCode, @ExtractionOutput);
  FinishSetupStage('identity-check', StartedAt, ', started=' + IntToStr(Ord(Started)) + ', exit=' + IntToStr(ExitCode));
  if (not Started) or (ExitCode <> 0) then begin
    Result := CustomMessage('SetupIdentityFailed');
    exit;
  end;
  if not ExtractPreparationHelper('stop-installed-desktop.ps1', 'shutdown-extract', 'SetupLoadShutdown') then begin
    Result := CustomMessage('SetupHelperFailed');
    exit;
  end;
  // Upgrade and uninstall share identity-bound coordinated shutdown and cleanup.
  Cmd := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}') +
         '\stop-installed-desktop.ps1" -AppDir "' + AppDir + '"';
  if InstanceRoot <> '' then Cmd := Cmd + ' -InstanceRoot "' + InstanceRoot + '"';
  ShowPreparationBody(WizardForm.PreparingLabel, 'SetupWaitForExit');
  Log('Setup stage shutdown: started');
  StartedAt := GetTickCount;
  Started := ExecAsOriginalUser('powershell.exe', Cmd, '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
  FinishSetupStage('shutdown', StartedAt, ', started=' + IntToStr(Ord(Started)) + ', exit=' + IntToStr(ExitCode));
  if (not Started) or (ExitCode <> 0) then begin
    Result := CustomMessage('SetupShutdownFailed');
    exit;
  end;
  WizardForm.PreparingLabel.Visible := False;
  FileUseStage := fuPending;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  // Inno re-enters wpPreparing after successful script preparation only when
  // it will query Restart Manager. It owns any resulting file-in-use prompt.
  if CurPageID = wpPreparing then begin
    // Back from a file-in-use prompt must restore the actual Ready summary.
    if ReadyCaption <> '' then begin
      WizardForm.ReadyLabel.Caption := ReadyCaption;
      WizardForm.AdjustLabelHeight(WizardForm.ReadyLabel);
      WizardForm.ReadyMemo.Visible := ReadyMemoWasVisible;
      ReadyCaption := '';
    end;
    if FileUseStage = fuPending then begin
      FileUseStage := fuChecking;
      ShowPreparationBody(WizardForm.PreparingLabel, 'SetupCheckFilesInUse');
      Log('Setup stage file-use-check: started (Windows Restart Manager handoff)');
      FileUseStartedAt := GetTickCount;
    end else if (FileUseStage = fuChecking) and not WizardSilent and WizardForm.PreparingMemo.Visible then begin
      FinishSetupStage('file-use-check', FileUseStartedAt, ', outcome=prompt');
      FileUseStage := fuPrompt;
      Log('Setup stage file-use-prompt: started');
      FileUseStartedAt := GetTickCount;
    end;
  end else if CurPageID = wpInstalling then begin
    if FileUseStage = fuChecking then
      FinishSetupStage('file-use-check', FileUseStartedAt, ', outcome=installing');
    FileUseStage := fuNone;
    FinishSetupStage('preparation', PreparationStartedAt, ', outcome=installing');
  end else if (CurPageID = wpReady) and (FileUseStage = fuPrompt) then begin
    FinishSetupStage('file-use-prompt', FileUseStartedAt, ', outcome=returned-to-ready');
    FileUseStage := fuNone;
  end;
end;

procedure DeinitializeSetup;
begin
  if FileUseStage = fuPrompt then
    FinishSetupStage('file-use-prompt', FileUseStartedAt, ', outcome=setup-exited');
end;

procedure BeginPayloadReplacement;
begin
  WizardForm.StatusLabel.Caption := CustomMessage('SetupReplacePayload');
  WizardForm.StatusLabel.Update;
  Log('Setup stage payload-replacement: started');
  ReplacementStartedAt := GetTickCount;
end;

procedure EndPayloadReplacement;
begin
  FinishSetupStage('payload-replacement', ReplacementStartedAt, '');
end;
