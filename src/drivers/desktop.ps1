param(
  [Parameter(Mandatory = $true)][string]$Operation,
  [string]$WindowId,
  [string]$QueryJson,
  [string]$QueryJsonBase64,
  [string]$Value,
  [string]$KeysJson,
  [string]$KeysJsonBase64,
  [string]$BoundsJson,
  [string]$BoundsJsonBase64
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

if (-not ('ComputerUsePlus.NativeMethods' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
namespace ComputerUsePlus {
  public static class NativeMethods {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    public const uint LEFTDOWN = 0x0002;
    public const uint LEFTUP = 0x0004;
  }
}
'@
}

function Emit($value) {
  @($value) | ConvertTo-Json -Compress -Depth 10
}

function Get-Bounds($rect) {
  function Safe-Int($value) {
    $number = [double]$value
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) { return 0 }
    if ($number -gt [int]::MaxValue) { return [int]::MaxValue }
    if ($number -lt [int]::MinValue) { return [int]::MinValue }
    return [int]$number
  }
  return @{ x = Safe-Int $rect.Left; y = Safe-Int $rect.Top; width = Safe-Int $rect.Width; height = Safe-Int $rect.Height }
}

function Get-ElementData($element) {
  $current = $element.Current
  $role = $current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
  return @{
    name = $current.Name
    role = $role
    automationId = $current.AutomationId
    className = $current.ClassName
    processId = $current.ProcessId
    bounds = Get-Bounds $current.BoundingRectangle
    enabled = $current.IsEnabled
    offscreen = $current.IsOffscreen
    handle = [int64]$current.NativeWindowHandle
  }
}

function Get-RootWindows {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $condition = [System.Windows.Automation.Condition]::TrueCondition
  $items = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  $foreground = [int64][ComputerUsePlus.NativeMethods]::GetForegroundWindow()
  $result = @()
  foreach ($item in $items) {
    $current = $item.Current
    if ($current.NativeWindowHandle -eq 0) { continue }
    $processName = ''
    try { $processName = (Get-Process -Id $current.ProcessId -ErrorAction Stop).ProcessName } catch { }
    $result += @{
      id = [string][int64]$current.NativeWindowHandle
      title = $current.Name
      process = $processName
      className = $current.ClassName
      bounds = Get-Bounds $current.BoundingRectangle
      isForeground = ([int64]$current.NativeWindowHandle -eq $foreground)
    }
  }
  return $result
}

function Get-Window($id) {
  $handle = [IntPtr]([int64]$id)
  return [System.Windows.Automation.AutomationElement]::FromHandle($handle)
}

function Get-Query {
  if (-not [string]::IsNullOrWhiteSpace($QueryJsonBase64)) {
    $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($QueryJsonBase64))
    return $json | ConvertFrom-Json
  }
  if ([string]::IsNullOrWhiteSpace($QueryJson)) { return [pscustomobject]@{} }
  return $QueryJson | ConvertFrom-Json
}

function Find-Elements($window, $query) {
  $condition = [System.Windows.Automation.Condition]::TrueCondition
  $items = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $matches = @()
  $needle = [string]$query.text
  $role = [string]$query.role
  foreach ($item in $items) {
    $current = $item.Current
    if ($current.IsOffscreen -and -not $query.includeOffscreen) { continue }
    if ($needle -and $current.Name.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
    $actualRole = $current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    if ($role -and $actualRole.IndexOf($role, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
    $matches += ,(Get-ElementData $item)
  }
  $limit = if ($query.limit) { [int]$query.limit } else { 10 }
  return @($matches | Select-Object -First ([Math]::Min($limit, 50)))
}

function Find-Target($window, $query) {
  $all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $matches = @()
  $needle = [string]$query.text
  $role = [string]$query.role
  foreach ($item in $all) {
    $current = $item.Current
    if ($current.IsOffscreen -and -not $query.includeOffscreen) { continue }
    if ($needle -and $current.Name.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
    $actualRole = $current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    if ($role -and $actualRole.IndexOf($role, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
    $matches += ,$item
  }
  if ($matches.Count -eq 0) { throw "target_not_found" }
  $exact = @($matches | Where-Object { $_.Current.Name -eq $needle })
  if ($exact.Count -eq 1) { return $exact[0] }
  if ($exact.Count -gt 1) { throw "target_ambiguous" }
  if ($matches.Count -eq 1) { return $matches[0] }
  throw "target_ambiguous"
}

try {
  switch ($Operation) {
    'listWindows' {
      Emit (Get-RootWindows)
      break
    }
    'findElements' {
      $window = Get-Window $WindowId
      Emit (Find-Elements $window (Get-Query))
      break
    }
    'focus' {
      [ComputerUsePlus.NativeMethods]::SetForegroundWindow([IntPtr]([int64]$WindowId)) | Out-Null
      Start-Sleep -Milliseconds 100
      Emit @{ ok = $true; window = $WindowId }
      break
    }
    'click' {
      $window = Get-Window $WindowId
      $query = Get-Query
      $target = Find-Target $window $query
      $invoker = $null
      $invokeFallback = $false
      try {
        $invoker = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      } catch {
        # Some WebView and custom-drawn controls expose a clickable bounds but no InvokePattern.
        $invokeFallback = $true
      }
      if ($invoker) {
        $invoker.Invoke()
        Emit @{ ok = $true; element = Get-ElementData $target; strategy = 'uia.invoke' }
      } else {
        $rect = $target.Current.BoundingRectangle
        $x = [int]($rect.Left + ($rect.Width / 2)); $y = [int]($rect.Top + ($rect.Height / 2))
        [ComputerUsePlus.NativeMethods]::SetCursorPos($x, $y) | Out-Null
        [ComputerUsePlus.NativeMethods]::mouse_event([ComputerUsePlus.NativeMethods]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
        [ComputerUsePlus.NativeMethods]::mouse_event([ComputerUsePlus.NativeMethods]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
        Emit @{ ok = $true; element = Get-ElementData $target; strategy = $(if ($invokeFallback) { 'win32.click.invoke-fallback' } else { 'win32.click' }) }
      }
      break
    }
    'setValue' {
      $window = Get-Window $WindowId
      $target = Find-Target $window (Get-Query)
      $pattern = $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      if (-not $pattern) { throw 'value_pattern_unavailable' }
      $pattern.SetValue($Value)
      Emit @{ ok = $true; element = Get-ElementData $target; strategy = 'uia.value' }
      break
    }
    'sendKeys' {
      if (-not [string]::IsNullOrWhiteSpace($KeysJsonBase64)) {
        $KeysJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($KeysJsonBase64))
      }
      $keys = if ($KeysJson -is [string]) { $KeysJson | ConvertFrom-Json } else { $KeysJson }
      foreach ($entry in @($keys)) {
        $key = if ($entry -is [string]) { $entry } else { [string]$entry.key }
        $at = if ($entry -is [string]) { 0 } else { [int]$entry.at }
        if ($at -gt 0) { Start-Sleep -Milliseconds $at }
        [System.Windows.Forms.SendKeys]::SendWait($key)
      }
      Emit @{ ok = $true; count = @($keys).Count; strategy = 'sendkeys' }
      break
    }
    'clickAt' {
      if (-not [string]::IsNullOrWhiteSpace($BoundsJsonBase64)) {
        $BoundsJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($BoundsJsonBase64))
      }
      $bounds = $BoundsJson | ConvertFrom-Json
      [ComputerUsePlus.NativeMethods]::SetForegroundWindow([IntPtr]([int64]$WindowId)) | Out-Null
      $x = [int]($bounds.x + ($bounds.width / 2)); $y = [int]($bounds.y + ($bounds.height / 2))
      [ComputerUsePlus.NativeMethods]::SetCursorPos($x, $y) | Out-Null
      [ComputerUsePlus.NativeMethods]::mouse_event([ComputerUsePlus.NativeMethods]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
      [ComputerUsePlus.NativeMethods]::mouse_event([ComputerUsePlus.NativeMethods]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
      Emit @{ ok = $true; strategy = 'win32.coordinate' }
      break
    }
    default { throw "unknown_operation:$Operation" }
  }
} catch {
  Emit @{ error = $_.Exception.Message }
  exit 1
}
