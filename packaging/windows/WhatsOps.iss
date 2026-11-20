; WhatsOps setup for Windows (Inno Setup 6). Built by packaging/build.mjs on GitHub Actions:
;   ISCC.exe /DAppVer=<version> /DSrc=<folder with WhatsOps.vbs, runtime\, icon> /DOutDir=<dir> /DOutName=<file name> WhatsOps.iss
; Installs for the current user only (no administrator rights), in %LOCALAPPDATA%\Programs\WhatsOps.
; At the end WhatsOps.vbs starts the background service, adds it to the sign-in programs and opens the page.

[Setup]
AppId={{6F2B1C8E-3D47-4B8A-9E51-2A7D0C94F3B6}
AppName=WhatsOps
AppVersion={#AppVer}
AppVerName=WhatsOps {#AppVer}
AppPublisher=WhatsOps
AppPublisherURL=https://github.com/emrgim/WhatsOps
AppSupportURL=https://github.com/emrgim/WhatsOps/issues
AppUpdatesURL=https://github.com/emrgim/WhatsOps/releases
DefaultDirName={localappdata}\Programs\WhatsOps
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename={#OutName}
SetupIconFile={#Src}\WhatsOps.ico
UninstallDisplayIcon={app}\WhatsOps.ico
UninstallDisplayName=WhatsOps
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=no
ShowLanguageDialog=auto

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "it"; MessagesFile: "compiler:Languages\Italian.isl"

[CustomMessages]
en.DeleteData=Also delete your WhatsOps data (WhatsApp sessions, messages, settings)?
it.DeleteData=Eliminare anche i tuoi dati di WhatsOps (sessioni WhatsApp, messaggi, impostazioni)?

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#Src}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\WhatsOps"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\WhatsOps.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\WhatsOps.ico"; Comment: "WhatsOps"
Name: "{userdesktop}\WhatsOps"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\WhatsOps.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\WhatsOps.ico"; Tasks: desktopicon

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\WhatsOps.vbs"""; Description: "{cm:LaunchProgram,WhatsOps}"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\uninstall.vbs"""; Flags: runhidden waituntilterminated; RunOnceId: "StopWhatsOps"

[Code]
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Data: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    Data := ExpandConstant('{localappdata}\mcp-mrg-whatsops');
    // the copy of the program WhatsOps runs from (and updates itself in)
    DelTree(Data + '\runtime', True, True, True);
    if (not UninstallSilent) and (MsgBox(CustomMessage('DeleteData'), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES) then
      DelTree(Data, True, True, True);
  end;
end;
