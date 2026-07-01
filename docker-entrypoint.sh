#!/bin/sh
# A mounted named volume / bind mount can be root-owned, which the unprivileged
# 'app' user cannot write — breaking the audio cache, the station snapshot, and
# the device registry (all under CACHE_DIR). Run as root just long enough to make
# the cache writable, then drop privileges.
set -e
CACHE_DIR="${CACHE_DIR:-/data/cache}"
mkdir -p "$CACHE_DIR"
chown -R app:app "$CACHE_DIR" 2>/dev/null || true
exec gosu app "$@"
