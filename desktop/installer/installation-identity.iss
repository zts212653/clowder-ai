var
  UninstallIdentityDiagnostic: String;

procedure UninstallIdentityOutput(const S: String; const Error, FirstLine: Boolean);
begin
  Log(S);
  if (Trim(S) <> '') and (Length(UninstallIdentityDiagnostic) < 1500) then
    UninstallIdentityDiagnostic := UninstallIdentityDiagnostic + S + #13#10;
end;

// Called before any UninstallRun, registered-file removal or UninstallDelete.
// Never invoke configuration's write path while deciding whether removal is safe.
function InitializeUninstall(): Boolean;
var
  AppDir, Helper, Cmd: String;
  ExitCode: Integer;
begin
  Result := False;
  AppDir := ExpandConstant('{app}');
  Helper := AppDir + '\scripts\configure-desktop-instance.ps1';
  UninstallIdentityDiagnostic := '';
  if not FileExists(Helper) then
    UninstallIdentityDiagnostic := 'Required data-boundary helper is missing: ' + Helper
  else begin
    Cmd := '-NoProfile -ExecutionPolicy Bypass -File "' + Helper + '" -AppDir "' + AppDir + '" -ValidateOnly';
    try
      Result := ExecAndLogOutput('powershell.exe', Cmd, '', SW_HIDE, ewWaitUntilTerminated,
        ExitCode, @UninstallIdentityOutput);
      Result := Result and (ExitCode = 0);
    except
      UninstallIdentityDiagnostic := GetExceptionMessage;
      Result := False;
    end;
  end;
  if not Result then begin
    Log('Uninstall refused by data-boundary validation: ' + UninstallIdentityDiagnostic);
    SuppressibleMsgBox('Cannot safely uninstall this installation: ' + AppDir + #13#10 +
      UninstallIdentityDiagnostic + #13#10 +
      'No removal was started. Keep the instance marker and data; repair or explicitly migrate them before retrying.',
      mbCriticalError, MB_OK, IDOK);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
  Cmd, AppDir, InstanceRoot, FrontendPort, ApiPort, RedisPort: String;
  Started: Boolean;
begin
  Result := '';
  NeedsRestart := False;
  AppDir := ExpandConstant('{app}');
  InstanceRoot := ExpandConstant('{param:DesktopInstanceRoot|}');
  FrontendPort := ExpandConstant('{param:FrontendPort|}');
  ApiPort := ExpandConstant('{param:ApiPort|}');
  RedisPort := ExpandConstant('{param:RedisPort|}');
  // Isolated ports are meaningless without an explicit instance root: blindly
  // ignoring them would install over the default instance. Fail closed before
  // touching the target, matching configure-desktop-instance.ps1's last check.
  if (InstanceRoot = '') and
     ((FrontendPort <> '') or (ApiPort <> '') or (RedisPort <> '')) then begin
    Log('Identity helper rejected: isolated port parameters require DesktopInstanceRoot');
    Result := 'Isolated ports require an explicit DesktopInstanceRoot.';
    exit;
  end;
  // Save/validate identity before InstallDelete replaces desktop-dist.
  ExtractTemporaryFile('configure-desktop-instance.ps1');
  Cmd := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}') +
         '\configure-desktop-instance.ps1" -AppDir "' + AppDir + '"';
  // Do not pass empty named arguments. Windows PowerShell's command-line
  // parser can bind a following switch as the value of an empty argument;
  // that makes a clean install fail before the helper reaches its no-op path.
  // InstanceRoot is not a master switch: each isolated parameter is optional
  // on its own, so only forward the ones that actually carry a value.
  if InstanceRoot <> '' then begin
    Cmd := Cmd + ' -InstanceRoot "' + InstanceRoot + '"';
    if FrontendPort <> '' then Cmd := Cmd + ' -FrontendPort "' + FrontendPort + '"';
    if ApiPort <> '' then Cmd := Cmd + ' -ApiPort "' + ApiPort + '"';
    if RedisPort <> '' then Cmd := Cmd + ' -RedisPort "' + RedisPort + '"';
  end;
  Log('Identity helper command: ' + Cmd);
  // Preserve the original diagnostics contract: the identity helper's output,
  // including stderr, must reach Setup's log so a refused install records the
  // real cause instead of only a generic message.
  Started := ExecAndLogOutput(
    'powershell.exe', Cmd, '', SW_HIDE, ewWaitUntilTerminated, ExitCode,
    @ExtractionOutput);
  Log('Identity helper started=' + IntToStr(Ord(Started)) + ', exit=' + IntToStr(ExitCode));
  if (not Started) or (ExitCode <> 0) then begin
    Result := 'Unable to preserve the target installation identity. See setup log.';
    exit;
  end;
  ExtractTemporaryFile('stop-installed-desktop.ps1');
  // Upgrade and uninstall share identity-bound coordinated shutdown and cleanup.
  Cmd := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}') +
         '\stop-installed-desktop.ps1" -AppDir "' + AppDir + '"';
  if InstanceRoot <> '' then Cmd := Cmd + ' -InstanceRoot "' + InstanceRoot + '"';
  ExecAsOriginalUser(
    'powershell.exe', Cmd, '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
  if ExitCode <> 0 then Result := 'Unable to stop the target installation safely.';
end;
