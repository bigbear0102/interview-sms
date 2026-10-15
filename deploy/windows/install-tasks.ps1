# Windows 로그온 시 웹 앱과 Cloudflare Tunnel 을 자동 시작하는 작업을 등록한다.
# (게이트웨이는 Docker 컨테이너라 Docker Desktop 시작 시 restart: unless-stopped 로 자동 복구된다)
# 사용: powershell -ExecutionPolicy Bypass -File deploy\windows\install-tasks.ps1
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$node = (Get-Command node).Source
$cf   = (Get-Command cloudflared).Source
$cfg  = Join-Path $env:USERPROFILE '.cloudflared\interview-sms.yml'
New-Item -ItemType Directory -Force (Join-Path $root 'data') | Out-Null

$settings = New-ScheduledTaskSettingsSet -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# cmd /c 로 감싸 로그 파일로 출력을 남긴다 (경로는 슬래시 사용)
$webArg = '/c ""' + $node + '" --env-file=.env src/node/server.js >> data/web.log 2>&1"'
$tunArg = '/c ""' + $cf + '" tunnel --config "' + $cfg + '" run >> data/tunnel.log 2>&1"'
$web = New-ScheduledTaskAction -Execute 'cmd.exe' -WorkingDirectory $root -Argument $webArg
$tun = New-ScheduledTaskAction -Execute 'cmd.exe' -WorkingDirectory $root -Argument $tunArg

Register-ScheduledTask -TaskName 'interview-sms-web' -Action $web -Trigger $trigger -Settings $settings -Force | Out-Null
Register-ScheduledTask -TaskName 'interview-sms-tunnel' -Action $tun -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host 'registered: interview-sms-web, interview-sms-tunnel (remove: Unregister-ScheduledTask <name>)'
