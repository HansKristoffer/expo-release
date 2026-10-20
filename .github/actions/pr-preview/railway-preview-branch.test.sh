#!/usr/bin/env bash
# Offline regression tests; all Railway calls and retry sleeps are stubbed.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
export fixture_dir
export RAILWAY_PROJECT_ID=preview-project RAILWAY_ENV=pr-72
export HEAD_REF='feature/quotes-"-and-$literal'

railway() {
  if [[ "$*" == "environment config --json --environment pr-72" ]]; then
    local count
    count=$(cat "$fixture_dir/count")
    count=$((count + 1))
    printf '%s' "$count" > "$fixture_dir/count"
    if [[ -f "$fixture_dir/request-fails" ]]; then return 9; fi
    jq --argjson index "$((count - 1))" '.[$index] // .[-1]' "$fixture_dir/configs"
  elif [[ "$*" == "environment edit --project preview-project --environment pr-72 --json" ]]; then
    cat > "$fixture_dir/patch"
  else
    echo "Unexpected Railway command: $*" >&2
    return 1
  fi
}
sleep() { :; }
export -f railway sleep

run_case() {
  local configs="$1" expected_exit="$2" expected_requests="$3" actual_exit=0
  printf '%s' "$configs" > "$fixture_dir/configs"
  printf 0 > "$fixture_dir/count"
  rm -f "$fixture_dir/patch"
  bash "$script_dir/railway-preview-branch.sh" > "$fixture_dir/log" 2>&1 || actual_exit=$?
  if [[ "$actual_exit" -ne "$expected_exit" || "$(cat "$fixture_dir/count")" -ne "$expected_requests" ]]; then
    cat "$fixture_dir/log" >&2
    echo "Unexpected exit/request count: $actual_exit / $(cat "$fixture_dir/count")" >&2
    exit 1
  fi
  if [[ "$expected_exit" -ne 0 && -f "$fixture_dir/patch" ]]; then
    echo 'Failure must not edit the environment' >&2
    exit 1
  fi
}

# Delayed duplication: absent services, null services, then two repo-backed
# services mixed with an image service and a source without a repo.
run_case '[
  {"privateNetworkDisabled":false},
  {"services":null},
  {"services":{
    "api":{"source":{"repo":"team/app","branch":"staging"}},
    "worker":{"source":{"repo":"team/app","branch":"staging"}},
    "redis":{"source":{"image":"redis:7"}},
    "empty":{"source":{"repo":""}}
  }}
]' 0 3
jq -e --arg branch "$HEAD_REF" '. == {
  services: {
    api: {source: {branch: $branch}},
    worker: {source: {branch: $branch}}
  }
}' "$fixture_dir/patch" > /dev/null

run_case '[{}]' 1 6
run_case '[{"services":{"redis":{"source":{"image":"redis:7"}}}}]' 1 6
run_case '[{"services":[]}]' 5 1
run_case '[{"services":false}]' 5 1
run_case '["unexpected envelope"]' 5 1
touch "$fixture_dir/request-fails"
run_case '[{}]' 9 1

echo 'Railway preview branch tests passed (7 cases).'
