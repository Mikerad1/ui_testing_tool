param([Parameter(Mandatory=$true)][string]$BundleRoot, [switch]$Preflight)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($BundleRoot)
$rootVolume = [IO.Path]::GetPathRoot($root)
while ($root.Length -gt $rootVolume.Length -and ($root.EndsWith('\') -or $root.EndsWith('/'))) { $root = $root.Substring(0, $root.Length - 1) }
$request = Join-Path $root '.umb-update-request.json'
$lock = Join-Path $root '.umb-update-lock'
$log = Join-Path $root 'umb-update-error.log'
$payload = Join-Path $root 'payload'
$previous = Join-Path $root 'payload.previous'
$swapStarted = $false
$lockStream = $null
function WriteFailure([string]$Message) {
  $line = "[$(Get-Date -Format o)] UMB update failed: $Message"
  try { Add-Content -LiteralPath $log -Value $line } catch {}
  [Console]::Error.WriteLine($line)
}
function Fail([string]$Message) { throw [InvalidOperationException]::new($Message) }
function Get-ValidPayloadVersion([string]$Path) {
  $metaFile = Join-Path $Path 'package.json'
  $runtime = Join-Path $Path 'runtime\node.exe'
  $entrypoint = Join-Path $Path 'dist\src\cli\index.js'
  $dependencyFile = Join-Path $Path 'node_modules\better-sqlite3\package.json'
  if (!(Test-Path -LiteralPath $metaFile -PathType Leaf) -or !(Test-Path -LiteralPath $runtime -PathType Leaf) -or !(Test-Path -LiteralPath $entrypoint -PathType Leaf) -or !(Test-Path -LiteralPath $dependencyFile -PathType Leaf)) { throw 'payload metadata, bundled runtime, CLI entrypoint, or better-sqlite3 dependency is missing' }
  $metadata = Get-Content -LiteralPath $metaFile -Raw | ConvertFrom-Json
  if ($metadata.name -ne 'ui-memory-browser' -or $metadata.version -notmatch '^\d+\.\d+\.\d+$') { throw 'payload metadata is invalid' }
  $dependency = Get-Content -LiteralPath $dependencyFile -Raw | ConvertFrom-Json
  if ($dependency.name -ne 'better-sqlite3') { throw 'payload better-sqlite3 dependency identity is invalid' }
  return [string]$metadata.version
}
if ((Test-Path -LiteralPath $request) -and !(Test-Path -LiteralPath $request -PathType Leaf)) {
  WriteFailure 'pending request is not a regular file; preserve it for manual inspection'
  exit 1
}
function Clear-OrphanArtifacts([string]$KeepStage) {
  foreach ($item in (Get-ChildItem -LiteralPath $root -Force)) {
    if ($KeepStage -and [IO.Path]::GetFullPath($item.FullName) -ieq [IO.Path]::GetFullPath($KeepStage)) { continue }
    if ($item.Name -like '.umb-update-work-*' -or $item.Name -like '.umb-update-stage-*' -or $item.Name -like '.umb-update-request.tmp-*') {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "refusing to clean reparse-point update artifact: $($item.FullName)" }
      Remove-Item -LiteralPath $item.FullName -Recurse -Force
    }
  }
}
$orphanArtifacts = @(Get-ChildItem -LiteralPath $root -Force | Where-Object { $_.Name -like '.umb-update-work-*' -or $_.Name -like '.umb-update-stage-*' -or $_.Name -like '.umb-update-request.tmp-*' })
if (!(Test-Path -LiteralPath $request -PathType Leaf) -and (Test-Path -LiteralPath $payload -PathType Container) -and !$orphanArtifacts.Count) { exit 0 }
try { $lockStream = [IO.File]::Open($lock, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
catch {
  WriteFailure 'the exclusive update lock is busy or unavailable; stop all UMB processes and retry. If this is a legacy lock directory, remove it only after confirming no helper is running.'
  exit 1
}
try {
  $payloadPaths = @($payload, $previous)
  $needle = ($payloadPaths | ForEach-Object { [regex]::Escape($_) }) -join '|'
  $active = Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'node.exe' -and $_.CommandLine -match $needle }
  if ($active) { Fail 'best-effort process scan found UMB using payload or payload.previous; close all UMB processes and do not launch another UMB command during update, then retry' }

  $r = $null
  $stage = $null
  if (Test-Path -LiteralPath $request -PathType Leaf) {
    try {
      $r = (Get-Content -LiteralPath $request -Raw) | ConvertFrom-Json
      if ($r.format -ne 1 -or $r.stage -isnot [string] -or $r.version -isnot [string] -or $r.version -notmatch '^\d+\.\d+\.\d+$') { throw 'invalid request fields' }
      $stage = [IO.Path]::GetFullPath($r.stage)
      $stageParent = [IO.Path]::GetDirectoryName($stage)
      if ($stageParent -ne $root -or [IO.Path]::GetFileName($stage) -notmatch '^\.umb-update-stage-[A-Za-z0-9_-]+$') { throw 'stage path is outside the bundle or unsafe' }
    } catch { Fail "pending request is malformed; request preserved: $($_.Exception.Message)" }
  }

  $payloadItem = Get-Item -LiteralPath $payload -Force -ErrorAction SilentlyContinue
  if ($payloadItem -and ($payloadItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Fail 'payload is a reparse point; refusing recovery' }
  if (!(Test-Path -LiteralPath $payload)) {
    if (!(Test-Path -LiteralPath $previous -PathType Container) -or (Get-Item -LiteralPath $previous -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail 'payload is missing and no safe payload.previous is available; preserve update files for manual recovery' }
    try { $oldVersion = Get-ValidPayloadVersion $previous } catch { Fail "payload.previous is invalid; refusing to mutate it: $($_.Exception.Message)" }
    try { Move-Item -LiteralPath $previous -Destination $payload -ErrorAction Stop }
    catch { Fail "could not restore payload.previous; preserve all update files: $($_.Exception.Message)" }
    Clear-OrphanArtifacts $(if ($r) { $stage } else { '' })
    if (Test-Path -LiteralPath $request -PathType Leaf) { [Console]::Out.WriteLine("Recovered UMB $oldVersion from payload.previous. The pending update was preserved for retry.") }
    else { [Console]::Out.WriteLine("Recovered UMB $oldVersion from payload.previous.") }
    return
  }
  if (!(Test-Path -LiteralPath $payload -PathType Container) -or (Get-Item -LiteralPath $payload -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail 'payload exists but is not a safe directory; refusing mutation' }
  try { $currentVersion = Get-ValidPayloadVersion $payload } catch { Fail "payload is invalid; refusing mutation: $($_.Exception.Message)" }
  if (!(Test-Path -LiteralPath $request -PathType Leaf)) { Clear-OrphanArtifacts ''; return }

  if (!(Test-Path -LiteralPath $stage)) {
    if ($currentVersion -ne $r.version) { Fail 'pending stage is missing and current payload does not match the requested version; preserve all update files for manual recovery' }
    Remove-Item -LiteralPath $request -Force
    Clear-OrphanArtifacts ''
    [Console]::Out.WriteLine("Updated UMB to $($r.version) (recovered completed update).")
    return
  }
  if (!(Test-Path -LiteralPath $stage -PathType Container) -or (Get-Item -LiteralPath $stage -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail 'staged payload is not a safe directory' }
  try { $stageVersion = Get-ValidPayloadVersion $stage } catch { Fail "staged payload is invalid: $($_.Exception.Message)" }
  if ($stageVersion -ne $r.version) { Fail 'staged payload version does not match request' }
  if ($currentVersion -eq $r.version) { Fail 'requested version is already current but its stage still exists; update state is ambiguous, preserve files for manual recovery' }
  if ($Preflight) { Clear-OrphanArtifacts $stage; return }

  $previousExists = Test-Path -LiteralPath $previous
  if ($previousExists -and ((Get-Item -LiteralPath $previous -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { Fail 'payload.previous is not a safe directory' }
  if ($previousExists) { Remove-Item -LiteralPath $previous -Recurse -Force }
  Move-Item -LiteralPath $payload -Destination $previous
  $swapStarted = $true
  try { Move-Item -LiteralPath $stage -Destination $payload }
  catch {
    Move-Item -LiteralPath $previous -Destination $payload
    $swapStarted = $false
    Fail "could not move staged payload; previous payload restored: $($_.Exception.Message)"
  }
  try { $installedVersion = Get-ValidPayloadVersion $payload }
  catch { $installedVersion = '' }
  if ($installedVersion -ne $r.version) { $script:discardInvalidRequest = $true; Fail 'target version verification failed' }
  $swapStarted = $false
  Remove-Item -LiteralPath $request -Force
  Clear-OrphanArtifacts ''
  [Console]::Out.WriteLine("Updated UMB to $($r.version). Previous payload retained at payload.previous.")
}
catch {
  $message = $_.Exception.Message
  if ($swapStarted -and (Test-Path -LiteralPath $previous)) {
    try {
      if (Test-Path -LiteralPath $payload) { Remove-Item -LiteralPath $payload -Recurse -Force }
      Move-Item -LiteralPath $previous -Destination $payload
      $swapStarted = $false
      $message += '; previous payload restored'
      if ($script:discardInvalidRequest) {
        try { Remove-Item -LiteralPath $request -Force -ErrorAction Stop; $message += '; invalid request discarded' }
        catch { $message += "; could not remove invalid request: $($_.Exception.Message)" }
        if ($stage -and (Test-Path -LiteralPath $stage)) {
          $stageItem = Get-Item -LiteralPath $stage -Force
          if (!($stageItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            try { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction Stop; $message += '; invalid stage discarded' }
            catch { $message += "; could not remove invalid stage: $($_.Exception.Message)" }
          }
        }
      }
    } catch { $message += "; rollback failed: $($_.Exception.Message); inspect payload.previous" }
  }
  WriteFailure $message
  exit 1
}
finally { if ($lockStream) { $lockStream.Dispose() } }
