@echo off
chcp 65001 >nul
cd /d "%~dp0"
set GIT="C:\Program Files\Git\cmd\git.exe"

echo === using local proxy 127.0.0.1:7890 for GitHub ===
%GIT% config http.proxy  http://127.0.0.1:7890
%GIT% config https.proxy http://127.0.0.1:7890

echo.
echo === changes ===
%GIT% status --short

echo.
set /p msg=Commit message (Enter = default): 
if "%msg%"=="" set msg=update site

%GIT% add -A
%GIT% commit -m "%msg%"
echo.
echo === push to https://github.com/beishanghai321/prompt ===
%GIT% push

echo.
echo exit code: %ERRORLEVEL%
echo Cloudflare Pages will rebuild automatically after push.
pause