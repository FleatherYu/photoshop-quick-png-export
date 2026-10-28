@echo off
setlocal
title Photoshop Quick PNG Export - uninstall
echo Removing the Photoshop Quick PNG Export panel ...
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
