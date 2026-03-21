#!/usr/bin/env bash

# Shared download source override helpers for Bash install/start scripts.
# Explicit user input only; no automatic fallback policy here.

ARG_CAT_CAFE_NPM_REGISTRY="${ARG_CAT_CAFE_NPM_REGISTRY:-}"
ARG_CAT_CAFE_PIP_INDEX_URL="${ARG_CAT_CAFE_PIP_INDEX_URL:-}"
ARG_CAT_CAFE_PIP_EXTRA_INDEX_URL="${ARG_CAT_CAFE_PIP_EXTRA_INDEX_URL:-}"
ARG_CAT_CAFE_HF_ENDPOINT="${ARG_CAT_CAFE_HF_ENDPOINT:-}"

parse_manual_download_source_arg() {
  case "${1:-}" in
    --npm-registry=*)
      ARG_CAT_CAFE_NPM_REGISTRY="${1#*=}"
      return 0
      ;;
    --pip-index-url=*)
      ARG_CAT_CAFE_PIP_INDEX_URL="${1#*=}"
      return 0
      ;;
    --pip-extra-index-url=*)
      ARG_CAT_CAFE_PIP_EXTRA_INDEX_URL="${1#*=}"
      return 0
      ;;
    --hf-endpoint=*)
      ARG_CAT_CAFE_HF_ENDPOINT="${1#*=}"
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

apply_manual_download_source_overrides() {
  if [ -n "${ARG_CAT_CAFE_NPM_REGISTRY:-}" ]; then
    CAT_CAFE_NPM_REGISTRY="${ARG_CAT_CAFE_NPM_REGISTRY}"
  fi
  if [ -n "${ARG_CAT_CAFE_PIP_INDEX_URL:-}" ]; then
    CAT_CAFE_PIP_INDEX_URL="${ARG_CAT_CAFE_PIP_INDEX_URL}"
  fi
  if [ -n "${ARG_CAT_CAFE_PIP_EXTRA_INDEX_URL:-}" ]; then
    CAT_CAFE_PIP_EXTRA_INDEX_URL="${ARG_CAT_CAFE_PIP_EXTRA_INDEX_URL}"
  fi
  if [ -n "${ARG_CAT_CAFE_HF_ENDPOINT:-}" ]; then
    CAT_CAFE_HF_ENDPOINT="${ARG_CAT_CAFE_HF_ENDPOINT}"
  fi

  if [ -n "${CAT_CAFE_NPM_REGISTRY:-}" ]; then
    export CAT_CAFE_NPM_REGISTRY
    export NPM_CONFIG_REGISTRY="${CAT_CAFE_NPM_REGISTRY}"
  fi
  if [ -n "${CAT_CAFE_PIP_INDEX_URL:-}" ]; then
    export CAT_CAFE_PIP_INDEX_URL
    export PIP_INDEX_URL="${CAT_CAFE_PIP_INDEX_URL}"
  fi
  if [ -n "${CAT_CAFE_PIP_EXTRA_INDEX_URL:-}" ]; then
    export CAT_CAFE_PIP_EXTRA_INDEX_URL
    export PIP_EXTRA_INDEX_URL="${CAT_CAFE_PIP_EXTRA_INDEX_URL}"
  fi
  if [ -n "${CAT_CAFE_HF_ENDPOINT:-}" ]; then
    export CAT_CAFE_HF_ENDPOINT
    export HF_ENDPOINT="${CAT_CAFE_HF_ENDPOINT}"
  fi
}

print_manual_download_source_summary() {
  [ -n "${CAT_CAFE_NPM_REGISTRY:-}" ] && echo "  手动镜像: npm registry=$CAT_CAFE_NPM_REGISTRY"
  [ -n "${CAT_CAFE_PIP_INDEX_URL:-}" ] && echo "  手动镜像: pip index=$CAT_CAFE_PIP_INDEX_URL"
  [ -n "${CAT_CAFE_PIP_EXTRA_INDEX_URL:-}" ] && echo "  手动镜像: pip extra-index=$CAT_CAFE_PIP_EXTRA_INDEX_URL"
  [ -n "${CAT_CAFE_HF_ENDPOINT:-}" ] && echo "  手动镜像: hf endpoint=$CAT_CAFE_HF_ENDPOINT"
  true
}
