# Windows 로그온 시 자동 시작 작업을 등록한다. (관리자 PowerShell에서 1회 실행)
# 사용: powershell -ExecutionPolicy Bypass -File scripts\install-windows-task.ps1
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "--env-file-if-exists=.env src/server.js" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "interview-sms" -Action $action -Trigger $trigger -Settings $settings -Force
Write-Host "등록 완료: 작업 스케줄러의 'interview-sms' (제거: Unregister-ScheduledTask interview-sms)"
