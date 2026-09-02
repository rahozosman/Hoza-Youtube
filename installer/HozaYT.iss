; Hoza YT -- Windows installer
;
; Built by build/build.py, which passes the version, the extension id and the
; paths. Compiling this file directly will fail on purpose: the values below
; come from the build so there is only ever one place a version is set.
;
; The install is per-user by design. Everything the product needs -- the engine,
; the media tools, the browser's native messaging registration -- lives under
; the signed-in user's own profile, so nothing here asks for administrator
; rights, and nothing it writes can affect another account on the machine.

#ifndef AppVersion
  #error Build this through: python build/build.py
#endif

#define AppName        "Hoza YT"
#define AppPublisher   "Rahoz Osman"
#define AppExeName     "HozaYT.exe"
#define AppUrl         "https://github.com/rahozosman/download-youtube-vedio"

[Setup]
AppId={{8F3A7C21-5B4E-4D9A-9E62-1C7D4A0B6E58}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoCompany={#AppPublisher}

; Per-user, and only per-user, so the whole installation runs without a single
; elevation prompt. This is not a limitation being worked around: the browser
; registration a native messaging host needs is written under HKEY_CURRENT_USER,
; so an "install for everyone" mode would put the program where everyone can
; reach it and connect it for nobody but the account that ran setup. One mode
; that works beats two modes where one of them quietly does not.
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\HozaYT
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
AllowNoIcons=yes

OutputDir={#OutputDir}
OutputBaseFilename=HozaYT-Setup
SetupIconFile={#SourceRoot}\installer\assets\hozayt.ico
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}

WizardStyle=modern
WizardSizePercent=110
SolidCompression=yes
Compression=lzma2/max
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
MinVersion=10.0
CloseApplications=yes
RestartApplications=no
SetupLogging=yes

LicenseFile={#SourceRoot}\installer\assets\LICENSE.txt

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
WelcomeLabel2=This will install [name/ver] on your computer.%n%nHoza YT installs everything it needs: the local engine, the media tools and the connection your browser uses to reach them. Nothing else has to be installed, and nothing has to be started by hand.
FinishedHeadingLabel=Hoza YT is installed
ClickFinish=There is one short step left in your browser. Setup can open it for you now.

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut for the dashboard"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
; The engine, the bundled runtime, the media tools and the extension, exactly
; as build/build.py laid them out.
Source: "{#SourceRoot}\dist\HozaYT\*"; DestDir: "{app}"; \
    Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName} dashboard"; Filename: "{app}\{#AppExeName}"; \
    Comment: "Open the Hoza YT dashboard"
Name: "{group}\Finish browser setup"; Filename: "{app}\{#AppExeName}"; \
    Parameters: "--setup"; Comment: "Add the Hoza YT extension to your browser"
Name: "{group}\Check the installation"; Filename: "{app}\{#AppExeName}"; \
    Parameters: "--verify"; Comment: "Confirm Hoza YT is working"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Registry]
; Version detection for the next upgrade, and for anything that wants to know
; whether the engine is present without hunting for files.
Root: HKCU; Subkey: "Software\HozaYT"; ValueType: string; \
    ValueName: "Version"; ValueData: "{#AppVersion}"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\HozaYT"; ValueType: string; \
    ValueName: "InstallPath"; ValueData: "{app}"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\HozaYT"; ValueType: string; \
    ValueName: "ExtensionId"; ValueData: "{#ExtensionId}"; \
    Flags: uninsdeletevalue uninsdeletekeyifempty

[Run]
; The finish page's own checkbox. Everything that must happen without being
; asked has already happened by this point; this is only the browser step.
Filename: "{app}\{#AppExeName}"; Parameters: "--setup"; \
    Description: "Finish setting up in my browser"; \
    Flags: postinstall nowait skipifsilent

[UninstallRun]
; Stop the engine before its files go, and take the browser registration with
; it. Anything the user made -- downloads, history, settings -- is left alone.
Filename: "{app}\{#AppExeName}"; Parameters: "--stop"; \
    Flags: runhidden waituntilterminated; RunOnceId: "StopEngine"
Filename: "{app}\{#AppExeName}"; Parameters: "--unregister"; \
    Flags: runhidden waituntilterminated; RunOnceId: "Unregister"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\extension"
Type: filesandordirs; Name: "{app}\licenses"
Type: files; Name: "{app}\com.hoza.yt.server.json"
Type: files; Name: "{app}\com.hoza.yt.server.firefox.json"
Type: dirifempty; Name: "{app}"

[Code]
const
  DataRoot = '{localappdata}\HozaYT';

var
  VerifyFailed: Boolean;
  VerifyDetail: String;

{ ----------------------------------------------------------------------------
  Running the engine during setup.

  Every call is the installed executable acting on itself: registering with the
  browsers, starting, checking. Nothing is scripted here that the product
  cannot also do on its own afterwards, which is what makes Repair work.
  ---------------------------------------------------------------------------- }

function RunEngine(Params: String; var ResultCode: Integer): Boolean;
begin
  Result := Exec(ExpandConstant('{app}\{#AppExeName}'), Params, '',
                 SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure Status(const Text: String);
begin
  WizardForm.StatusLabel.Caption := Text;
  WizardForm.Refresh;
end;

{ ----------------------------------------------------------------------------
  Upgrades

  A previous version may be running: the backend, its manager, or a native
  host Chrome started. None of them can be replaced while they hold their own
  files open, so they are asked to stop first.
  ---------------------------------------------------------------------------- }

function PreviousInstallPath(): String;
begin
  if not RegQueryStringValue(HKCU, 'Software\HozaYT', 'InstallPath', Result) then
    Result := '';
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Previous: String;
  ResultCode: Integer;
begin
  Result := '';
  Previous := PreviousInstallPath();
  if (Previous <> '') and FileExists(Previous + '\{#AppExeName}') then
  begin
    Status('Stopping the running version...');
    Exec(Previous + '\{#AppExeName}', '--stop', '', SW_HIDE,
         ewWaitUntilTerminated, ResultCode);
    { Chrome may still hold a native host process against the old binary.
      A moment is enough for it to exit once its pipe has gone. }
    Sleep(1500);
  end;
end;

{ ----------------------------------------------------------------------------
  After the files are in place

  This is where an installation becomes a working product: the browsers are
  told where the native host is, the engine is started, and the result is
  checked rather than assumed.
  ---------------------------------------------------------------------------- }

procedure ConfigureAndVerify();
var
  ResultCode: Integer;
begin
  VerifyFailed := False;
  VerifyDetail := '';

  Status('Connecting Hoza YT to your browser...');
  if not RunEngine('--register', ResultCode) or (ResultCode <> 0) then
  begin
    VerifyFailed := True;
    VerifyDetail := 'The browser connection could not be registered.';
    Exit;
  end;

  Status('Starting the local engine...');
  { --verify starts the engine, waits for it to answer, and speaks to the
    native host over the same channel Chrome uses. }
  Status('Checking that everything works...');
  if not RunEngine('--verify', ResultCode) or (ResultCode <> 0) then
  begin
    VerifyFailed := True;
    VerifyDetail := 'The local engine did not start correctly.';
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    ConfigureAndVerify();
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
  begin
    if VerifyFailed then
    begin
      WizardForm.FinishedLabel.Caption :=
        'Hoza YT is installed, but the check did not pass.' + #13#10#13#10 +
        VerifyDetail + #13#10#13#10 +
        'Restarting the computer and opening Hoza YT from the Start menu ' +
        'usually resolves this. "Check the installation" in the Start menu ' +
        'reports what is wrong.';
    end
    else
    begin
      WizardForm.FinishedLabel.Caption :=
        'Installation completed successfully.' + #13#10#13#10 +
        'The local engine, the media tools and the browser connection are ' +
        'installed and working. The engine starts by itself whenever your ' +
        'browser needs it, and stops when you close your browser.' + #13#10#13#10 +
        'One short step is left: adding the extension to your browser. ' +
        'Setup can open a page that walks you through it.';
    end;
  end;
end;

{ ----------------------------------------------------------------------------
  Uninstall

  Files, registration and engine go. What the user made stays, unless they say
  otherwise on the way out.
  ---------------------------------------------------------------------------- }

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Data: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    Data := ExpandConstant(DataRoot);
    if DirExists(Data) then
    begin
      if MsgBox('Remove your Hoza YT settings and download history as well?'
                + #13#10#13#10
                + 'Your downloaded files are never touched. Choosing No keeps '
                + 'your settings for a future installation.',
                mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(Data, True, True, True);
    end;
  end;
end;
