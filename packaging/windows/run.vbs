' WhatsOps background service for Windows: started hidden at sign-in (HKCU Run) by WhatsOps.vbs.
' Runs the current version and starts it again when it exits (after an update or a crash).
Option Explicit
Dim sh, fso, rt, v, rc, fails, t0, env

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
rt = fso.GetParentFolderName(WScript.ScriptFullName)
Set env = sh.Environment("Process")
env("WA_RUNTIME_DIR") = rt
env("WA_SUPERVISED") = "1"
env("WA_HOST") = "127.0.0.1"
If env("WA_PORT") = "" Then env("WA_PORT") = "8810"

fails = 0
Do
  If fso.FileExists(rt & "\stop") Then Exit Do
  v = Trim(fso.OpenTextFile(rt & "\current", 1).ReadAll)
  t0 = Now
  rc = sh.Run("""" & rt & "\" & v & "\node\node.exe"" """ & rt & "\" & v & "\app\dist\main.js""", 0, True)
  ' 3 = another WhatsOps already runs for this user
  If rc = 3 Then Exit Do
  If DateDiff("s", t0, Now) < 60 Then fails = fails + 1 Else fails = 0
  If fails >= 5 Then
    WScript.Sleep 60000
  Else
    WScript.Sleep 2000
  End If
Loop
