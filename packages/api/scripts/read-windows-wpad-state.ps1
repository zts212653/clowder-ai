# Reads Windows WPAD state using WinHTTP API
# Returns JSON with autoDetect (bool or null) and autoConfigUrl (string or null)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class WinHttpProxy {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WINHTTP_CURRENT_USER_IE_PROXY_CONFIG {
        [MarshalAs(UnmanagedType.Bool)]
        public bool fAutoDetect;
        public IntPtr lpszAutoConfigUrl;
        public IntPtr lpszProxy;
        public IntPtr lpszProxyBypass;
    }

    [DllImport("winhttp.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool WinHttpGetIEProxyConfigForCurrentUser(
        ref WINHTTP_CURRENT_USER_IE_PROXY_CONFIG pProxyConfig);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalFree(IntPtr hMem);
}
"@

$config = New-Object WinHttpProxy+WINHTTP_CURRENT_USER_IE_PROXY_CONFIG
$success = [WinHttpProxy]::WinHttpGetIEProxyConfigForCurrentUser([ref]$config)

if ($success) {
    try {
        # Convert IntPtr to managed strings
        $autoConfigUrl = if ($config.lpszAutoConfigUrl -ne [IntPtr]::Zero) {
            [System.Runtime.InteropServices.Marshal]::PtrToStringUni($config.lpszAutoConfigUrl)
        } else {
            $null
        }

        $result = @{
            autoDetect = $config.fAutoDetect
            autoConfigUrl = $autoConfigUrl
        }
        $result | ConvertTo-Json -Compress
    } finally {
        # Free WinHTTP-allocated strings according to API contract
        if ($config.lpszAutoConfigUrl -ne [IntPtr]::Zero) {
            [WinHttpProxy]::GlobalFree($config.lpszAutoConfigUrl) | Out-Null
        }
        if ($config.lpszProxy -ne [IntPtr]::Zero) {
            [WinHttpProxy]::GlobalFree($config.lpszProxy) | Out-Null
        }
        if ($config.lpszProxyBypass -ne [IntPtr]::Zero) {
            [WinHttpProxy]::GlobalFree($config.lpszProxyBypass) | Out-Null
        }
    }
} else {
    $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $errorResult = @{
        autoDetect = $null
        autoConfigUrl = $null
        error = "WinHttpGetIEProxyConfigForCurrentUser failed with error code $errorCode"
    }
    $errorResult | ConvertTo-Json -Compress
}
