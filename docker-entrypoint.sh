#!/bin/sh
set -eu
mkdir -p "${DATA_DIR:-/data}"
chown app:app "${DATA_DIR:-/data}"
exec setpriv --reuid=app --regid=app --init-groups "$@"
