@echo off
setlocal
title PNG Smart Export - uninstall
echo Removing the PNG Smart Export panel ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall.ps1"
if errorlevel 1 (
    echo.
    echo UNINSTALL FAILED - see the messages above.
) else (
    echo.
    echo Done. Restart Photoshop to drop the panel from the Extensions menu.
)
echo.
pause
