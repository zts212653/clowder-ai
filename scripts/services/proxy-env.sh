#!/usr/bin/env bash
# Shared proxy env normalization for service install/start scripts.

normalize_socks_proxy_env() {
  local key value normalized
  for key in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; do
    value="${!key:-}"
    case "$value" in
      socks://*)
        normalized="socks5://${value#socks://}"
        export "$key=$normalized"
        ;;
    esac
  done
}
