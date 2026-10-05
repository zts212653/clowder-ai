#!/usr/bin/env bash

# One canonical coordinate module supplies both launch and consumer validation.
named_alpha_coordinates() {
  node "$SCRIPT_DIR/lib/alpha-coordinates.mjs" "$@"
}

select_named_alpha() {
  case "$COMMAND" in init|start) ;; *) die "named Alpha supports only init/start; use exact managed preview ownership for other lifecycle actions" ;; esac
  [ "$NAMED_ALPHA_DISALLOWED_OPTIONS" = false ] || die "named Alpha does not accept path, branch, remote, force or child overrides"
  [ -n "$NAMED_ALPHA_INSTANCE" ] && [ -n "$NAMED_ALPHA_PORTS" ] || die "named Alpha requires --instance and --ports together"
  NAMED_ALPHA_COORDINATES="$(named_alpha_coordinates derive --main-root "$PROJECT_DIR" --instance "$NAMED_ALPHA_INSTANCE" --ports "$NAMED_ALPHA_PORTS")" || die "invalid named Alpha coordinates"
  read_named_alpha_selection
  LEGACY_ALPHA_DIR="$ALPHA_DIR"
  REMOTE_NAME=origin
  ENV_SOURCE_FILE="$PROJECT_DIR/.env"
}

read_named_alpha_selection() {
  local selected
  selected="$(node -e 'const c=JSON.parse(process.argv[1]); console.log([c.alphaRoot,c.branch,...Object.values(c.ports)].join("\t"))' "$NAMED_ALPHA_COORDINATES")" || die "invalid Alpha selection"
  IFS=$'\t' read -r ALPHA_DIR ALPHA_BRANCH ALPHA_FRONTEND_PORT ALPHA_API_PORT ALPHA_PREVIEW_GATEWAY_PORT ALPHA_COLLECTIVE_SERVICE_PORT ALPHA_REDIS_PORT <<< "$selected"
}

apply_named_alpha_environment() {
  local exports key value
  exports="$(named_alpha_coordinates env --record "$NAMED_ALPHA_COORDINATES" --installation-root "$ALPHA_DIR")" || die "named Alpha loaded proof failed"
  while IFS=$'\t' read -r key value; do
    export "$key=$value"
  done <<< "$exports"
  unset COLLECTIVE_GITHUB_CLIENT_ID COLLECTIVE_GITHUB_CLIENT_SECRET
}

assert_named_alpha_prepared() {
  named_alpha_coordinates inspect --record "$NAMED_ALPHA_COORDINATES" >/dev/null || die "named Alpha is not an exact registered main checkout"
  named_alpha_coordinates not-serving --record "$NAMED_ALPHA_COORDINATES" >/dev/null || die "named Alpha may not mutate a serving tree"
}

init_named_alpha_worktree() {
  require_git_repo
  ensure_remote_exists
  if worktree_exists; then
    assert_named_alpha_prepared
    info "named alpha worktree already exists: $ALPHA_DIR"
    return 0
  fi
  [ ! -e "$ALPHA_DIR" ] || die "preserve the existing unregistered named Alpha path"
  ! git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/heads/$ALPHA_BRANCH" || die "named Alpha branch already exists without its registered checkout"
  git -C "$PROJECT_DIR" fetch origin main
  local target
  target="$(git -C "$PROJECT_DIR" rev-parse --verify 'refs/remotes/origin/main^{commit}')"
  git -C "$PROJECT_DIR" worktree add "$ALPHA_DIR" -b "$ALPHA_BRANCH" "$target"
  assert_named_alpha_prepared
  if [ "$RUN_INSTALL" = true ]; then install_alpha_dependencies; fi
  info "named alpha worktree ready: $ALPHA_DIR"
}

sync_named_alpha_worktree() {
  assert_named_alpha_prepared
  git -C "$PROJECT_DIR" fetch origin main
  local target
  target="$(git -C "$PROJECT_DIR" rev-parse --verify 'refs/remotes/origin/main^{commit}')"
  git -C "$ALPHA_DIR" merge --ff-only "$target"
  NAMED_ALPHA_COORDINATES="$(named_alpha_coordinates derive --main-root "$PROJECT_DIR" --instance "$NAMED_ALPHA_INSTANCE" --ports "$NAMED_ALPHA_PORTS" --target-sha "$target")" || die "cannot freeze Alpha main revision"
  named_alpha_coordinates inspect --record "$NAMED_ALPHA_COORDINATES" >/dev/null || die "Alpha revision changed after exact main sync"
}

assert_named_alpha_ports_idle() {
  command -v lsof >/dev/null 2>&1 || die "named Alpha requires a listener ownership probe"
  local port rc
  for port in "$ALPHA_FRONTEND_PORT" "$ALPHA_API_PORT" "$ALPHA_PREVIEW_GATEWAY_PORT" "$ALPHA_COLLECTIVE_SERVICE_PORT" "$ALPHA_REDIS_PORT"; do
    rc=0
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || rc=$?
    [ "$rc" -eq 1 ] || die "named Alpha port $port is occupied or unreadable; no process will be replaced"
  done
}

start_named_alpha_worktree() {
  umask 077
  worktree_exists || die "named Alpha must be initialized as a registered checkout before start"
  assert_named_alpha_ports_idle
  sync_named_alpha_worktree
  ensure_alpha_dependencies
  build_alpha_stale_packages
  local selected_record="$NAMED_ALPHA_COORDINATES" selected_project="$PROJECT_DIR" selected_script="$SCRIPT_DIR"
  local selected_allow_empty="$ALPHA_EMPTY_REDIS_ALLOWED"
  local selected_preview_expiry="${CAT_CAFE_PREVIEW_EXPIRES_AT-}"
  source_env_if_present
  PROJECT_DIR="$selected_project"
  SCRIPT_DIR="$selected_script"
  NAMED_ALPHA_COORDINATES="$selected_record"
  ALPHA_EMPTY_REDIS_ALLOWED="$selected_allow_empty"
  export CAT_CAFE_PREVIEW_EXPIRES_AT="$selected_preview_expiry"
  read_named_alpha_selection
  apply_alpha_env
  assert_named_alpha_prepared
  # A listener appearing during install/build remains somebody else's process.
  assert_named_alpha_ports_idle
  info "starting named isolated Alpha from $ALPHA_DIR"
  cd "$ALPHA_DIR"
  exec ./scripts/start-dev.sh --quick
}
