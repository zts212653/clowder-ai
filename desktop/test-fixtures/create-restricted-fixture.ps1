# Author-only acceptance helper: reduces the existing user token; no ACL or policy changes.
param([Parameter(Mandatory)][string]$BatchFile)
$ErrorActionPreference='Stop'
if(-not [IO.Path]::IsPathRooted($BatchFile) -or -not (Test-Path -LiteralPath $BatchFile)) { throw 'Expected an existing absolute acceptance batch path' }
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class StandardUserAcceptance {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved, desktop, title;
    public uint x,y,width,height,xCount,yCount,fill,flags;
    public short show,reservedLength; public IntPtr reservedBytes,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct Label { public IntPtr sid; public uint attributes; }
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SaferCreateLevel(uint scope,uint level,uint flags,out IntPtr handle,IntPtr reserved);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SaferComputeTokenFromLevel(IntPtr level,IntPtr input,out IntPtr token,uint flags,IntPtr reserved);
  [DllImport("advapi32.dll")] static extern bool SaferCloseLevel(IntPtr level);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSidToSid(string value,out IntPtr sid);
  [DllImport("advapi32.dll")] static extern uint GetLengthSid(IntPtr sid);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int kind,ref Label label,int length);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessWithTokenW(IntPtr token,uint logon,string app,StringBuilder command,uint flags,IntPtr environment,string directory,ref Startup startup,out ProcessInfo process);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  static void Check(bool ok) { if(!ok) throw new System.ComponentModel.Win32Exception(); }
  public static uint Launch(string batch) {
    IntPtr level=IntPtr.Zero,token=IntPtr.Zero,sid=IntPtr.Zero;
    try {
      Check(SaferCreateLevel(1,0x20000,1,out level,IntPtr.Zero));
      Check(SaferComputeTokenFromLevel(level,IntPtr.Zero,out token,0,IntPtr.Zero));
      Check(ConvertStringSidToSid("S-1-16-8192",out sid));
      Label label=new Label { sid=sid, attributes=0x20 };
      Check(SetTokenInformation(token,25,ref label,Marshal.SizeOf(typeof(Label))+(int)GetLengthSid(sid)));
      string cmd=Environment.GetFolderPath(Environment.SpecialFolder.System)+"\\cmd.exe";
      Startup startup=new Startup { cb=Marshal.SizeOf(typeof(Startup)),flags=1,show=0 };
      ProcessInfo process;
      Check(CreateProcessWithTokenW(token,0,cmd,new StringBuilder("\""+cmd+"\" /d /c \"\""+batch+"\"\""),0x08000000,IntPtr.Zero,System.IO.Path.GetDirectoryName(batch),ref startup,out process));
      CloseHandle(process.thread);
      try {
        if(WaitForSingleObject(process.process,20000)!=0) {
          System.Diagnostics.Process.GetProcessById((int)process.pid).Kill(true);
          throw new Exception("Owned restricted creator timed out");
        }
        uint code; Check(GetExitCodeProcess(process.process,out code));
        if(code!=0) throw new Exception("Owned restricted creator failed: "+code);
      } finally { CloseHandle(process.process); }
      return process.pid;
    } finally {
      if(sid!=IntPtr.Zero) LocalFree(sid);
      if(token!=IntPtr.Zero) CloseHandle(token);
      if(level!=IntPtr.Zero) SaferCloseLevel(level);
    }
  }
}
'@
[pscustomobject]@{pid=[StandardUserAcceptance]::Launch([IO.Path]::GetFullPath($BatchFile));intendedIntegrity='Medium';administratorRights='removed-by-SAFER-NORMALUSER'} | ConvertTo-Json -Compress
