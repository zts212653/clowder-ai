# Shared source-Host reader. It never writes deployment files.
function Import-HostDotEnv {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Get-Content -LiteralPath $Path -Encoding UTF8 | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#')) {
            $parts = $line -split '=', 2
            if ($parts.Count -eq 2) {
                $key = $parts[0].Trim()
                $value = $parts[1].Trim().Trim('"').Trim("'")
                if ($key -eq 'CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE' -and $value -notin @('strict', 'trusted-host')) {
                    throw 'CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE must be strict or trusted-host (empty values are invalid)'
                }
                if ($key -eq 'CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE' -and $value -notin @('required', 'warn-bootstrap-root')) {
                    throw 'CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE must be required or warn-bootstrap-root (empty values are invalid)'
                }
                [Environment]::SetEnvironmentVariable($key, $value, 'Process')
            }
        }
    }
}
function Get-AcpDeploymentModes {
    $legacy = $env:CAT_CAFE_TRUSTED_HOST_COMPATIBILITY -eq '1'
    $bootstrap = if ($env:CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE) { $env:CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE } elseif ($legacy) { 'trusted-host' } else { 'strict' }
    $audit = if ($env:CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE) { $env:CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE } elseif ($legacy) { 'warn-bootstrap-root' } else { 'required' }
    if ($bootstrap -notin @('strict', 'trusted-host')) { throw 'Invalid CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE' }
    if ($audit -notin @('required', 'warn-bootstrap-root')) { throw 'Invalid CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE' }
    $effective = if ($bootstrap -eq 'trusted-host') { $audit } else { 'required' }
    [PSCustomObject]@{ Bootstrap = $bootstrap; RequestedAudit = $audit; EffectiveAudit = $effective }
}
