@echo off
rem 면접 웹 앱 실행 루프 (종료되면 5초 후 재시작). install-tasks.ps1 이 로그온 시 실행하도록 등록한다.
cd /d "%~dp0..\.."
:loop
node --env-file=.env src/node/server.js >> data\web.log 2>&1
timeout /t 5 /nobreak >nul
goto loop
