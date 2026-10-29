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

# The servers live next to this project, in deployment\ (one folder each), unless settings.json says otherwise.
$deploy = Join-Path (Split-Path -Parent $here) 'deployment'
$settingsFile = Join-Path $here 'settings.json'
if (Test-Path $settingsFile) {
  try {
    $custom = (Get-Content $settingsFile -Raw | ConvertFrom-Json).deployment
    if ($custom) { $deploy = if ([IO.Path]::IsPathRooted($custom)) { $custom } else { [IO.Path]::GetFullPath((Join-Path $here $custom)) } }
  } catch { Write-Host "settings.json has a mistake, so it's ignored here: $($_.Exception.Message)" -ForegroundColor Yellow }
}
New-Item -ItemType Directory -Force -Path $deploy | Out-Null
Write-Host ''
Write-Host "Servers go in: $deploy" -ForegroundColor Cyan
Write-Host '(one folder per server; each is found, installed and started automatically)'

# Bring in servers that already live somewhere else, like Capri. Moving the whole folder keeps its data
# (Capri's data\ folder holds everyone's sign-ins and notes) and its .env.
Write-Host ''
while ($true) {
  $from = (Read-Host 'Move an existing server folder in? Paste its path, or press Enter to skip').Trim('" ')
  if (-not $from) { break }
  if (-not (Test-Path $from -PathType Container)) { Write-Host "  Not a folder: $from" -ForegroundColor Yellow; continue }
  $dest = Join-Path $deploy (Split-Path -Leaf $from)
  if (Test-Path $dest) { Write-Host "  deployment\$(Split-Path -Leaf $from) already exists." -ForegroundColor Yellow; continue }
  try { Move-Item -LiteralPath $from -Destination $dest; Write-Host "  Moved to $dest" -ForegroundColor Green }
  catch { Write-Host "  Couldn't move it (is it still running? close its window first): $($_.Exception.Message)" -ForegroundColor Yellow }
}

# Or clone them from GitHub.
while ($true) {
  $repo = (Read-Host 'Clone a server from GitHub? Paste its address, or press Enter to skip').Trim()
  if (-not $repo) { break }
  $name = ($repo.TrimEnd('/') -split '[/:]')[-1] -replace '\.git$', ''
  $dest = Join-Path $deploy $name
  if (Test-Path $dest) { Write-Host "  deployment\$name already exists." -ForegroundColor Yellow; continue }
  git clone $repo $dest
  if ($LASTEXITCODE -eq 0) { Write-Host "  Cloned into $dest" -ForegroundColor Green } else { Write-Host '  The clone failed (see above).' -ForegroundColor Yellow }
}

$found = Get-ChildItem $deploy -Directory | Where-Object { $_.Name -notmatch '^[._]' }
Write-Host ''
if ($found) { Write-Host "Servers found: $($found.Name -join ', ')" } else { Write-Host 'No servers in deployment\ yet: add folders any time (or deploy from the dashboard).' -ForegroundColor Yellow }

# Capri's old start-server.bat in the Startup folder would start a second copy on the same port.
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
Register-ScheduledTask -TaskName $task -Description 'Runs and auto-updates the Node servers in the deployment folder' `
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
Write-Host "Done. Add a server any time by putting its folder in $deploy (or deploying it from the dashboard). open-dashboard.bat shows everything."
