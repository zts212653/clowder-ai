import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Windows PowerShell ships with the .NET Framework filesystem ACL APIs. Paths
// travel as environment data, never as PowerShell source or shell arguments.
const script = `
$ErrorActionPreference = 'Stop'
try {
  $path = $env:COLLECTIVE_PRIVATE_PATH
  $directory = $env:COLLECTIVE_PRIVATE_KIND -eq 'directory'
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
  if ($env:COLLECTIVE_PRIVATE_CREATE -eq '1' -and -not [System.IO.Directory]::Exists($path)) {
    $security = [System.Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    foreach ($identity in $trusted) {
      $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        [System.Security.Principal.SecurityIdentifier]::new($identity), 'FullControl',
        'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    }
    [void][System.IO.Directory]::CreateDirectory($path, $security)
  }
  $attributes = [System.IO.File]::GetAttributes($path)
  if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Collective private state must not be a reparse point'
  }
  if ((($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) -ne $directory) {
    throw 'Collective private state has the wrong file type'
  }
  if ($directory) { $acl = [System.IO.Directory]::GetAccessControl($path) }
  else { $acl = [System.IO.File]::GetAccessControl($path) }
  $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new(
    $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All))
  if ($null -eq $descriptor.DiscretionaryAcl) {
    throw 'Collective permissions must be private (non-null DACL)'
  }
  if ($trusted -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) {
    throw 'Collective permissions must have a trusted owner'
  }
  if ($directory -and -not $acl.AreAccessRulesProtected) {
    throw 'Collective directory permissions must be private (protected DACL)'
  }
  $hasTrustedAllow = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
      if ($trusted -notcontains $rule.IdentityReference.Value) {
        throw 'Collective permissions must be private (untrusted DACL grant)'
      }
      $hasTrustedAllow = $true
    }
  }
  if (-not $hasTrustedAllow) { throw 'Collective permissions lack a trusted access grant' }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

export async function assertWindowsPrivatePath(
  path: string,
  kind: 'directory' | 'file',
  create = false,
): Promise<void> {
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  try {
    await run(
      executable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        windowsHide: true,
        timeout: 10_000,
        env: {
          ...process.env,
          COLLECTIVE_PRIVATE_PATH: resolve(path),
          COLLECTIVE_PRIVATE_KIND: kind,
          COLLECTIVE_PRIVATE_CREATE: create ? '1' : '0',
        },
      },
    );
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`Collective private Windows ACL check failed: ${path}${detail ? `: ${detail}` : ''}`, {
      cause: error,
    });
  }
}
