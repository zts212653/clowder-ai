$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Ime1863Native {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] public struct Mouse { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct Keyboard { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct Union { [FieldOffset(0)] public Mouse mouse; [FieldOffset(0)] public Keyboard keyboard; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public Union u; }
  public delegate bool WindowProc(IntPtr window, IntPtr value);
  [DllImport("user32.dll")] public static extern bool EnumWindows(WindowProc callback, IntPtr value);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr w, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr w);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window,uint flag);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr w, int command);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr w, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint thread);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr w, uint message, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr w, out Rect rect);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, Input[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder info,int length,out int needed);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
  public static string Title(IntPtr w) { var b=new StringBuilder(1024); GetWindowText(w,b,b.Capacity);return b.ToString(); }
  public static IntPtr Find(string title) { IntPtr found=IntPtr.Zero; EnumWindows((w,v)=>{if(Title(w).Contains(title)) {found=w; return false;}return true;},IntPtr.Zero);return found; }
  public static void Key(ushort vk, bool up) {
    var input = new Input {type=1,u=new Union {keyboard=new Keyboard {scan=(ushort)MapVirtualKey(vk,0),flags=8u|(up?2u:0u)}}};
    if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(Input)))!=1) throw new InvalidOperationException("SendInput failed "+Marshal.GetLastWin32Error());
  }
  public static bool ClickOwnedTitlebar(IntPtr window) {
    Rect rect;GetWindowRect(window,out rect);
    var point=new Point {x=rect.left+200,y=rect.top+18};
    if(GetAncestor(WindowFromPoint(point),2)!=window)return false;
    SetCursorPos(point.x,point.y);
    var down=new Input {type=0,u=new Union {mouse=new Mouse {flags=2}}};
    var up=new Input {type=0,u=new Union {mouse=new Mouse {flags=4}}};
    return SendInput(2,new[]{down,up},Marshal.SizeOf(typeof(Input)))==2;
  }
  public static string Desktop() {
    var d=OpenInputDesktop(0,false,1); var b=new StringBuilder(256);int n;
    if(d==IntPtr.Zero)return "unavailable";
    GetUserObjectInformation(d,2,b,b.Capacity*2,out n);CloseDesktop(d);return b.ToString();
  }
}
'@
[Ime1863Native]::SetProcessDPIAware() | Out-Null
$originalWindow = [Ime1863Native]::GetForegroundWindow()
$originalPointer = New-Object Ime1863Native+Point
[Ime1863Native]::GetCursorPos([ref]$originalPointer) | Out-Null
$testWindow = [IntPtr]::Zero
while ($null -ne ($line = [Console]::ReadLine())) {
  $request = $line | ConvertFrom-Json
  [Console]::Error.WriteLine('native action: ' + $request.action)
  $result = $null
  if ($request.action -eq 'status') {
    $result = @{ desktop=[Ime1863Native]::Desktop(); foregroundTitle=[Ime1863Native]::Title([Ime1863Native]::GetForegroundWindow()); originalWindow=$originalWindow.ToInt64() }
  } elseif ($request.action -eq 'focus') {
    $testWindow = [Ime1863Native]::Find([string]$request.title)
    for ($attempt = 0; $testWindow -eq [IntPtr]::Zero -and $attempt -lt 50; $attempt++) {
      Start-Sleep -Milliseconds 100
      $testWindow = [Ime1863Native]::Find([string]$request.title)
    }
    if ($testWindow -eq [IntPtr]::Zero) { throw 'Owned test browser window not found' }
    [Ime1863Native]::ShowWindow($testWindow,3) | Out-Null
    [Ime1863Native]::SetForegroundWindow($testWindow) | Out-Null
    Start-Sleep -Milliseconds 250
    if ([Ime1863Native]::GetForegroundWindow() -ne $testWindow) {
      [Ime1863Native]::SetWindowPos($testWindow,[IntPtr]::Zero,0,0,0,0,0x53) | Out-Null
      [Ime1863Native]::ClickOwnedTitlebar($testWindow) | Out-Null
      Start-Sleep -Milliseconds 250
    }
    $owner = [uint32]0
    $thread = [Ime1863Native]::GetWindowThreadProcessId($testWindow,[ref]$owner)
    $foregroundOwner = [uint32]0
    [Ime1863Native]::GetWindowThreadProcessId([Ime1863Native]::GetForegroundWindow(),[ref]$foregroundOwner) | Out-Null
    $result = @{ window=$testWindow.ToInt64();pid=$owner;visible=[Ime1863Native]::IsWindowVisible($testWindow);layout=[Ime1863Native]::GetKeyboardLayout($thread).ToInt64();foreground=([Ime1863Native]::GetForegroundWindow() -eq $testWindow); foregroundPid=$foregroundOwner; foregroundWindow=[Ime1863Native]::GetForegroundWindow().ToInt64() }
  } elseif ($request.action -eq 'focusState') {
    $result = @{ foreground=([Ime1863Native]::GetForegroundWindow() -eq $testWindow) }
  } elseif ($request.action -eq 'chinese') {
    if ([Ime1863Native]::GetForegroundWindow() -ne $testWindow) { throw 'Test browser is not foreground' }
    [Ime1863Native]::PostMessage($testWindow,0x50,[IntPtr]::Zero,[IntPtr]134481924) | Out-Null
    Start-Sleep -Milliseconds 400
    $owner = [uint32]0
    $thread = [Ime1863Native]::GetWindowThreadProcessId($testWindow,[ref]$owner)
    $result = @{ layout=[Ime1863Native]::GetKeyboardLayout($thread).ToInt64() }
  } elseif ($request.action -eq 'keys') {
    if ($testWindow -eq [IntPtr]::Zero -or [Ime1863Native]::GetForegroundWindow() -ne $testWindow) { throw 'Refusing keys outside owned foreground test browser' }
    foreach ($modifier in $request.modifiers) { [Ime1863Native]::Key([uint16]$modifier,$false) }
    foreach ($key in $request.keys) {
      [Ime1863Native]::Key([uint16]$key,$false)
      [Ime1863Native]::Key([uint16]$key,$true)
      Start-Sleep -Milliseconds 85
    }
    foreach ($modifier in $request.modifiers) { [Ime1863Native]::Key([uint16]$modifier,$true) }
    $result = @{ sent=$request.keys.Count }
  } elseif ($request.action -eq 'capture') {
    if ([Ime1863Native]::GetForegroundWindow() -ne $testWindow) { throw 'Test browser is not foreground' }
    $rect = New-Object Ime1863Native+Rect
    [Ime1863Native]::GetWindowRect($testWindow,[ref]$rect) | Out-Null
    $screen = [Windows.Forms.Screen]::PrimaryScreen.Bounds
    $rect.left = [math]::Max($rect.left,$screen.Left)
    $rect.top = [math]::Max($rect.top,$screen.Top)
    $rect.right = [math]::Min($rect.right,$screen.Right)
    $rect.bottom = [math]::Min($rect.bottom,$screen.Bottom)
    $bitmap = New-Object Drawing.Bitmap ($rect.right-$rect.left),($rect.bottom-$rect.top)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($rect.left,$rect.top,0,0,$bitmap.Size)
    $bitmap.Save([string]$request.path,[Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose();$bitmap.Dispose()
    $result = @{ path=$request.path }
  } elseif ($request.action -eq 'restore') {
    [Ime1863Native]::SetForegroundWindow($originalWindow) | Out-Null
    [Ime1863Native]::SetCursorPos($originalPointer.x,$originalPointer.y) | Out-Null
    $result = @{ restored=([Ime1863Native]::GetForegroundWindow() -eq $originalWindow) }
  } else { throw 'Unknown native test action' }
  [Console]::WriteLine((@{id=$request.id;result=$result} | ConvertTo-Json -Compress -Depth 5))
}
