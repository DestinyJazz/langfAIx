@echo off
rem Removes the langfAIx add-in from Word on this computer, for the current user only.
rem Double-click this file. It runs install-word-addin.ps1 from the same folder.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-word-addin.ps1" -Uninstall %*
echo.
pause
