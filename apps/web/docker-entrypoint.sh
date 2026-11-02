#!/bin/sh
# Splits the API origin into host and port, picks a DNS resolver, then hands
# off to the nginx image entrypoint so the server template can re-resolve the
# API on each request. See nginx.conf.template.
set -eu

port="${PORT:-80}"
scheme="http"
host=""
api_port=""

if [ -n "${API_UPSTREAM:-}" ]; then
  upstream="${API_UPSTREAM%/}"
  case "$upstream" in
    https://*)
      scheme="https"
      upstream="${upstream#https://}"
      ;;
    http://*)
      scheme="http"
      upstream="${upstream#http://}"
      ;;
    *)
      echo "API_UPSTREAM must start with http:// or https://" >&2
      exit 1
      ;;
  esac
  case "$upstream" in
    */*)
      echo "API_UPSTREAM must be an origin (http://host:port), not a path" >&2
      exit 1
      ;;
  esac
  upstream="${upstream##*@}"
  case "$upstream" in
    *:*)
      host="${upstream%%:*}"
      api_port="${upstream##*:}"
      ;;
    *)
      host="$upstream"
      if [ "$scheme" = "https" ]; then
        api_port="443"
      else
        api_port="80"
      fi
      ;;
  esac
elif [ -n "${API_HOST:-}" ] && [ -n "${API_PORT:-}" ]; then
  host="$API_HOST"
  api_port="$API_PORT"
  scheme="${API_SCHEME:-http}"
else
  host="api"
  api_port="3001"
  scheme="http"
fi

if [ -z "$host" ] || [ -z "$api_port" ]; then
  echo "API host and port are required" >&2
  exit 1
fi

resolver="${NGINX_RESOLVER:-}"
if [ -z "$resolver" ]; then
  resolver=$(awk '
    /^nameserver[[:space:]]+/ {
      ns = $2
      if (ns ~ /:/) printf "[%s] ", ns
      else printf "%s ", ns
    }
  ' /etc/resolv.conf)
  resolver=$(printf '%s' "$resolver" | sed 's/[[:space:]]*$//')
fi
if [ -z "$resolver" ]; then
  resolver="127.0.0.11"
fi

export PORT="$port"
export API_HOST="$host"
export API_PORT="$api_port"
export API_SCHEME="$scheme"
export NGINX_RESOLVER="$resolver"

if [ "${HEARTH_ENTRYPOINT_DRY_RUN:-}" = "1" ]; then
  printf 'PORT=%s\nAPI_SCHEME=%s\nAPI_HOST=%s\nAPI_PORT=%s\nNGINX_RESOLVER=%s\n' \
    "$PORT" "$API_SCHEME" "$API_HOST" "$API_PORT" "$NGINX_RESOLVER"
  exit 0
fi

exec /docker-entrypoint.sh "$@"
