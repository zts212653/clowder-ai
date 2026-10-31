var
  RuntimeFailure: String;
  RuntimeExtractionBusy: Boolean;
  RuntimeExtractionWindowRestored: Boolean;

function RuntimeExtractionSucceeded(): Boolean;
begin
  Result := RuntimeFailure = '';
end;

procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  if RuntimeExtractionBusy then begin
    Cancel := False;
    Confirm := False;
    exit;
  end;
  if not RuntimeExtractionSucceeded then begin
    Cancel := True;
    Confirm := False;
  end;
end;

function GetCustomSetupExitCode(): Integer;
begin
  if RuntimeFailure <> '' then Result := 20 else Result := 0;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = wpFinished) and not RuntimeExtractionSucceeded;
end;

procedure FailRuntimeExtraction(Message: String);
begin
  if not RuntimeExtractionSucceeded then exit;
  RuntimeFailure := Message;
  Log('Runtime installation failed: ' + RuntimeFailure);
  SuppressibleMsgBox(RuntimeFailure + #13#10 +
    'Installation did not complete. Your instance data is retained. Run this installer again to repair it.',
    mbCriticalError, MB_OK, IDOK);
  // AfterInstall exceptions alone can be caught and continued by Setup.
  // Request cancellation and retain the nonzero exit latch even with /NOCANCEL.
  WizardForm.Close;
end;
