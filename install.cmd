@echo off
setlocal
title Photoshop Quick PNG Export - install
echo Installing Photoshop Quick PNG Export for Photoshop CC 2019+ ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1"
if errorlevel 1 (
    echo.
    echo INSTALL FAILED - see the messages above.
) else (
    echo.
    echo Done. Fully quit and reopen Photoshop, then open:
    echo   Window ^> Extensions ^> Photoshop Quick PNG Export
)
echo.
pause
