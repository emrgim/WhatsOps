' WhatsOps for Windows - double-click to install (first time) and open WhatsOps.
'
'  - copies the runtime next to this file (Node + WhatsOps) to %LOCALAPPDATA%\mcp-mrg-whatsops\runtime\<version>
'    when it is newer than the installed one (the auto-update installs newer versions there by itself);
'  - starts WhatsOps hidden in the background, and at every Windows sign-in (HKCU Run);
'  - adds WhatsOps to the Start menu;
'  - opens http://127.0.0.1:8810 already signed in (one-time link).
Option Explicit
Dim sh, fso, here, seed, data, rt, port, ver, cur, changed, i, url, tmp, node, cli, pid, lnk, quiet, lf

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
seed = here & "\runtime"
data = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\mcp-mrg-whatsops"
rt = data & "\runtime"
port = "8810"

Function ReadText(p)
  ReadText = ""
  If fso.FileExists(p) Then
    Dim f : Set f = fso.OpenTextFile(p, 1)
    If Not f.AtEndOfStream Then ReadText = Trim(f.ReadAll)
    f.Close
  End If
End Function

Sub WriteText(p, s)
  Dim f : Set f = fso.CreateTextFile(p, True)
  f.Write s
  f.Close
End Sub

Function Newer(a, b) ' is version a newer than b (x.y.z)?
  Dim pa, pb, k, x, y
  pa = Split(a, ".") : pb = Split(b, ".")
  Newer = False
  For k = 0 To 2
    x = 0 : y = 0
    If k <= UBound(pa) Then x = CLng(pa(k))
    If k <= UBound(pb) Then y = CLng(pb(k))
    If x > y Then Newer = True : Exit Function
    If x < y Then Exit Function
  Next
End Function

Function Healthy()
  On Error Resume Next
  Dim http : Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 2000, 2000
  http.Open "GET", "http://127.0.0.1:" & port & "/healthz", False
  http.Send
  Healthy = (Err.Number = 0 And http.Status = 200)
  On Error GoTo 0
End Function

If Not fso.FolderExists(data) Then fso.CreateFolder data
If Not fso.FolderExists(rt) Then fso.CreateFolder rt
' installed again after an uninstall: the service may run again
If fso.FileExists(rt & "\stop") Then fso.DeleteFile rt & "\stop", True
quiet = (sh.ExpandEnvironmentStrings("%WHATSOPS_NO_BROWSER%") <> "%WHATSOPS_NO_BROWSER%")

' ---- install / upgrade from the runtime next to this file
changed = False
If fso.FolderExists(seed) Then
  ver = ReadText(seed & "\VERSION")
  cur = ReadText(rt & "\current")
  If cur = "" Or Not fso.FileExists(rt & "\" & cur & "\node\node.exe") Or Newer(ver, cur) Then
    If fso.FolderExists(rt & "\" & ver & ".part") Then fso.DeleteFolder rt & "\" & ver & ".part", True
    fso.CopyFolder seed, rt & "\" & ver & ".part", True
    If fso.FileExists(rt & "\" & ver & ".part\VERSION") Then fso.DeleteFile rt & "\" & ver & ".part\VERSION", True
    If fso.FolderExists(rt & "\" & ver) Then fso.DeleteFolder rt & "\" & ver, True
    fso.MoveFolder rt & "\" & ver & ".part", rt & "\" & ver
    If cur <> "" And cur <> ver Then WriteText rt & "\previous", cur
    WriteText rt & "\current", ver
    changed = True
  End If
  ' keep a copy of this launcher with the runtime: the Start menu entry uses it
  If LCase(fso.GetParentFolderName(WScript.ScriptFullName)) <> LCase(rt) Then
    fso.CopyFile WScript.ScriptFullName, rt & "\WhatsOps.vbs", True
    If fso.FileExists(here & "\WhatsOps.ico") Then fso.CopyFile here & "\WhatsOps.ico", rt & "\WhatsOps.ico", True
  End If
End If
cur = ReadText(rt & "\current")
If cur = "" Then
  If quiet Then WScript.Echo "WhatsOps is not installed" Else MsgBox "WhatsOps is not installed: open the WhatsOps folder you downloaded and run WhatsOps.vbs there.", vbExclamation, "WhatsOps"
  WScript.Quit 1
End If
fso.CopyFile rt & "\" & cur & "\app\packaging\windows\run.vbs", rt & "\run.vbs", True

' ---- start at sign-in, Start menu
sh.RegWrite "HKCU\Software\Microsoft\Windows\CurrentVersion\Run\WhatsOps", """" & sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\wscript.exe"" """ & rt & "\run.vbs""", "REG_SZ"
' the setup (WhatsOps-...-setup.exe) makes its own Start menu entry and uninstaller
If Not fso.FileExists(here & "\unins000.exe") Then
  Set lnk = sh.CreateShortcut(sh.SpecialFolders("Programs") & "\WhatsOps.lnk")
  lnk.TargetPath = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\wscript.exe"
  lnk.Arguments = """" & rt & "\WhatsOps.vbs"""
  lnk.WorkingDirectory = rt
  If fso.FileExists(rt & "\WhatsOps.ico") Then lnk.IconLocation = rt & "\WhatsOps.ico"
  lnk.Description = "WhatsOps"
  lnk.Save
End If

' ---- (re)start the service
If changed And Healthy() Then
  ' a new version was installed: stop the old one, run.vbs starts the new one
  pid = ReadText(data & "\service.lock")
  If pid <> "" Then sh.Run "taskkill /PID " & pid & " /F", 0, True
  WScript.Sleep 3000
End If
If Not Healthy() Then sh.Run """" & sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\wscript.exe"" """ & rt & "\run.vbs""", 0, False
For i = 1 To 120
  If Healthy() Then Exit For
  WScript.Sleep 500
Next

' ---- open the page, already signed in
node = rt & "\" & cur & "\node\node.exe"
cli = rt & "\" & cur & "\app\dist\cli.js"
tmp = data & "\login-link.txt"
If fso.FileExists(tmp) Then fso.DeleteFile tmp, True
sh.Environment("Process")("WA_PORT") = port
sh.Run """" & node & """ """ & cli & """ login-link --local --minutes 2 --out """ & tmp & """", 0, True
url = ReadText(tmp)
If fso.FileExists(tmp) Then fso.DeleteFile tmp, True
If quiet Then
  ' silent run (tests, scripts): print the sign-in link instead of opening the browser
  lf = sh.ExpandEnvironmentStrings("%WHATSOPS_LINK_OUT%")
  If lf <> "%WHATSOPS_LINK_OUT%" Then WriteText lf, url
  WScript.Echo url
  If Left(url, 4) = "http" Then WScript.Quit 0 Else WScript.Quit 1
End If
If Left(url, 4) = "http" Then
  sh.Run url
Else
  MsgBox "WhatsOps did not start. Log: " & data & "\logs", vbExclamation, "WhatsOps"
  sh.Run "http://127.0.0.1:" & port & "/"
End If
