import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * Recovers descendants after a Windows parent has already exited.
 * PID ancestry is bounded by the session's lifetime; open process handles bind each kill
 * to the CreationDate/StartTime identity seen in the snapshot, not a potentially reused PID.
 */
export class WindowsProcessTree {
  async reapOrphans(rootProcessId: number, startedAt: Date, exitedAt: Date): Promise<void> {
    const source = `
$ErrorActionPreference = 'Stop'
$rootProcessId = ${rootProcessId}
$sessionStarted = [DateTime]::Parse('${startedAt.toISOString()}').ToUniversalTime()
$rootExited = [DateTime]::Parse('${exitedAt.toISOString()}').ToUniversalTime()
if (Get-Process -Id $rootProcessId -ErrorAction SilentlyContinue) { exit 0 }
$rows = @(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate -and $_.CreationDate.ToUniversalTime() -ge $sessionStarted })
$owned = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$pending = [System.Collections.Generic.Queue[object]]::new()
$pending.Enqueue(@{ ProcessId = $rootProcessId; Started = $sessionStarted; Ended = $rootExited })
try {
  while ($pending.Count -gt 0) {
    $parent = $pending.Dequeue()
    foreach ($row in $rows) {
      $created = $row.CreationDate.ToUniversalTime()
      if ($row.ParentProcessId -ne $parent.ProcessId -or $created -lt $parent.Started -or $created -gt $parent.Ended) { continue }
      try {
        $candidate = [System.Diagnostics.Process]::GetProcessById([int]$row.ProcessId)
        $null = $candidate.Handle
        $actualStarted = $candidate.StartTime.ToUniversalTime()
        if ([Math]::Abs(($actualStarted - $created).TotalMilliseconds) -gt 1) { $candidate.Dispose(); continue }
        $owned.Add($candidate)
        $pending.Enqueue(@{ ProcessId = $row.ProcessId; Started = $actualStarted; Ended = [DateTime]::UtcNow })
      } catch [System.ArgumentException] {
      } catch [System.InvalidOperationException] {
      }
    }
  }
  for ($index = $owned.Count - 1; $index -ge 0; $index--) {
    try {
      if (-not $owned[$index].HasExited) {
        $owned[$index].Kill()
        $null = $owned[$index].WaitForExit(1000)
      }
    } catch [System.InvalidOperationException] {
    }
  }
} finally {
  foreach ($candidate in $owned) { $candidate.Dispose() }
}
`;
    await new Promise<void>((resolvePromise, reject) => {
      const helper = spawn(
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")],
        { stdio: "ignore", windowsHide: true },
      );
      const timer = setTimeout(() => {
        helper.kill();
        reject(new Error("Windows orphan-process cleanup timed out."));
      }, 5_000);
      helper.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      helper.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolvePromise();
        else reject(new Error(`Windows orphan-process cleanup exited with code ${code}.`));
      });
    });
  }
}
