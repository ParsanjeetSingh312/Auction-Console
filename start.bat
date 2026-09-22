@echo off
REM start.bat
REM The same launcher as start.ps1, for Command Prompt.
REM
REM `.\start.ps1` only works in PowerShell. Typed into cmd.exe -- which is what
REM the VS Code terminal opens by default on this machine -- it fails with
REM "'.\start.ps1' is not recognized as an internal or external command",
REM because cmd has no idea how to execute a .ps1 file.
REM
REM This forwards to the real script rather than duplicating it, so there is
REM still exactly one place where the build-then-serve order is defined. Every
REM flag works unchanged:
REM
REM   start.bat                 build, then serve on 8001
REM   start.bat -SkipBuild      serve only (no frontend code changed)
REM   start.bat -Port 8002      serve on a different port
REM   start.bat -Reload         restart on backend .py changes
REM
REM -ExecutionPolicy Bypass applies to this one invocation only; it does not
REM change any policy on the machine. Without it a default Windows policy of
REM Restricted refuses to run the script at all.
REM
REM %~dp0 is this file's own directory, so the script is found no matter which
REM directory you happen to be in when you run it.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
