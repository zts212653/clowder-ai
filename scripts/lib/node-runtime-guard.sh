#!/bin/bash

# Shared Node runtime guard for Clowder AI startup scripts.
# Native dependencies such as better-sqlite3 are not compatible with every
# fresh Node major on day one. Keep startup on a supported major instead of
# letting Homebrew's `node` alias silently move the runtime.

CAT_CAFE_NODE_MIN_MAJOR="${CAT_CAFE_NODE_MIN_MAJOR:-20}"
CAT_CAFE_NODE_MAX_MAJOR_EXCLUSIVE="${CAT_CAFE_NODE_MAX_MAJOR_EXCLUSIVE:-26}"
CAT_CAFE_NODE_PINNED_MAJOR="${CAT_CAFE_NODE_PINNED_MAJOR:-24}"
CAT_CAFE_NODE_PREFERRED_MAJORS="${CAT_CAFE_NODE_PREFERRED_MAJORS:-24 25 22 20}"

node_runtime_version() {
  local node_bin="$1"
  "$node_bin" -p 'process.versions.node' 2>/dev/null || return 1
}

node_runtime_major() {
  local node_bin="$1"
  "$node_bin" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || return 1
}

node_runtime_supported() {
  local node_bin="$1"
  local major
  [ -x "$node_bin" ] || return 1
  major="$(node_runtime_major "$node_bin")" || return 1
  [ "$major" -ge "$CAT_CAFE_NODE_MIN_MAJOR" ] && [ "$major" -lt "$CAT_CAFE_NODE_MAX_MAJOR_EXCLUSIVE" ]
}

candidate_node_paths() {
  local major prefix

  if [ -n "${CAT_CAFE_NODE_BIN:-}" ]; then
    printf '%s\n' "$CAT_CAFE_NODE_BIN"
  fi

  for major in $CAT_CAFE_NODE_PREFERRED_MAJORS; do
    if command -v brew >/dev/null 2>&1; then
      prefix="$(brew --prefix "node@$major" 2>/dev/null || true)"
      if [ -n "$prefix" ]; then
        printf '%s\n' "$prefix/bin/node"
      fi
    fi
    printf '/opt/homebrew/opt/node@%s/bin/node\n' "$major"
    printf '/usr/local/opt/node@%s/bin/node\n' "$major"
  done

  if command -v node >/dev/null 2>&1; then
    command -v node
  fi
}

find_supported_node_runtime() {
  local candidate seen_key seen=""
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    seen_key=":$candidate:"
    case "$seen" in
      *"$seen_key"*) continue ;;
    esac
    seen="${seen}${seen_key}"
    if node_runtime_supported "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done < <(candidate_node_paths)
  return 1
}

print_node_runtime_install_guidance() {
  cat >&2 <<'EOF'
[node-runtime] Install a supported Node runtime, then retry:
  brew install node@24
  PATH="$(brew --prefix node@24)/bin:$PATH" pnpm install --frozen-lockfile

Or point Clowder AI at an existing supported Node binary:
  CAT_CAFE_NODE_BIN=/absolute/path/to/node pnpm runtime:start
EOF
}

ensure_supported_node_runtime() {
  local script_path="$1"
  shift || true

  [ "${CAT_CAFE_SKIP_NODE_RUNTIME_GUARD:-0}" = "1" ] && return 0

  local current_node="" current_version="" current_major=""
  if command -v node >/dev/null 2>&1; then
    current_node="$(command -v node)"
    current_version="$(node_runtime_version "$current_node" || true)"
    current_major="$(node_runtime_major "$current_node" || true)"
  fi

  if [ -n "$current_node" ] && node_runtime_supported "$current_node"; then
    if [ -n "$CAT_CAFE_NODE_PINNED_MAJOR" ] &&
      [ "$current_major" != "$CAT_CAFE_NODE_PINNED_MAJOR" ] &&
      [ "${CAT_CAFE_NODE_RUNTIME_GUARD_REEXEC:-0}" != "1" ]; then
      local pinned_node pinned_dir pinned_version
      if pinned_node="$(find_supported_node_runtime)"; then
        pinned_dir="$(cd "$(dirname "$pinned_node")" && pwd -P)"
        pinned_version="$(node_runtime_version "$pinned_node" || echo unknown)"
        if [ -x "$pinned_node" ] && [ "$pinned_node" != "$current_node" ]; then
          echo "[node-runtime] current Node ${current_version:-<missing>} is supported but Clowder AI startup is pinned to Node ${CAT_CAFE_NODE_PINNED_MAJOR}; re-exec with $pinned_node ($pinned_version)" >&2
          export PATH="$pinned_dir:$PATH"
          export CAT_CAFE_NODE_RUNTIME_GUARD_REEXEC=1
          exec bash "$script_path" "$@"
        fi
      fi
    fi
    return 0
  fi

  if [ "${CAT_CAFE_NODE_RUNTIME_GUARD_REEXEC:-0}" = "1" ]; then
    echo "[node-runtime] ERROR: selected Node is still unsupported: ${current_node:-<missing>} ${current_version:-<unknown>}" >&2
    print_node_runtime_install_guidance
    exit 1
  fi

  local selected selected_dir selected_version
  if selected="$(find_supported_node_runtime)"; then
    selected_dir="$(cd "$(dirname "$selected")" && pwd -P)"
    selected_version="$(node_runtime_version "$selected" || echo unknown)"
    echo "[node-runtime] current Node ${current_version:-<missing>} is unsupported for Clowder AI startup; re-exec with $selected ($selected_version)" >&2
    export PATH="$selected_dir:$PATH"
    export CAT_CAFE_NODE_RUNTIME_GUARD_REEXEC=1
    exec bash "$script_path" "$@"
  fi

  echo "[node-runtime] ERROR: Node ${current_version:-<missing>} is unsupported for Clowder AI startup; expected >=${CAT_CAFE_NODE_MIN_MAJOR} <${CAT_CAFE_NODE_MAX_MAJOR_EXCLUSIVE}." >&2
  if [ -n "$current_major" ] && [ "$current_major" -ge "$CAT_CAFE_NODE_MAX_MAJOR_EXCLUSIVE" ]; then
    echo "[node-runtime] Native addons in this repo are not yet certified for Node $current_major." >&2
  fi
  print_node_runtime_install_guidance
  exit 1
}
