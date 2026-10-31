#!/bin/sh

find_runtime_command_outside_shim() {
  runtime_name="$1"
  shim_directory="$2"
  previous_ifs="$IFS"
  IFS=:
  for path_entry in ${PATH:-}; do
    [ -n "$path_entry" ] || path_entry=.
    path_directory="$(CDPATH= cd -- "$path_entry" 2>/dev/null && pwd -P)" || continue
    [ "$path_directory" = "$shim_directory" ] && continue
    candidate="$path_directory/$runtime_name"
    if [ -x "$candidate" ]; then
      IFS="$previous_ifs"
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  IFS="$previous_ifs"
  return 1
}

resolve_runtime_command() {
  runtime_name="$1"
  configured_command="${2:-}"
  shim_directory="$3"
  if [ -n "$configured_command" ]; then
    case "$configured_command" in
      */*)
        configured_directory="${configured_command%/*}"
        configured_name="${configured_command##*/}"
        [ -n "$configured_directory" ] || configured_directory=/
        resolved_directory="$(CDPATH= cd -- "$configured_directory" 2>/dev/null && pwd -P)" || resolved_directory=""
        candidate="$resolved_directory/$configured_name"
        if [ -n "$resolved_directory" ] && [ "$candidate" != "$shim_directory/$runtime_name" ] && [ -x "$candidate" ]; then
          printf '%s\n' "$candidate"
          return 0
        fi
        ;;
    esac
  fi
  find_runtime_command_outside_shim "$runtime_name" "$shim_directory"
}
