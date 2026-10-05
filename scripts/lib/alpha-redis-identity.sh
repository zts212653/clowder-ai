#!/usr/bin/env bash

# Alpha owns one Redis instance. A PING on its port does not prove the server
# belongs to this checkout; compare its actual persistence directory as well.
assert_alpha_redis_isolated() {
  if ! [[ "$ALPHA_REDIS_PORT" =~ ^[0-9]+$ ]] || [ "$ALPHA_REDIS_PORT" -lt 1024 ] || [ "$ALPHA_REDIS_PORT" -gt 65535 ]; then
    die "invalid Alpha Redis port: $ALPHA_REDIS_PORT"
  fi
  case "$ALPHA_REDIS_PORT" in
    6099|6398|6399|6401) die "shared Redis port $ALPHA_REDIS_PORT is not an Alpha target" ;;
  esac

  local expected_dir actual_dir raw_dir
  [ ! -L "$REDIS_DATA_DIR" ] && [ ! -L "$ALPHA_DIR/.cat-cafe" ] \
    || die "Alpha Redis data directory must not be a symlink"
  expected_dir="$(cd "$ALPHA_DIR" && pwd -P)/.cat-cafe/redis"
  if [ -e "$REDIS_DATA_DIR" ] && [ ! -d "$REDIS_DATA_DIR" ]; then
    die "Alpha Redis data directory is not a directory: $REDIS_DATA_DIR"
  fi
  if redis-cli -h 127.0.0.1 -p "$ALPHA_REDIS_PORT" ping >/dev/null 2>&1; then
    raw_dir="$(redis-cli -h 127.0.0.1 -p "$ALPHA_REDIS_PORT" --raw config get dir 2>/dev/null)" \
      || die "cannot verify Alpha Redis data directory on port $ALPHA_REDIS_PORT"
    actual_dir="$(printf '%s\n' "$raw_dir" | sed -n '2p' | tr -d '\r')"
    [ -n "$actual_dir" ] && [ -d "$actual_dir" ] \
      || die "cannot verify Alpha Redis data directory on port $ALPHA_REDIS_PORT"
    actual_dir="$(cd "$actual_dir" && pwd -P)"
    [ "$actual_dir" = "$expected_dir" ] \
      || die "Redis data directory mismatch on port $ALPHA_REDIS_PORT: expected $expected_dir, found $actual_dir"
  elif command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$ALPHA_REDIS_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    die "port $ALPHA_REDIS_PORT is occupied by an unverified service"
  fi
}

assert_alpha_redis_seeded() {
  [ "$ALPHA_REDIS_PORT" = "6397" ] || return 0
  [ -s "$REDIS_DATA_DIR/dump.rdb" ] && return 0
  [ -s "$REDIS_DATA_DIR/appendonlydir/appendonly.aof.manifest" ] && return 0
  [ -s "$REDIS_DATA_DIR/appendonly.aof" ] && return 0
  [ "$ALPHA_EMPTY_REDIS_ALLOWED" = "true" ] && return 0

  # A fresh install may start empty. An existing shared 6398 database must be
  # migrated explicitly, so switching ports never looks like lost Alpha data.
  if redis-cli -h 127.0.0.1 -p 6398 ping >/dev/null 2>&1; then
    local legacy_size
    legacy_size="$(redis-cli -h 127.0.0.1 -p 6398 dbsize 2>/dev/null)" \
      || die "cannot verify legacy 6398 data before Alpha startup"
    [[ "$legacy_size" =~ ^[0-9]+$ ]] \
      || die "cannot verify legacy 6398 data before Alpha startup"
    [ "$legacy_size" -eq 0 ] \
      || die "Alpha Redis migration required: 6398 has $legacy_size keys; seed the dedicated directory or pass --allow-empty-redis explicitly"
  else
    # The old instance may be stopped while its durable data still exists.
    # Never infer "fresh install" from a failed PING alone.
    local legacy_dir="$HOME/.cat-cafe/redis-worktree-6398"
    if [ -s "$legacy_dir/dump.rdb" ] \
      || [ -s "$legacy_dir/appendonlydir/appendonly.aof.manifest" ] \
      || [ -s "$legacy_dir/appendonly.aof" ]; then
      die "Alpha Redis migration required: offline 6398 data exists at $legacy_dir; seed the dedicated directory or pass --allow-empty-redis explicitly"
    fi
  fi
}
