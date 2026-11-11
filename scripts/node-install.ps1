# Rose node installer for Windows 10/11 (PowerShell 5.1 or later). Android (redroid) needs a Linux
# kernel with binder, so the node runs inside a small Ubuntu VM made with Canonical Multipass; inside
# it, the hub's normal Linux node installer runs (scripts/vm/cloud-init.yaml). Served by the hub at
# /node/install.ps1; the hub's Hosts page shows (in PowerShell, not as Administrator):
#
#   [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; $env:ROSE_HUB_URL='https://<hub>'; $env:ROSE_NODE_TOKEN='rn_...'; irm https://<hub>/node/install.ps1 | iex
#
# (The TLS 1.2 part is for Windows PowerShell 5.1 on older Windows 10, whose default can't reach
# TLS 1.2-only sites. irm | iex is not subject to the execution policy; a downloaded copy is:
# powershell -ExecutionPolicy Bypass -File .\node-install.ps1 ...)
#
# With options (the script-block form):
#   & ([scriptblock]::Create((irm https://<hub>/node/install.ps1))) -Hub https://<hub> -Token rn_... -Cpus 6 -MemoryGB 8
#   & ([scriptblock]::Create((irm https://<hub>/node/install.ps1))) -Uninstall
#
#   -Hub URL       the hub's address (https://...; or $env:ROSE_HUB_URL)
#   -Token TOKEN   the join token the hub owner gave you (rn_...; or $env:ROSE_NODE_TOKEN)
#   -Cpus N        VM CPUs  (default: all threads but 2, at least 3)
#   -MemoryGB N    VM RAM   (default: half the PC's RAM, leaving at least 4 GB to Windows; min 5)
#   -DiskGB N      VM disk  (default 30, min 20)
#   -Max N         sessions at once (default: auto, sized from the VM)
#   -Name NAME     Multipass VM name (default rose-node)
#   -Insecure      allow a plain http:// hub on a public address (not recommended)
#   -Yes           don't ask before installing Multipass or enabling Windows features
#   -Uninstall     delete the VM (and everything in it). Multipass itself stays.
#
# Rerun with the VM in place to update the node (with -Token: switch to a new token; with
# -Cpus/-MemoryGB/-DiskGB: resize the VM, which restarts it).
# Needs: 64-bit Windows 10 1809+ or 11 (Home, Pro or Enterprise), virtualization on in the BIOS/UEFI,
# Multipass 1.17+ (its default Hyper-V/HCS driver works on Home too, with "Virtual Machine Platform").
# No GPU acceleration in the VM: games render on the CPU, so expect fewer sessions than on Linux.
# Sessions are privileged Android containers started by code from the hub: only join hubs you trust.
param(
  [string]$Hub = '',
  [string]$Token = '',
  [int]$Cpus = 0,
  [int]$MemoryGB = 0,
  [int]$DiskGB = 0,
  [string]$Max = 'auto',
  [string]$Name = 'rose-node',
  [switch]$Insecure,
  [switch]$Yes,
  [switch]$Uninstall
)

function Say([string]$m) { Write-Host '== ' -ForegroundColor Red -NoNewline; Write-Host $m }
function Ok([string]$m) { Write-Host '   OK ' -ForegroundColor Green -NoNewline; Write-Host $m }
function Warn([string]$m) { Write-Host '   !! ' -ForegroundColor Yellow -NoNewline; Write-Host $m }
function Fail([string]$m) { throw $m }
function Mask([string]$t) {
  if ($t -match '^rn_([0-9a-f]{8})_') { return 'rn_' + $Matches[1] + '_****' + $t.Substring($t.Length - 4) }
  return '****'
}
function Ask([string]$q) {
  if ($Yes) { return $true }
  $a = Read-Host "$q [Y/n]"
  return ($a -eq '' -or $a -match '^[Yy]')
}

# Native commands: run with stderr folded into the output as plain text (PowerShell 5.1 turns stderr
# into errors otherwise). Returns @{ Code; Out }.
function Run-Native([string]$exe, [string[]]$argv, $stdin = $null) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($null -ne $stdin) { $out = $stdin | & $exe @argv 2>&1 } else { $out = & $exe @argv 2>&1 }
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $old }
  $text = (@($out) | ForEach-Object { "$_" }) -join "`n"
  return @{ Code = $code; Out = $text }
}

function Find-Multipass {
  $c = Get-Command multipass.exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @("$env:ProgramFiles\Multipass\bin\multipass.exe", "${env:ProgramFiles(x86)}\Multipass\bin\multipass.exe")) {
    if ($p -and (Test-Path -LiteralPath $p)) { return $p }
  }
  return $null
}

function Get-Text([string]$url) {
  $r = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 60
  if ($r.Content -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($r.Content) }
  return [string]$r.Content
}

function Install-RoseNode {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar in 5.1
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

  # Settings may come from the environment (the irm | iex one-liner); the token is cleared from it at once.
  # (Local copies: the parameters are only read here, so this works under iex and & { } alike.)
  $h = $Hub; $tok = $Token
  if (-not $h -and $env:ROSE_HUB_URL) { $h = $env:ROSE_HUB_URL }
  if (-not $tok -and $env:ROSE_NODE_TOKEN) { $tok = $env:ROSE_NODE_TOKEN }
  $un = [bool]$Uninstall -or ($env:ROSE_NODE_UNINSTALL -eq '1')
  Remove-Item Env:ROSE_NODE_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:ROSE_NODE_UNINSTALL -ErrorAction SilentlyContinue
  $h = "$h".Trim(); $tok = "$tok".Trim()

  if ($Name -notmatch '^[A-Za-z0-9-]+$') { Fail '-Name may only use letters, digits and -' }
  if ([Environment]::OSVersion.Platform -ne 'Win32NT') { Fail 'this installer is for Windows. Linux: <hub>/node/install.sh, macOS: <hub>/node/install-mac.sh' }

  $mp = Find-Multipass
  if ($un) {
    if (-not $mp) { Ok 'Multipass is not installed, so there is no Rose node VM to remove.'; return }
    if ((Run-Native $mp @('info', $Name)).Code -ne 0) { Ok "there is no VM called $Name."; return }
    Say "Deleting the VM $Name (its sessions end)"
    [void](Run-Native $mp @('stop', $Name))
    $r = Run-Native $mp @('delete', '--purge', $Name)
    if ($r.Code -ne 0) { Fail "multipass delete failed: $($r.Out)" }
    Ok 'removed. Ask the hub owner to revoke this host''s token.'
    Write-Host '   Multipass itself stays (Settings > Apps to remove it).'
    return
  }

  if (-not $h) { Fail 'missing -Hub (the hub''s address, e.g. https://rose.example.com)' }
  $h = $h.TrimEnd('/')
  if ($h -notmatch '^https?://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$') { Fail '-Hub does not look like an address (https://host[:port][/path]).' }
  if ($tok -and $tok -cnotmatch '^rn_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$') { Fail 'that token does not look right (it starts with rn_).' }
  if ($Max -notmatch '^(auto|[0-9]+)$') { Fail '-Max must be a number or auto' }
  $setCpus = $Cpus; $setMem = $MemoryGB; $setDisk = $DiskGB

  Say 'Checking this PC'
  $os = Get-CimInstance Win32_OperatingSystem
  $build = [int]$os.BuildNumber
  if (-not [Environment]::Is64BitOperatingSystem) { Fail 'Multipass needs 64-bit Windows.' }
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { Fail 'Multipass does not run on Windows on ARM.' }
  if ($build -lt 17763) { Fail "Windows build $build is too old: Multipass needs Windows 10 1809 (build 17763) or later." }
  $home_ed = $os.Caption -match 'Home'
  Ok "$($os.Caption) (build $build)"
  $cs = Get-CimInstance Win32_ComputerSystem
  # Installed RAM (a "16 GB" PC reports about 15.8 GB usable, which would round down to 15).
  $inst = (@(Get-CimInstance Win32_PhysicalMemory -ErrorAction SilentlyContinue) | Measure-Object -Property Capacity -Sum).Sum
  if (-not $inst -or $inst -lt $cs.TotalPhysicalMemory) { $inst = $cs.TotalPhysicalMemory }
  $ramGB = [int][math]::Floor($inst / 1GB)
  $threads = [int]$cs.NumberOfLogicalProcessors
  Ok "$threads threads, $ramGB GB RAM"

  # Virtualization: a running hypervisor (Hyper-V / VBS) proves it; else ask the CPU's firmware flag.
  if ($cs.HypervisorPresent) { Ok 'virtualization on (a hypervisor is running)' }
  else {
    $fw = @(Get-CimInstance Win32_Processor | ForEach-Object { $_.VirtualizationFirmwareEnabled })
    if ($fw -contains $false) { Fail 'virtualization is off: turn on Intel VT-x / AMD-V (SVM) in the BIOS/UEFI setup, then rerun.' }
    Ok 'virtualization on (BIOS/UEFI)'
  }
  $feat = @{}
  foreach ($f in @('VirtualMachinePlatform', 'Microsoft-Hyper-V-Hypervisor', 'HypervisorPlatform')) {
    $o = Get-CimInstance Win32_OptionalFeature -Filter "Name='$f'" -ErrorAction SilentlyContinue
    $feat[$f] = ($o -and $o.InstallState -eq 1)
  }
  if ($feat['Microsoft-Hyper-V-Hypervisor']) { Ok 'Hyper-V is on' }
  if ($feat['VirtualMachinePlatform']) { Ok 'Virtual Machine Platform is on' }
  # Multipass 1.17+ (its default HCS driver, every edition) needs Virtual Machine Platform, Hyper-V or not.
  if (-not $feat['VirtualMachinePlatform']) {
    Warn 'Multipass needs the Windows feature "Virtual Machine Platform".'
    if (-not (Ask 'Turn on Virtual Machine Platform now (asks for Administrator, then you restart Windows)?')) {
      Fail 'turn it on under "Turn Windows features on or off", restart, and rerun this command.'
    }
    $p = Start-Process -FilePath dism.exe -Verb RunAs -Wait -PassThru `
      -ArgumentList '/online', '/enable-feature', '/featurename:VirtualMachinePlatform', '/all', '/norestart'
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Fail "enabling Virtual Machine Platform failed (dism exit $($p.ExitCode))." }
    Say 'Restart Windows, then run the same command again.'
    return
  }

  # VM size: half the RAM (capped at 32 GB) but leave Windows at least 4 GB; all threads but 2 (min 3).
  if ($MemoryGB -le 0) {
    $MemoryGB = [math]::Max(5, [math]::Floor($ramGB / 2))
    if ($ramGB - $MemoryGB -lt 4) { $MemoryGB = $ramGB - 4 }
    $MemoryGB = [math]::Min(32, $MemoryGB)
    if ($MemoryGB -lt 5) { Fail "this PC has $ramGB GB RAM; a node VM needs 5 GB and Windows needs 4 GB more (9 GB or more). Force a size with -MemoryGB 5." }
  }
  if ($MemoryGB -lt 5) { Fail '-MemoryGB must be 5 or more: one session needs about 2.5 GB plus 2 GB for the VM.' }
  if ($ramGB - $MemoryGB -lt 3) { Warn "only $($ramGB - $MemoryGB) GB RAM left for Windows while the VM runs." }
  if ($Cpus -le 0) { $Cpus = [math]::Min(16, [math]::Min($threads, [math]::Max(3, $threads - 2))) }
  if ($Cpus -lt 3) { Fail 'the VM needs 3 or more CPUs (one session uses 2, plus 1 for the VM).' }
  if ($DiskGB -le 0) { $DiskGB = 30 }
  if ($DiskGB -lt 20) { Fail '-DiskGB must be 20 or more.' }
  $slots = [math]::Min([math]::Floor(($MemoryGB * 1024 - 250 - 2048) / 2560), [math]::Floor(($Cpus - 1) / 2))
  if ($Max -ne 'auto') { $slots = [int]$Max }
  Ok "VM: $Cpus CPUs, $MemoryGB GB RAM, $DiskGB GB disk: about $slots session(s) at once (CPU rendering, no GPU)"
  $sys = Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':')) -ErrorAction SilentlyContinue
  if ($sys -and ($sys.Free / 1GB) -lt $DiskGB) { Warn "only $([math]::Floor($sys.Free / 1GB)) GB free on $($env:SystemDrive); the VM can grow to $DiskGB GB." }

  # The hub's address: https, unless it's on this network (or -Insecure).
  $uri = [Uri]$h
  if ($uri.Host -eq 'localhost' -or $uri.Host -like '127.*') { Fail "the hub is ""$($uri.Host)"": inside the VM that means the VM itself. Use the hub's LAN address or its https:// address." }
  $private = $uri.Host -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)|^[^.]+$|\.(local|lan|internal)$'
  if ($uri.Scheme -eq 'http' -and -not $Insecure -and -not $private) { Fail 'the hub address is plain http:// on the internet: use its https:// address (or pass -Insecure).' }
  try { [void](Get-Text "$h/node/install.sh") } catch { Fail "could not reach $h (or it is not a Rose hub with node support): $($_.Exception.Message)" }
  Ok "hub $h"

  # ------------------------------------------------------------ Multipass
  if (-not $mp) {
    Say 'Installing Multipass (Canonical''s Ubuntu VM manager)'
    if (-not (Ask 'Multipass is not installed. Install it now (asks for Administrator)?')) { Fail 'Multipass is needed: https://canonical.com/multipass/install' }
    if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
      $r = Run-Native 'winget.exe' @('install', '--id', 'Canonical.Multipass', '-e', '--accept-source-agreements', '--accept-package-agreements')
      Write-Host $r.Out
    } else {
      $rel = Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/canonical/multipass/releases/latest'
      $asset = @($rel.assets | Where-Object { $_.name -match 'win64\.msi$' })[0]
      if (-not $asset) { Fail 'could not find the Multipass installer; get it from https://canonical.com/multipass/install' }
      $msi = Join-Path $env:TEMP $asset.name
      Write-Host "   downloading $($asset.browser_download_url)"
      Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $msi
      $p = Start-Process -FilePath msiexec.exe -Verb RunAs -Wait -PassThru -ArgumentList '/i', ('"' + $msi + '"'), '/passive', '/norestart'
      Remove-Item -LiteralPath $msi -ErrorAction SilentlyContinue
      if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Fail "the Multipass installer failed (exit $($p.ExitCode))." }
    }
    $mp = Find-Multipass
    if (-not $mp) { Fail 'Multipass did not install; get it from https://canonical.com/multipass/install (then rerun).' }
    for ($i = 0; $i -lt 30 -and (Run-Native $mp @('version')).Code -ne 0; $i++) { Start-Sleep -Seconds 2 }
  }
  $ver = ''
  if ((Run-Native $mp @('version')).Out -match 'multipass\s+(\d+)\.(\d+)') {
    $ver = "$($Matches[1]).$($Matches[2])"
    if ([int]$Matches[1] -eq 1 -and [int]$Matches[2] -lt 17) {
      if ($home_ed) { Warn "Multipass $ver on Windows Home uses VirtualBox; update to 1.17 or later (winget upgrade Canonical.Multipass) for the built-in driver." }
      else { Warn "Multipass $ver is old; 1.17 or later is recommended (winget upgrade Canonical.Multipass)." }
    }
  }
  Ok "multipass $ver ($mp)"

  $exists = (Run-Native $mp @('info', $Name)).Code -eq 0
  if ($exists) {
    # ---------------------------------------------------------- existing VM: update (and resize)
    Say "The VM $Name exists: updating it"
    if ($setCpus -gt 0 -or $setMem -gt 0 -or $setDisk -gt 0) {
      Write-Host '   resizing (restarts the VM; its sessions end)'
      [void](Run-Native $mp @('stop', $Name))
      if ($setCpus -gt 0) { [void](Run-Native $mp @('set', "local.$Name.cpus=$setCpus")) }
      if ($setMem -gt 0) { [void](Run-Native $mp @('set', "local.$Name.memory=$($setMem)G")) }
      if ($setDisk -gt 0 -and (Run-Native $mp @('set', "local.$Name.disk=$($setDisk)G")).Code -ne 0) { Warn 'the disk can only grow, not shrink' }
    }
    [void](Run-Native $mp @('start', $Name))
    Write-Host '   downloading and rebuilding the node in the VM (a few minutes)'
    if ($tok) { $r = Run-Native $mp @('exec', $Name, '--', 'sudo', '/usr/local/sbin/rose-node-install', '--token-stdin') $tok }
    else { $r = Run-Native $mp @('exec', $Name, '--', 'sudo', '/usr/local/sbin/rose-node-install') }
    if ($r.Code -ne 0) { Fail "updating the node failed: $mp exec $Name -- sudo tail -n 30 /var/log/rose-node-install.log" }
  } else {
    # ---------------------------------------------------------- new VM
    if (-not $tok) { Fail 'missing -Token (ask the hub owner for a join token)' }
    Ok "token $(Mask $tok)"
    Say "Creating the VM $Name (Ubuntu 24.04, downloads about 600 MB the first time)"
    $tmpl = Get-Text "$h/node/cloud-init.yaml"
    if ($tmpl -notmatch '@@NODE_TOKEN@@') { Fail 'the hub''s cloud-init has no token placeholder; is it a Rose hub?' }
    # The token is NOT put in the cloud-init (Multipass keeps that on disk as the VM's seed ISO): it is
    # piped into the VM once it is up (below).
    $yaml = $tmpl.Replace("`r`n", "`n").Replace('@@HUB_URL@@', $h).Replace('@@NODE_TOKEN@@', '').Replace('@@MAX_SESSIONS@@', $Max)
    $yaml = $yaml.Replace('@@INSECURE@@', $(if ($Insecure) { '1' } else { '0' }))
    $file = Join-Path $env:TEMP ('rose-node-' + [guid]::NewGuid().ToString('N') + '.yaml')
    try {
      [IO.File]::WriteAllText($file, $yaml, (New-Object Text.UTF8Encoding $false))
      $yaml = $null
      Write-Host '   (this takes a few minutes)'
      $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      try {
        & $mp launch 24.04 --name $Name --cpus $Cpus --memory "$($MemoryGB)G" --disk "$($DiskGB)G" --cloud-init $file --timeout 1800
        $rc = $LASTEXITCODE
      } finally { $ErrorActionPreference = $old }
    } finally { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
    if ($rc -eq 0) { Ok 'VM started' }
    elseif ($rc -eq 75) { Warn 'Multipass stopped waiting, but the VM keeps starting' }
    elseif ((Run-Native $mp @('info', $Name)).Code -ne 0) { Fail "multipass launch failed (exit $rc). Check: multipass info --all" }
    else { Warn "multipass launch exited $rc; continuing" }
    # Hand the token to the VM on stdin (not in a file or a command line), retrying while it boots.
    for ($i = 0; $true; $i++) {
      $r = Run-Native $mp @('exec', $Name, '--', 'sudo', '/usr/local/sbin/rose-node-install', '--token-stdin') $tok
      if ($r.Code -eq 0) { break }
      if ($i -ge 60) { Fail "could not hand the token to the VM: $($r.Out). Look inside: multipass shell $Name, then: sudo tail /var/log/cloud-init-output.log" }
      Start-Sleep -Seconds 10
    }
  }

  # ------------------------------------------------------------ wait for the node
  Say 'Waiting for the node to connect (the first start takes 5 to 15 minutes)'
  $last = ''; $t0 = Get-Date
  while ($true) {
    $r = Run-Native $mp @('exec', $Name, '--', 'sudo', '/usr/local/sbin/rose-node-status')
    $s = if ($r.Code -eq 0 -and $r.Out) { ($r.Out -split "`n")[-1].Trim() } else { 'starting waiting for the VM' }
    if ($s -ne $last) { Write-Host ('   ' + ($s -replace '^starting ', '')); $last = $s }
    if ($s -like 'online*') { Ok ($s -replace '^online ', ''); break }
    if ($s -eq 'refused') { Fail 'the hub refused the token (revoked, or mistyped). Ask the hub owner for a new one and rerun with the new token.' }
    if ($s -like 'failed*') {
      Write-Host (Run-Native $mp @('exec', $Name, '--', 'sudo', 'tail', '-n', '20', '/var/log/rose-node-install.log')).Out
      Fail ('the node failed: ' + ($s -replace '^failed ', ''))
    }
    if (((Get-Date) - $t0).TotalMinutes -gt 30) { Fail "the node did not come online in 30 minutes. Look inside: multipass shell $Name, then: sudo tail -f /var/log/rose-node-install.log" }
    Start-Sleep -Seconds 10
  }
  if ($Name -eq 'rose-node') { $unCmd = "`$env:ROSE_NODE_UNINSTALL='1'; irm $h/node/install.ps1 | iex" }
  else { $unCmd = "& ([scriptblock]::Create((irm $h/node/install.ps1))) -Uninstall -Name $Name" }
  Write-Host @"

This PC now runs a Rose node in the VM "$Name". Players the hub sends here run on this computer.
  Status:     multipass exec $Name -- sudo /usr/local/sbin/rose-node-status
  Logs:       multipass exec $Name -- sudo docker logs -f rose-node
  Stop:       multipass stop $Name        (frees its RAM; its sessions end)
  Start:      multipass start $Name
  Update:     rerun the install command
  Uninstall:  $unCmd
"@
}

try { Install-RoseNode }
catch { Write-Host ('!! ' + $_.Exception.Message) -ForegroundColor Red }
finally { Remove-Item Env:ROSE_NODE_TOKEN -ErrorAction SilentlyContinue; Remove-Item Env:ROSE_NODE_UNINSTALL -ErrorAction SilentlyContinue }
