#!/bin/bash
# Kept so an agent installed by an older version (it calls this path) keeps working; see kit/schedule.sh.
exec bash "$(dirname "$0")/kit/schedule.sh" "$@"
