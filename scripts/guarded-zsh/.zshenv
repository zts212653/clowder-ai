if [[ -n "${CAT_CAFE_NATIVE_TOOL_HOME:-}" ]]; then
  # Native OAuth/Keychain belongs to the carrier process. Its command tools use
  # the host home, including tools with no XDG or per-tool config override.
  if [[ "${HOME:-}/.gemini" == "${GEMINI_HOME:-}" ]]; then
    export HOME="$CAT_CAFE_NATIVE_TOOL_HOME"
  fi
  # Only the carrier-to-tool transition owns this handoff. Descendant shells
  # must respect explicit HOME overrides used by tests and nested accounts.
  unset CAT_CAFE_NATIVE_TOOL_HOME
fi
original_zdotdir="${CAT_CAFE_ORIGINAL_ZDOTDIR:-}"
if [[ -n "$original_zdotdir" && "$original_zdotdir" != "$ZDOTDIR" && -r "$original_zdotdir/.zshenv" ]]; then
  guarded_zdotdir="$ZDOTDIR"
  export ZDOTDIR="$original_zdotdir"
  source "$original_zdotdir/.zshenv"
  export ZDOTDIR="$guarded_zdotdir"
fi
if [[ -n "${CAT_CAFE_VERDICT_GH_GUARD_BIN:-}" ]]; then
  export PATH="$CAT_CAFE_VERDICT_GH_GUARD_BIN:${PATH:-}"
fi
if [[ "${CAT_CAFE_NATIVE_NONINTERACTIVE_GIT:-}" == "1" ]]; then
  export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never GIT_ASKPASS=false
fi
