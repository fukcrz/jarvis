$pidTarget = [int]$args[0]
$depth = 0
while ($pidTarget -gt 0 -and $depth -lt 12) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pidTarget" -ErrorAction SilentlyContinue
  if (-not $proc) { Write-Output ("{0} (不存在)" -f $pidTarget); break }
  $cmd = $proc.CommandLine
  if ($cmd.Length -gt 90) { $cmd = $cmd.Substring(0, 90) }
  Write-Output ("PID={0} PPID={1} CREATE={2} CMD={3}" -f $proc.ProcessId, $proc.ParentProcessId, $proc.CreationDate, $cmd)
  $pidTarget = $proc.ParentProcessId
  $depth++
}
