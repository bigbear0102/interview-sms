# 웹 앱과 터널을 깨끗하게 재시작한다. (코드를 바꾼 뒤 실행)
# 사용: powershell -ExecutionPolicy Bypass -File deploy\windows\restart.ps1
# Stop-ScheduledTask 만으로는 자식 node 프로세스가 남아 옛 코드가 계속 서비스될 수 있어 직접 정리한다.
Stop-ScheduledTask interview-sms-web -ErrorAction SilentlyContinue
Stop-ScheduledTask interview-sms-tunnel -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*src/node/server.js*') -or
  ($_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like '*interview-sms.yml*') -or
  ($_.Name -eq 'cmd.exe' -and ($_.CommandLine -like '*run-web.cmd*' -or $_.CommandLine -like '*run-tunnel.cmd*'))
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2
Start-ScheduledTask interview-sms-web
Start-ScheduledTask interview-sms-tunnel
Start-Sleep -Seconds 10
try { "web: " + (Invoke-WebRequest http://127.0.0.1:8787/healthz -UseBasicParsing).StatusCode } catch { "web: FAILED" }
