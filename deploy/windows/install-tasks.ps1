# Windows 로그온 시 웹 앱과 Cloudflare Tunnel 을 자동 시작하는 작업을 등록한다.
# (게이트웨이는 Docker 컨테이너라 Docker Desktop 시작 시 restart: unless-stopped 로 자동 복구된다)
# 사용: powershell -ExecutionPolicy Bypass -File deploy\windows\install-tasks.ps1
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
New-Item -ItemType Directory -Force (Join-Path $root 'data') | Out-Null

$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# 실행 루프 스크립트를 숨김 창으로 실행한다 (종료 시 스스로 재시작)
$web = New-ScheduledTaskAction -Execute 'cmd.exe' -WorkingDirectory $root -Argument ('/c "' + (Join-Path $PSScriptRoot 'run-web.cmd') + '"')
$tun = New-ScheduledTaskAction -Execute 'cmd.exe' -WorkingDirectory $root -Argument ('/c "' + (Join-Path $PSScriptRoot 'run-tunnel.cmd') + '"')

Register-ScheduledTask -TaskName 'interview-sms-web' -Action $web -Trigger $trigger -Settings $settings -Force | Out-Null
Register-ScheduledTask -TaskName 'interview-sms-tunnel' -Action $tun -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host 'registered: interview-sms-web, interview-sms-tunnel (remove: Unregister-ScheduledTask <name>)'
