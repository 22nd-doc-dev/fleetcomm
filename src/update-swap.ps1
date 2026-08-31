# FleetComm update swap.
#
# WHY POWERSHELL AND NOT OUR OWN BINARY:
# electron-builder's portable target unpacks the app into a temporary directory
# and DELETES THAT DIRECTORY when the app exits. The previous helper was spawned
# as `process.execPath <helper.js>` — i.e. the Electron binary living inside that
# doomed directory. So the sequence was: spawn helper, quit app, portable
# launcher wipes the temp dir out from under the helper while it is still
# waiting for us to exit, nothing is swapped, and the operator relaunches the
# original exe and sees the old version. No error, no window, just no update.
#
# powershell.exe lives in System32 and cannot be deleted by our own shutdown, so
# the swap survives the app exiting. It is resolved by absolute path rather than
# PATH so a broken PATH cannot silently break updates either.
param(
  [Parameter(Mandatory=$true)][string]$Exe,
  [Parameter(Mandatory=$true)][string]$Fresh,
  [Parameter(Mandatory=$true)][string]$Backup,
  [Parameter(Mandatory=$true)][int]$ParentPid,
  [Parameter(Mandatory=$true)][string]$StateFile,
  [Parameter(Mandatory=$true)][string]$Target,
  [Parameter(Mandatory=$true)][string]$LogFile
)
$ErrorActionPreference = 'Stop'

function Log($m) {
  try {
    $dir = Split-Path -Parent $LogFile
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Add-Content -Path $LogFile -Value ((Get-Date).ToString('o') + ' ' + $m)
  } catch {}
}
function WriteState($status, $extra) {
  try {
    $o = @{ target = $Target; status = $status }
    if ($extra) { foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] } }
    $tmp = $StateFile + '.tmp'
    # NOT Set-Content -Encoding UTF8: on Windows PowerShell 5.1 (the System32
    # one that actually runs in production) that writes a BOM, Node's
    # JSON.parse rejects BOM'd JSON, and the app reads the state as {} — which
    # breaks the one-automatic-attempt-per-version guard. WriteAllText emits
    # BOM-less UTF-8 on every PowerShell/.NET version.
    [System.IO.File]::WriteAllText($tmp, ($o | ConvertTo-Json -Compress))
    Move-Item -Force -Path $tmp -Destination $StateFile
  } catch { Log ("state write failed: " + $_.Exception.Message) }
}
function IsExe($p) {
  try {
    if (-not (Test-Path $p)) { return $false }
    if ((Get-Item $p).Length -lt 40MB) { return $false }
    $fs = [System.IO.File]::OpenRead($p)
    try { $b = New-Object byte[] 2; $null = $fs.Read($b, 0, 2); return ($b[0] -eq 0x4D -and $b[1] -eq 0x5A) }
    finally { $fs.Dispose() }
  } catch { return $false }
}
function MoveRetry($from, $to, $tries) {
  for ($i = 0; $i -lt $tries; $i++) {
    try { Move-Item -Force -LiteralPath $from -Destination $to; return $true }
    catch { Start-Sleep -Milliseconds 400 }
  }
  return $false
}

# PSVersion identifies WHICH PowerShell ran (5.1 in production via System32,
# 7.x in the test suites) — the two behave differently and a log that doesn't
# say which one it is has already cost a debugging round
Log ("swap starting: target=" + $Target + " parent=" + $ParentPid + " ps=" + $PSVersionTable.PSVersion)
# Heartbeat: the app WAITS for this file before it exits. On one machine the
# directly-spawned PowerShell was killed at birth — spawn succeeded, then zero
# output, no state change, nothing — so the app now exits only once the swap
# has proven it is actually executing, and falls back to launching us through
# the Task Scheduler (outside the app's process tree) when this never appears.
try { New-Item -ItemType File -Force -Path ($StateFile + '.alive') | Out-Null } catch {}
$moved = $false
try {
  if (-not (IsExe $Fresh)) { throw "downloaded file is not a complete Windows executable" }

  # wait for FleetComm to actually exit; a running image can be renamed on
  # Windows but relaunching while it lives trips the single-instance lock and
  # the new copy quits straight back out
  try { Wait-Process -Id $ParentPid -Timeout 60 -ErrorAction SilentlyContinue } catch {}
  Start-Sleep -Milliseconds 400
  Log "parent exited"

  if (Test-Path $Backup) { Remove-Item -Force $Backup -ErrorAction SilentlyContinue }
  if (-not (MoveRetry $Exe $Backup 40)) { throw "could not move the running executable aside" }
  $moved = $true
  if (-not (MoveRetry $Fresh $Exe 40)) { throw "could not put the new executable in place" }
  if (-not (IsExe $Exe)) { throw "replacement executable failed verification" }

  # Past this point the install has SUCCEEDED: the new binary is in place and
  # verified. Record that before attempting the relaunch, and never let a failed
  # relaunch roll back a good install — if antivirus or anything else blocks the
  # start, the operator just opens FleetComm themselves and gets the new version.
  # Reverting here would throw away a working update to fix a cosmetic problem.
  WriteState 'launched' @{ launchedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); backup = $Backup }
  Log ("installed v" + $Target)
  $moved = $false
  try { Start-Process -FilePath $Exe -ArgumentList ("--update-applied=" + $Target); Log "relaunched" }
  catch { Log ("install succeeded but relaunch failed: " + $_.Exception.Message) }
  Remove-Item -Force $Backup -ErrorAction SilentlyContinue
  Log "done"
  exit 0
}
catch {
  $reason = $_.Exception.Message
  Log ("FAILED: " + $reason)
  try {
    if ($moved -and (Test-Path $Backup)) {
      if (Test-Path $Exe) { Remove-Item -Force $Exe -ErrorAction SilentlyContinue }
      Move-Item -Force -LiteralPath $Backup -Destination $Exe
      Log "old version restored"
    }
  } catch { Log ("restore failed: " + $_.Exception.Message) }
  try { if ($Fresh -ne $Exe) { Remove-Item -Force $Fresh -ErrorAction SilentlyContinue } } catch {}
  WriteState 'failed' @{ failedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); reason = $reason }
  if (Test-Path $Exe) { try { Start-Process -FilePath $Exe -ArgumentList '--update-failed' } catch {} }
  exit 1
}
