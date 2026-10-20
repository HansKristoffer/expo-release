#!/usr/bin/env bash
# Retarget only repo-backed services after the preview environment is duplicated.
set -euo pipefail

: "${RAILWAY_PROJECT_ID:?RAILWAY_PROJECT_ID is required}"
: "${RAILWAY_ENV:?RAILWAY_ENV is required}"
: "${HEAD_REF:?HEAD_REF is required}"

for attempt in 1 2 3 4 5 6; do
  # The CLI omits services while the duplicated configuration is still empty.
  # Read config, not deployment instances: new services need no deployment yet.
  config_json=$(railway environment config --json --environment "$RAILWAY_ENV")
  patch=$(printf '%s' "$config_json" | jq -ce --arg branch "$HEAD_REF" '
    if type != "object" then error("Expected Railway environment config object") else . end
    | .services
    | if . == null then {} elif type == "object" then . else error("Expected Railway services object") end
    | {
        services: (
          to_entries
          | map(
              select(.value.source.repo != null and .value.source.repo != "")
              | {key: .key, value: {source: {branch: $branch}}}
            )
          | from_entries
        )
      }
  ')
  count=$(printf '%s' "$patch" | jq '.services | length')
  if [ "$count" -gt 0 ]; then
    echo "Setting source.branch=$HEAD_REF on $count git-connected service(s)"
    # stdin JSON updates source.branch; keep the project and PR target explicit.
    printf '%s' "$patch" | railway environment edit \
      --project "$RAILWAY_PROJECT_ID" \
      --environment "$RAILWAY_ENV" \
      --json
    exit 0
  fi
  if [ "$attempt" -lt 6 ]; then
    echo "No git-connected services yet (attempt $attempt/6); retrying..."
    sleep 5
  fi
done

echo "::error::No git-connected services in $RAILWAY_ENV after 6 attempts" >&2
exit 1
