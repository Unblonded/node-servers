# Sets up the "Node servers" service: a Windows task that runs run.cmd when the PC turns on, as you,
# before anyone logs in, and starts it again if it ever stops. install.bat runs this as administrator.
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$task = 'Node servers'

function Ask($question) {
  $answer = Read-Host "$question (Y/n)"
  return ($answer -eq '' -or $answer -match '^[Yy]')
}

Write-Host ''
Write-Host '=== Node servers: setup ===' -ForegroundColor Cyan

# Node and git, recorded so the service finds them even before anyone logs in.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js isn''t installed (or isn''t on PATH). Install it from https://nodejs.org and run this again.' }
Set-Content -Path (Join-Path $here 'node-path.txt') -Value $node -NoNewline
Write-Host "Node: $node ($(& $node --version))"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Host 'Git isn''t installed, so servers won''t update themselves. Get it from https://git-scm.com' -ForegroundColor Yellow }

# The list of servers.
$list = Join-Path $here 'servers.json'
if (-not (Test-Path $list)) {
  Copy-Item (Join-Path $here 'servers.example.json') $list
  Write-Host ''
  Write-Host 'Made servers.json from the example. Opening it now: put in your servers (name, folder, start command), save, and close Notepad.' -ForegroundColor Yellow
  Start-Process notepad.exe $list -Wait
}
try { $servers = (Get-Content $list -Raw | ConvertFrom-Json).servers } catch { throw "servers.json isn't valid JSON: $($_.Exception.Message)" }
foreach ($s in $servers) {
  if ($s.enabled -eq $false) { continue }
  $dir = if ([IO.Path]::IsPathRooted($s.dir)) { $s.dir } else { Join-Path $here $s.dir }
  $mark = if (Test-Path $dir) { 'ok' } else { 'FOLDER NOT FOUND' }
  Write-Host ("  {0,-20} {1}  [{2}]" -f $s.name, $dir, $mark)
}

# Capri's own start-server.bat in the Startup folder would start a second copy on the same port.
$startup = [Environment]::GetFolderPath('Startup')
$shell = New-Object -ComObject WScript.Shell
$old = Get-ChildItem $startup -Filter *.lnk -ErrorAction SilentlyContinue | Where-Object { $shell.CreateShortcut($_.FullName).TargetPath -match 'start-server\.bat$' }
if ($old) {
  Write-Host ''
  Write-Host "Found Capri's old start-up shortcut ($($old.Name)). The service runs Capri now, so it should go." -ForegroundColor Yellow
  if (Ask 'Remove it?') { $old | Remove-Item; Write-Host 'Removed.' }
  Write-Host 'Close the old "Capri server" window if it''s open, or the service''s Capri can''t use the port.' -ForegroundColor Yellow
}

# Runs as you, so servers can use your git sign-in (private repos), your npm and your files.
$user = "$env:USERDOMAIN\$env:USERNAME"
Write-Host ''
Write-Host "The servers will run as $user, whether or not you're logged in."
Write-Host 'Windows needs your password for that (a PIN won''t work; with a Microsoft account, use its password).'
$cred = Get-Credential -UserName $user -Message 'Your Windows password, so the servers can start before you log in'
if (-not $cred) { throw 'No password given; nothing was set up.' }

$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument "/c `"$here\run.cmd`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -AtStartup
# No time limit (Windows stops tasks after 3 days otherwise), and start it again if it stops.
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $task -Description 'Runs and auto-updates the Node servers in servers.json' `
  -Action $action -Trigger $trigger -Settings $settings -User $user -Password $cred.GetNetworkCredential().Password -RunLevel Highest -Force | Out-Null
Write-Host "Registered the '$task' task." -ForegroundColor Green

# A server PC that sleeps stops serving.
Write-Host ''
if (Ask 'Keep this PC from sleeping while it''s plugged in?') {
  powercfg /change standby-timeout-ac 0
  powercfg /change hibernate-timeout-ac 0
  Write-Host 'Sleep is off while plugged in.'
}

Start-ScheduledTask -TaskName $task
Write-Host ''
Write-Host 'Started. Opening the dashboard in a few seconds...' -ForegroundColor Green
for ($i = 0; $i -lt 20 -and -not (Test-Path (Join-Path $here 'dashboard.url')); $i++) { Start-Sleep -Milliseconds 500 }
if (Test-Path (Join-Path $here 'dashboard.url')) { Start-Process (Get-Content (Join-Path $here 'dashboard.url') -Raw).Trim() }
else { Write-Host 'The dashboard isn''t up yet: check logs\supervisor.log, or try open-dashboard.bat in a moment.' -ForegroundColor Yellow }
Write-Host ''
Write-Host 'Done. Edit servers.json any time (it applies when you save). open-dashboard.bat shows everything.'
