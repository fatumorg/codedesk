#!/usr/bin/env bash
[ -n "$FAKE_ARGS" ] && printf '%s\n' "$@" > "$FAKE_ARGS"
[ -n "$FAKE_ENV" ] && env > "$FAKE_ENV"
if [ "$FAKE_MODE" = exit ]; then echo boom >&2; exit 1; fi
while IFS= read -r line; do
  rid=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
  case "$line" in
    *'"type":"control_response"'*) printf '%s\n' "$line" >> "$FAKE_OUT"; echo '{"type":"result","subtype":"success"}' ;;
    *'"subtype":"initialize"'*) printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"commands":[{"name":"compact"}],"models":[{"value":"opus"}],"agents":[],"account":{"email":"a@b"}}}}\n' "$rid" ;;
    *'"subtype":"get_context_usage"'*) printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"percentage":12}}}\n' "$rid" ;;
    *'"subtype":"get_usage"'*) printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"rate_limits":{"five_hour":{"utilization":50}}}}}\n' "$rid" ;;
    *'"subtype":"set_model"'*) printf '{"type":"control_response","response":{"subtype":"error","request_id":"%s","error":"no such model"}}\n' "$rid" ;;
    *'"type":"user"'*)
      echo '{"type":"system","subtype":"init","session_id":"S1","permissionMode":"default"}'
      echo '{"type":"control_request","request_id":"perm1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"tu1","permission_suggestions":[],"title":"Run ls"}}' ;;
  esac
done
printf 'EOF\n' >> "${FAKE_OUT:-/dev/null}"
