/** Native identity, from the SAME opened directory handle; a lexical drive root is insufficient. */
export const WINDOWS_VOLUME_IDENTITY_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class AcpVolumeIdentity {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle h, StringBuilder path, uint length, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int kind, IntPtr data, uint length);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool GetVolumeInformationByHandleW(SafeFileHandle h, IntPtr name, uint size, out uint serial, out uint maximum, out uint flags, StringBuilder fs, uint fsSize);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  static extern uint GetDriveType(string root);
  public static bool IsRoot(string path) {
    // OPEN_EXISTING, BACKUP_SEMANTICS + OPEN_REPARSE_POINT; never DELETE_ON_CLOSE.
    using (var h = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if (h.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      var data = Marshal.AllocHGlobal(65536);
      try {
        if (!GetFileInformationByHandleEx(h, 9, data, 8)) throw new Win32Exception(Marshal.GetLastWin32Error());
        int attributes = Marshal.ReadInt32(data);
        if ((attributes & 0x400) != 0 || (attributes & 0x10) == 0) return false;
        if (!GetFileInformationByHandleEx(h, 2, data, 65536)) throw new Win32Exception(Marshal.GetLastWin32Error());
        int bytes = Marshal.ReadInt32(data);
        if (bytes != 2 || Marshal.PtrToStringUni(IntPtr.Add(data, 4), 1) != @"\") return false;
        var final = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandle(h, final, 32768, 1);
        if (length == 0 || length >= 32768) throw new Win32Exception(Marshal.GetLastWin32Error());
        string root = final.ToString();
        if (!root.StartsWith(@"\\?\Volume{", StringComparison.OrdinalIgnoreCase) || !root.EndsWith(@"}\")) return false;
        var fs = new StringBuilder(64); uint serial, maximum, flags;
        if (!GetVolumeInformationByHandleW(h, IntPtr.Zero, 0, out serial, out maximum, out flags, fs, 64))
          throw new Win32Exception(Marshal.GetLastWin32Error());
        return fs.ToString() == "NTFS" && (flags & 8) != 0 && GetDriveType(root) == 3;
      } finally { Marshal.FreeHGlobal(data); }
    }
  }
}
'@
`;
