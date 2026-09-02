' ---------------------------------------------------------------------------
' Hoza YT - silent watchdog launcher
'
' Runs watchdog.py with no console window. This is what the scheduled task
' points at, so the watchdog comes up at sign-in and keeps the server alive
' without anything appearing on the desktop.
'
' Run it by hand any time with:  wscript start-watchdog-hidden.vbs
' ---------------------------------------------------------------------------

Dim shell, fso, here, script

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(here, "watchdog.py")

If Not fso.FileExists(script) Then
  MsgBox "Hoza YT could not find:" & vbCrLf & script, vbExclamation, "Hoza YT"
  WScript.Quit 1
End If

shell.CurrentDirectory = here

' pythonw.exe runs without allocating a console at all. Fall back to python.exe
' with a hidden window if this install has no pythonw.
Dim runner
runner = "pythonw.exe"
On Error Resume Next
shell.Run """" & runner & """ """ & script & """", 0, False
If Err.Number <> 0 Then
  Err.Clear
  shell.Run "python.exe """ & script & """", 0, False
End If
On Error Goto 0
