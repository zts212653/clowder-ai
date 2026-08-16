original_zdotdir="${CAT_CAFE_ORIGINAL_ZDOTDIR:-}"
if [[ -n "$original_zdotdir" && "$original_zdotdir" != "$ZDOTDIR" && -r "$original_zdotdir/.zlogin" ]]; then
  guarded_zdotdir="$ZDOTDIR"
  export ZDOTDIR="$original_zdotdir"
  source "$original_zdotdir/.zlogin"
  export ZDOTDIR="$guarded_zdotdir"
fi
if [[ -n "${CAT_CAFE_VERDICT_GH_GUARD_BIN:-}" ]]; then
  export PATH="$CAT_CAFE_VERDICT_GH_GUARD_BIN:${PATH:-}"
fi
