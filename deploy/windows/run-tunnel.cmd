@echo off
rem Cloudflare Tunnel 실행 루프 (종료되면 5초 후 재시작).
cd /d "%~dp0..\.."
:loop
cloudflared tunnel --config "%USERPROFILE%\.cloudflared\interview-sms.yml" run >> data\tunnel.log 2>&1
timeout /t 5 /nobreak >nul
goto loop
