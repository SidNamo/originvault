#!/bin/sh
set -eu

if [ "$(id -u)" -eq 0 ]; then
  data_root="${DATA_ROOT:-/data/files}"
  log_dir="${LOG_DIR:-/data/logs}"

  mkdir -p "$data_root" "$log_dir"
  chown node:node "$data_root"
  chown -R node:node "$log_dir"

  exec su-exec node:node "$@"
fi

exec "$@"
