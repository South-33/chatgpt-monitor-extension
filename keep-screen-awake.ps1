$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class AwakeState
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint executionState);
}
"@

$continuous = [Convert]::ToUInt32("80000000", 16)
$systemRequired = [uint32]0x00000001
$displayRequired = [uint32]0x00000002
$awakeFlags = $continuous -bor $systemRequired -bor $displayRequired

try {
    $result = [AwakeState]::SetThreadExecutionState($awakeFlags)
    if ($result -eq 0) {
        throw "Windows rejected the keep-awake request."
    }

    Write-Host "Screen and computer will stay awake." -ForegroundColor Green
    Write-Host "Leave this window open. Press Ctrl+C or close it when finished."

    while ($true) {
        Start-Sleep -Seconds 30
        [void][AwakeState]::SetThreadExecutionState($awakeFlags)
    }
}
finally {
    [void][AwakeState]::SetThreadExecutionState($continuous)
    Write-Host "Normal Windows power behavior restored."
}
