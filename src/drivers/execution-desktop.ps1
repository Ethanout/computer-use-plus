param(
  [Parameter(Mandatory = $true)][ValidateSet('create', 'destroy')][string]$Operation,
  [string]$DesktopName,
  [string]$PipeName,
  [string]$AgentPath,
  [string]$DataDir
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if (-not ('ComputerUsePlus.ExecutionDesktop' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace ComputerUsePlus {
  public static class ExecutionDesktop {
    const uint DESKTOP_ALL_ACCESS = 0x01FF;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const uint CREATE_NO_WINDOW = 0x08000000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
      public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
      public int dwX; public int dwY; public int dwXSize; public int dwYSize;
      public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
      public int dwFlags; public short wShowWindow; public short cbReserved2;
      public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
      public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, uint flags, uint access, IntPtr security);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr OpenDesktop(string name, uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string appName, StringBuilder commandLine, IntPtr processAttributes,
      IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment,
      string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

    static void ThrowLastError(string operation) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    public static IntPtr Create(string name) {
      IntPtr desktop = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, DESKTOP_ALL_ACCESS, IntPtr.Zero);
      if (desktop == IntPtr.Zero) ThrowLastError("CreateDesktop");
      return desktop;
    }

    public static void Close(IntPtr desktop) { if (desktop != IntPtr.Zero) CloseDesktop(desktop); }

    public static int LaunchExecutable(string desktopName, string applicationName, string commandLine, string workingDirectory) {
      STARTUPINFO startup = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)), lpDesktop = "WinSta0\\" + desktopName };
      PROCESS_INFORMATION process;
      if (!CreateProcess(applicationName, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
          IntPtr.Zero, workingDirectory, ref startup, out process)) ThrowLastError("CreateProcess");
      CloseHandle(process.hThread); CloseHandle(process.hProcess);
      return process.dwProcessId;
    }

    public static bool Destroy(string name) {
      IntPtr desktop = OpenDesktop(name, 0, false, DESKTOP_ALL_ACCESS);
      // Window stations delete a desktop automatically when its final handle closes.
      // A missing desktop therefore means shutdown already completed successfully.
      if (desktop == IntPtr.Zero) return false;
      if (!CloseDesktop(desktop)) ThrowLastError("CloseDesktop");
      return true;
    }
  }
}
'@
}

function Emit($value) { $value | ConvertTo-Json -Compress -Depth 5 }
function Quote-ArgSafe($value) { return [char]34 + $value + [char]34 }

function Wait-AgentReady($name, [int]$timeoutMs = 5000) {
  $started = [Environment]::TickCount
  while (([Environment]::TickCount - $started) -lt $timeoutMs) {
    $pipe = $null
    try {
      $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', $name, [System.IO.Pipes.PipeDirection]::InOut)
      $pipe.Connect(250)
      # A successful connection proves that the agent initialized UIA and created its server.
      # The Node manager performs the protocol-level ping after this controller exits.
      return $true
    } catch { Start-Sleep -Milliseconds 50 }
    finally { if ($null -ne $pipe) { $pipe.Dispose() } }
  }
  throw 'execution_agent_not_ready'
}

try {
  if ($Operation -eq 'create') {
    if ([string]::IsNullOrWhiteSpace($DesktopName)) { $DesktopName = "ComputerUsePlus-$([guid]::NewGuid().ToString('N'))" }
    if ([string]::IsNullOrWhiteSpace($PipeName)) { $PipeName = "computer-use-plus-$([guid]::NewGuid().ToString('N'))" }
    $desktopHandle = [ComputerUsePlus.ExecutionDesktop]::Create($DesktopName)
    $agentProcessId = $null
    try {
      $projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
      $dataDir = if ([string]::IsNullOrWhiteSpace($DataDir)) { Join-Path $projectRoot '.data' } else { $DataDir }
      [System.IO.Directory]::CreateDirectory($dataDir) | Out-Null
      $logPath = Join-Path $dataDir "execution-agent-$PipeName.log"
      if ([string]::IsNullOrWhiteSpace($AgentPath) -or -not (Test-Path -LiteralPath $AgentPath)) { throw 'agent_binary_required' }
      $arguments = "$(Quote-ArgSafe $AgentPath) --pipe $(Quote-ArgSafe $PipeName) --log $(Quote-ArgSafe $logPath)"
      $agentProcessId = [ComputerUsePlus.ExecutionDesktop]::LaunchExecutable($DesktopName, $AgentPath, $arguments, (Split-Path -Parent $PSScriptRoot))
      Wait-AgentReady $PipeName | Out-Null
    }
    catch {
      if ($null -ne $agentProcessId) { Stop-Process -Id $agentProcessId -Force -ErrorAction SilentlyContinue }
      throw
    }
    finally { [ComputerUsePlus.ExecutionDesktop]::Close($desktopHandle) }
    Emit @{ ok = $true; desktop = $DesktopName; pipe = $PipeName; agentPid = $agentProcessId; logPath = $logPath; agentReady = $true }
    exit 0
  }
  if ($Operation -eq 'destroy') {
    if ([string]::IsNullOrWhiteSpace($DesktopName)) { throw 'desktop_required' }
    $wasOpen = [ComputerUsePlus.ExecutionDesktop]::Destroy($DesktopName)
    Emit @{ ok = $true; desktop = $DesktopName; destroyed = $true; wasOpen = $wasOpen }
  }
} catch {
  Emit @{ ok = $false; error = $_.Exception.Message }
  exit 1
}
