param(
  [Parameter(Mandatory=$true)][string]$BundleRoot,
  [Parameter(Mandatory=$true)][string]$SidecarExecutable,
  [Parameter(Mandatory=$true)][string]$MissingModelExecutable,
  [Parameter(Mandatory=$true)][string]$SmokeHarness,
  [Parameter(Mandatory=$true)][string]$NetworkProbe,
  [Parameter(Mandatory=$true)][string]$UnrelatedCwd
)
$ErrorActionPreference = 'Stop'
$BundleRoot = (Resolve-Path -LiteralPath $BundleRoot).Path
$SidecarExecutable = (Resolve-Path -LiteralPath $SidecarExecutable).Path
$MissingModelExecutable = (Resolve-Path -LiteralPath $MissingModelExecutable).Path
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Node = (Resolve-Path -LiteralPath $Node).Path
$BundledNode = Join-Path $BundleRoot 'payload\runtime\node.exe'
$rulePrefix = 'UMB-C2-offline-' + [guid]::NewGuid().ToString('N')
$originalProfiles = Get-NetFirewallProfile -PolicyStore ActiveStore | Select-Object Name, Enabled
$hostileBin = Join-Path $env:RUNNER_TEMP ('umb-hostile-path-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $hostileBin | Out-Null
Set-Content -LiteralPath (Join-Path $hostileBin 'python.exe') -Value "@echo off`r`necho hostile Python PATH invoked 1>&2`r`nexit /b 97" -NoNewline
Set-Content -LiteralPath (Join-Path $hostileBin 'python3.exe') -Value "@echo off`r`necho hostile Python PATH invoked 1>&2`r`nexit /b 97" -NoNewline
$programs = @($Node, $BundledNode, $SidecarExecutable, $MissingModelExecutable) | Select-Object -Unique
try {
  # Validate classifier behavior, then establish positive connectivity from this exact Node binary
  # before changing firewall state. Both controls use the same literal IP and TCP port.
  $probeTests = Join-Path (Split-Path -Parent $NetworkProbe) 'assert-network-blocked.test.mjs'
  & $Node --test $probeTests
  if ($LASTEXITCODE -ne 0) { throw 'Network probe result-classification unit test failed.' }
  & $Node $NetworkProbe --expect-connected
  if ($LASTEXITCODE -ne 0) { throw 'Positive TCP connectivity control failed; offline result would be inconclusive.' }

  $firewallService = Get-Service -Name MpsSvc -ErrorAction Stop
  if ($firewallService.Status -ne 'Running') { throw "Windows Defender Firewall service is not running (status: $($firewallService.Status))." }
  Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True
  foreach ($program in $programs) {
    New-NetFirewallRule -DisplayName "$rulePrefix-$([IO.Path]::GetFileName($program))" -Direction Outbound -Action Block -Program $program -Profile Any -Enabled True | Out-Null
  }
  # Query the effective policy, not just local/persistent rules. Require each exact path to
  # appear in an enabled ActiveStore Outbound/Block/Any rule before setting the probe marker.
  $activeProfiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore)
  foreach ($profileName in @('Domain', 'Private', 'Public')) {
    $profile = $activeProfiles | Where-Object Name -EQ $profileName | Select-Object -First 1
    if (!$profile -or !$profile.Enabled) { throw "Effective ActiveStore firewall profile '$profileName' is not enabled." }
  }
  $firewallService = Get-Service -Name MpsSvc -ErrorAction Stop
  if ($firewallService.Status -ne 'Running') { throw "Windows Defender Firewall service stopped before offline probe (status: $($firewallService.Status))." }
  $activeRules = @(Get-NetFirewallRule -PolicyStore ActiveStore -Direction Outbound -Action Block -Enabled True)
  foreach ($program in $programs) {
    $matchedRule = $null
    foreach ($rule in $activeRules) {
      if ($rule.Profile -ne 'Any') { continue }
      $applicationFilters = @(Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $rule)
      $matchedFilters = @($applicationFilters | Where-Object { [string]::Equals($_.Program, $program, [StringComparison]::OrdinalIgnoreCase) })
      if ($matchedFilters.Count -gt 0) {
        $matchedRule = $rule
        break
      }
    }
    if (!$matchedRule) { throw "No enabled ActiveStore Outbound/Block/Any firewall rule is bound to exact executable path: $program" }
    Write-Host "Verified ActiveStore firewall block: $program (rule '$($matchedRule.DisplayName)')."
  }
  Write-Host "Effective firewall evidence: MpsSvc=$((Get-Service -Name MpsSvc).Status); profiles=$((($activeProfiles | Where-Object Name -In @('Domain','Private','Public') | ForEach-Object { "$($_.Name)=$($_.Enabled)" }) -join ',')); active outbound block rules=$($activeRules.Count)."

  # Hostile ambient values are applied only after the baseline and effective policy checks.
  $env:PYTHONPATH = 'C:\hostile\imports'
  $env:PYTHONHOME = 'C:\hostile\runtime'
  $env:PYTHONUSERBASE = 'C:\hostile\userbase'
  $env:UMB_OFFLINE_FIREWALL_ACTIVE = '1'
  $env:PATH = "$hostileBin;$env:SystemRoot\System32"
  Push-Location $UnrelatedCwd
  try {
    & $Node $NetworkProbe --expect-blocked
    if ($LASTEXITCODE -ne 0) { throw 'Node network probe did not confirm OS firewall isolation.' }
    $env:UMB_TEST_BUNDLE_ROOT = $BundleRoot
    $env:UMB_TEST_SIDECAR_EXECUTABLE = $SidecarExecutable
    $env:UMB_TEST_MISSING_MODEL_EXECUTABLE = $MissingModelExecutable
    & $Node $SmokeHarness
    if ($LASTEXITCODE -ne 0) { throw 'Final archive memory sidecar smoke failed.' }
    & (Join-Path $BundleRoot 'umb.cmd') --help
    if ($LASTEXITCODE -ne 0) { throw 'Extracted bundle umb.cmd --help failed.' }
  } finally { Pop-Location }
} finally {
  Get-NetFirewallRule -DisplayName "$rulePrefix-*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  foreach ($profile in $originalProfiles) {
    Set-NetFirewallProfile -Profile $profile.Name -Enabled $profile.Enabled
  }
  Remove-Item -LiteralPath $hostileBin -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item Env:PYTHONPATH,Env:PYTHONHOME,Env:PYTHONUSERBASE,Env:UMB_OFFLINE_FIREWALL_ACTIVE -ErrorAction SilentlyContinue
}
