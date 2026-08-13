param(
  [Parameter(Mandatory = $true)][string]$SourcePath,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $OutputPath) { exit 0 }
$references = @('System.Web.Extensions', 'System.Windows.Forms', 'System.Drawing', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase') |
  ForEach-Object {
    $assembly = [Reflection.Assembly]::LoadWithPartialName($_)
    if ($null -eq $assembly) { throw "assembly_not_found:$_" }
    $assembly.Location
  }
Add-Type -Path $SourcePath -OutputAssembly $OutputPath -OutputType ConsoleApplication -ReferencedAssemblies $references
