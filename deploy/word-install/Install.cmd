@echo off
rem Installs the langfAIx add-in for Word on this computer, for the current user only.
rem Double-click this file. It runs install-word-addin.ps1 from the same folder.
rem No administrator rights are needed.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-word-addin.ps1" %*
echo.
pause
