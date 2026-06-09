#!/bin/sh
set -e

for script in /app/docker-entrypoint.d/*.envsh /app/docker-entrypoint.d/*.sh; do
    [ -f "$script" ] || continue
    . "$script"
done

exec node /app/server/image-task-server.mjs
