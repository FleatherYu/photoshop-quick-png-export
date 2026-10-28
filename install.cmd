@echo off
setlocal
title PNG Smart Export - install
echo Installing the PNG Smart Export panel for Photoshop CC 2019+ ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1"
if errorlevel 1 (
    echo.
    echo INSTALL FAILED - see the messages above.
) else (
    echo.
    echo Done. Fully quit and reopen Photoshop, then open:
    echo   Window ^> Extensions ^> PNG Smart Export
)
echo.
pause
