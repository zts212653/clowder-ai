import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

// Windows PowerShell 5.1 uses .NET Framework's atomic ACL creation overload.
// https://learn.microsoft.com/dotnet/api/system.io.directory.createdirectory?view=netframework-4.8.1
// Paths arrive as JSON on stdin, never as interpolated PowerShell source.
const PRIVATE_DIRECTORY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $sidType = [System.Security.Principal.SecurityIdentifier]
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $trusted = @($user.Value, 'S-1-5-18', 'S-1-5-32-544')
  # Windows system directories can be owned by the servicing identity.
  $parentOwners = $trusted + @('S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $inheritOnly = [System.Security.AccessControl.PropagationFlags]::InheritOnly
  $full = [System.Security.AccessControl.FileSystemRights]::FullControl

  function Assert-Directory([string] $path) {
    $attributes = [System.IO.File]::GetAttributes($path)
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'ACP bootstrap directory must not be a symlink or reparse point'
    }
    if (($attributes -band [System.IO.FileAttributes]::Directory) -eq 0) {
      throw 'ACP bootstrap path must be a directory'
    }
  }

  function Assert-Private([string] $path) {
    Assert-Directory $path
    $acl = [System.IO.Directory]::GetAccessControl($path)
    if ($acl.GetOwner($sidType).Value -ne $user.Value) {
      throw 'ACP bootstrap directory has an untrusted owner'
    }
    if (-not $acl.AreAccessRulesProtected) {
      throw 'ACP bootstrap directory must have a protected private DACL'
    }
    $userFullControl = $false
    foreach ($rule in $acl.GetAccessRules($true, $true, $sidType)) {
      # Reject even inherit-only broad grants: future files must stay private.
      if ($rule.AccessControlType -eq $allow) {
        if ($trusted -notcontains $rule.IdentityReference.Value) {
          throw 'ACP bootstrap directory has an unsafe Allow ACL'
        }
        if ($rule.IdentityReference.Value -eq $user.Value -and
            ($rule.PropagationFlags -band $inheritOnly) -eq 0 -and
            ($rule.FileSystemRights -band $full) -eq $full) {
          $userFullControl = $true
        }
      } else {
        # Deny ACEs could make a private-looking directory unusable on reopen.
        throw 'ACP bootstrap directory has an unsupported Deny ACL'
      }
    }
    if (-not $userFullControl) { throw 'ACP bootstrap directory lacks owner FullControl' }
  }

  function Assert-Parents([string] $path) {
    $parent = [System.IO.Directory]::GetParent($path)
    while ($null -ne $parent) {
      Assert-Directory $parent.FullName
      $parentAcl = [System.IO.Directory]::GetAccessControl($parent.FullName)
      if ($parentOwners -notcontains $parentAcl.GetOwner($sidType).Value) {
        throw 'ACP bootstrap parent has an untrusted owner'
      }
      foreach ($rule in $parentAcl.GetAccessRules($true, $true, $sidType)) {
        # DELETE / DELETE_CHILD / WRITE_DAC / WRITE_OWNER can bypass a
        # private child DACL. Creation rights alone on shared ancestors are OK.
        if ($rule.AccessControlType -eq $allow -and
            ($rule.PropagationFlags -band $inheritOnly) -eq 0 -and
            $trusted -notcontains $rule.IdentityReference.Value -and
            ([int]$rule.FileSystemRights -band 0xD0040) -ne 0) {
          throw "ACP bootstrap parent permits unsafe directory replacement: $($parent.FullName) allows $($rule.IdentityReference.Value) $($rule.FileSystemRights)"
        }
      }
      $parent = $parent.Parent
    }
  }

  function Ensure-Private([string] $path) {
    Assert-Parents $path
    if (-not [System.IO.Directory]::Exists($path)) {
      $security = [System.Security.AccessControl.DirectorySecurity]::new()
      $security.SetOwner($user)
      $security.SetAccessRuleProtection($true, $false)
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $user, $full,
        [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
        [System.Security.AccessControl.PropagationFlags]::None, $allow)
      $security.AddAccessRule($rule)
      # The immediate parent must already exist. Avoid creating intermediate
      # directories outside the explicitly requested private root.
      $parent = [System.IO.Directory]::GetParent($path)
      Assert-Directory $parent.FullName
      [void][System.IO.Directory]::CreateDirectory($path, $security)
    }
    Assert-Private $path
  }

  Ensure-Private $request.root
  Ensure-Private $request.cwd
  # Recheck both after creation, including ancestors, before returning to spawn.
  Assert-Parents $request.cwd
  Assert-Private $request.root
  Assert-Private $request.cwd
  [Console]::Out.Write('acp-private-directory-v1')
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

export function ensureWindowsAcpBootstrapDirectories(root: string, cwd: string): void {
  if (!isAbsolute(root) || !isAbsolute(cwd)) throw new Error('Windows ACP bootstrap requires absolute paths');
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  try {
    const output = execFileSync(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(PRIVATE_DIRECTORY_SCRIPT, 'utf16le').toString('base64'),
      ],
      {
        // A pwsh -> Node -> Windows PowerShell chain otherwise inherits
        // incompatible PowerShell 7 modules. Let WinPS build its own paths.
        // https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_psmodulepath
        env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH')),
        input: JSON.stringify({ root, cwd }),
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    if (output.trim() !== 'acp-private-directory-v1') throw new Error('Missing Windows ACL verification receipt');
  } catch (cause) {
    const detail =
      cause instanceof Error && 'stderr' in cause ? String(cause.stderr).trim() : 'verification unavailable';
    throw new Error(`Windows ACP bootstrap privacy check failed: ${detail}`, { cause });
  }
}
