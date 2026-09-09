param([int]$RootPid)
$all = Get-CimInstance Win32_Process
$children = @{}
foreach ($p in $all) {
  $pp = [int]$p.ParentProcessId
  if (-not $children.ContainsKey($pp)) { $children[$pp] = @() }
  $children[$pp] += $p
}
$stack = New-Object System.Collections.Stack
$stack.Push($RootPid)
$seen = @{}
$out = @()
while ($stack.Count -gt 0) {
  $cur = [int]$stack.Pop()
  if ($seen.ContainsKey($cur)) { continue }
  $seen[$cur] = $true
  if ($children.ContainsKey($cur)) {
    foreach ($c in $children[$cur]) {
      $cmd = $c.CommandLine
      if ($cmd -and $cmd.Length -gt 100) { $cmd = $cmd.Substring(0, 100) + "..." }
      $out += ("  PID={0} Name={1} Create={2} CMD={3}" -f $c.ProcessId, $c.Name, $c.CreationDate, $cmd)
      $stack.Push([int]$c.ProcessId)
    }
  }
}
if ($out.Count -eq 0) { Write-Output "no descendant" } else { $out }
