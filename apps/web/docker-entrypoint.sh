#!/bin/sh
# Builds the upstream URL, then hands off to the nginx image entrypoint
# so ${PORT} and ${API_UPSTREAM} are substituted into the server template.
set -eu

port="${PORT:-80}"
upstream="${API_UPSTREAM:-}"

if [ -z "$upstream" ]; then
  if [ -n "${API_HOST:-}" ] && [ -n "${API_PORT:-}" ]; then
    upstream="http://${API_HOST}:${API_PORT}"
  else
    upstream="http://api:3001"
  fi
fi

case "$upstream" in
  */) ;;
  *) upstream="${upstream}/" ;;
esac

export PORT="$port"
export API_UPSTREAM="$upstream"

exec /docker-entrypoint.sh "$@"
