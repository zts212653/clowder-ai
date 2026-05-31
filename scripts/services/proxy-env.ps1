function Normalize-SocksProxyEnv {
    $proxyVars = @(
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy"
    )

    foreach ($name in $proxyVars) {
        $value = [System.Environment]::GetEnvironmentVariable($name, "Process")
        if ($value -like "socks://*") {
            $normalized = "socks5://" + $value.Substring("socks://".Length)
            [System.Environment]::SetEnvironmentVariable($name, $normalized, "Process")
        }
    }
}
