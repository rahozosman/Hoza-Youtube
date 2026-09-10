' ---------------------------------------------------------------------------
' Hoza YT - silent watchdog launcher
'
' Runs watchdog.py with no console window. This is what the scheduled task
' points at, so the watchdog comes up at sign-in and keeps the server alive
' without anything appearing on the desktop.
'
' It deliberately WAITS for the watchdog instead of firing and forgetting.
' Waiting is what makes the scheduled task useful: the task stays in the
' Running state for as long as the watchdog lives, so "restart on failure"
' applies to the watchdog itself and "ignore new instance" stops a second copy
' from ever being launched over the top of it.
'
' Run it by hand any time with:  wscript start-watchdog-hidden.vbs
' ---------------------------------------------------------------------------

Option Explicit

Dim shell, fso, here, script, code

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(here, "watchdog.py")

If Not fso.FileExists(script) Then
  MsgBox "Hoza YT could not find:" & vbCrLf & script, vbExclamation, "Hoza YT"
  WScript.Quit 1
End If

shell.CurrentDirectory = here

' pythonw.exe never allocates a console. Fall back to python.exe hidden if this
' install does not have it. 0 = hidden, True = wait for it to finish.
code = 1
On Error Resume Next
code = shell.Run("pythonw.exe """ & script & """", 0, True)
If Err.Number <> 0 Then
  Err.Clear
  code = shell.Run("python.exe """ & script & """", 0, True)
  If Err.Number <> 0 Then code = 1
End If
On Error Goto 0

' A non-zero exit tells Task Scheduler the action failed, which is what makes
' the restart-on-failure setting fire.
WScript.Quit code
