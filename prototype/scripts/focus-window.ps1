# Move a window to the primary monitor and bring it to the foreground.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/focus-window.ps1 -Title SFO-DEMO
param(
  [string]$Title = 'SFO-DEMO',
  [int]$Width = 2560,
  [int]$Height = 1528
)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinUtil {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int w, int h, bool repaint);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public static List<IntPtr> Find(string title) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.ToString().IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@
$handles = [WinUtil]::Find($Title)
if ($handles.Count -eq 0) { Write-Output 'NOT FOUND'; exit 1 }
$h = $handles[0]
[void][WinUtil]::ShowWindow($h, 9)   # SW_RESTORE
[void][WinUtil]::MoveWindow($h, 0, 0, $Width, $Height, $true)
[void][WinUtil]::ShowWindow($h, 3)   # SW_MAXIMIZE
[void][WinUtil]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0043)  # TOPMOST
[void][WinUtil]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0043)  # NOTOPMOST
[void][WinUtil]::SetForegroundWindow($h)
Write-Output ("OK " + $h)
