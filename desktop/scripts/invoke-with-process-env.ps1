# Applies default process-environment values for the duration of an action.
# An explicit caller value always wins; the caller's original state (including
# "was unset") is restored even when the action throws.
function Invoke-WithProcessEnv {
    param(
        [Parameter(Mandatory)][hashtable]$Defaults,
        [Parameter(Mandatory)][scriptblock]$Action
    )
    $saved = @{}
    foreach ($name in $Defaults.Keys) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ([string]::IsNullOrEmpty($saved[$name])) {
            Set-Item -Path "Env:$name" -Value ([string]$Defaults[$name])
        }
    }
    try {
        & $Action
    } finally {
        foreach ($name in $Defaults.Keys) {
            if ($null -eq $saved[$name]) {
                Remove-Item "Env:$name" -ErrorAction SilentlyContinue
            } else {
                Set-Item -Path "Env:$name" -Value $saved[$name]
            }
        }
    }
}
