Option Explicit
Dim shell, files, root, command
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\scripts\launch.ps1"""
On Error Resume Next
shell.Run command, 0, False
If Err.Number <> 0 Then
  MsgBox "Could not start Control Center. Check that Windows PowerShell is available.", 16, "Control Center"
End If
