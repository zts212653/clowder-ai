import { execFile } from 'node:child_process';
import { join, win32 } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
type WindowsFileAction = 'open' | 'open-with' | 'reveal';
type ShellError = 'default_application_unavailable' | 'not_found' | 'access_denied' | 'file_action_failed';

const shell = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ClowderFileShell {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct ShellExecuteInfo {
    public int Size;
    public uint Mask;
    public IntPtr Window;
    public string Verb, File, Parameters, Directory;
    public int Show;
    public IntPtr Instance, ItemIdList;
    public string Class;
    public IntPtr ClassKey;
    public uint HotKey;
    public IntPtr IconOrMonitor, Process;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct OpenAsInfo {
    public string File, Class;
    public uint Flags;
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool ShellExecuteExW(ref ShellExecuteInfo info);

  [DllImport("shell32.dll")]
  static extern int SHOpenWithDialog(IntPtr window, ref OpenAsInfo info);

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  static extern int SHParseDisplayName(string name, IntPtr context, out IntPtr pidl, uint mask, IntPtr attributes);

  [DllImport("shell32.dll")]
  static extern int SHOpenFolderAndSelectItems(IntPtr pidl, uint count, IntPtr children, uint flags);

  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  static extern int AssocQueryStringW(uint flags, uint kind, string association, string verb, StringBuilder value, ref uint size);

  public static int Run(string action, string path) {
    if (action == "open") {
      string extension = System.IO.Path.GetExtension(path);
      if (!String.IsNullOrEmpty(extension) && Application(extension) == "no-default") return 1155;
      var info = new ShellExecuteInfo {
        Size = Marshal.SizeOf(typeof(ShellExecuteInfo)),
        Mask = 0x400 | 0x100, // NO_UI | NOASYNC
        Verb = "open",
        File = path,
        Show = 1
      };
      return ShellExecuteExW(ref info) ? 0 : Marshal.GetLastWin32Error();
    }
    if (action == "open-with") {
      var info = new OpenAsInfo { File = path, Flags = 4 }; // OAIF_EXEC
      return SHOpenWithDialog(IntPtr.Zero, ref info);
    }
    IntPtr pidl;
    int result = SHParseDisplayName(path, IntPtr.Zero, out pidl, 0, IntPtr.Zero);
    if (result != 0) return result;
    try { return SHOpenFolderAndSelectItems(pidl, 0, IntPtr.Zero, 0); }
    finally { Marshal.FreeCoTaskMem(pidl); }
  }

  public static string Application(string extension) {
    // ASSOCSTR_FRIENDLYAPPNAME for the effective open verb.
    uint size = 1024;
    var name = new StringBuilder((int)size);
    int result = AssocQueryStringW(0x400, 4, extension, "open", name, ref size);
    if (result == unchecked((int)0x80070483)) return "no-default";
    return result == 0 && name.Length > 0 ? "name:" + name.ToString() : "";
  }
}
'@
if ($env:CLOWDER_FILE_SHELL_ACTION -eq 'association') {
  [ClowderFileShell]::Application($env:CLOWDER_FILE_SHELL_TARGET)
} else {
  [ClowderFileShell]::Run($env:CLOWDER_FILE_SHELL_ACTION, $env:CLOWDER_FILE_SHELL_TARGET)
}
`;
const encodedShell = Buffer.from(shell, 'utf16le').toString('base64');

async function invoke(action: WindowsFileAction | 'association', target: string) {
  // Paths stay native. PowerShell receives them as data, including spaces and percent signs.
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await exec(
    powershell,
    ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encodedShell],
    {
      windowsHide: true,
      timeout: action === 'open-with' ? 0 : 8000,
      env: { ...process.env, CLOWDER_FILE_SHELL_ACTION: action, CLOWDER_FILE_SHELL_TARGET: target },
    },
  );
  return stdout.trim();
}

export const windowsFileActions: {
  application(path: string): Promise<{ name?: string; noDefault?: boolean }>;
  run(action: WindowsFileAction, path: string): Promise<ShellError | undefined>;
} = {
  async application(path) {
    const extension = win32.extname(path);
    if (!extension) return {};
    const value = await invoke('association', extension).catch(() => '');
    if (value === 'no-default') return { noDefault: true };
    return value.startsWith('name:') ? { name: value.slice(5) } : {};
  },
  async run(action, path) {
    const value = await invoke(action, path).catch(() => '');
    if (!/^-?\d+$/.test(value)) return 'file_action_failed';
    const status = Number(value) >>> 0;
    const code = status >>> 16 === 0x8007 ? status & 0xffff : status;
    if (code === 0 || (action === 'open-with' && code === 1223)) return undefined;
    if (action === 'open' && (code === 1155 || code === 31)) return 'default_application_unavailable';
    if (code === 2 || code === 3) return 'not_found';
    if (code === 5) return 'access_denied';
    return 'file_action_failed';
  },
};
