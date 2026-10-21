#!/bin/sh
# Builds the Arrival Contract with contracts/build.sh and fails unless the wasm
# hash equals the testnet row of the deployments table in its README. That row
# is what anyone checking the deployed contract compares against, so a source
# change that alters the bytes must update it in the same commit, along with the
# copy in contracts/arrival/testdata that the budget tests run.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
readme="$root/contracts/arrival/README.md"

expected="$(grep -E '^\| testnet ' "$readme" | grep -oE '[0-9a-f]{64}' | head -n 1)"
if [ -z "$expected" ]; then
  echo "no testnet wasm sha256 found in $readme" >&2
  exit 1
fi

output="$("$root/contracts/build.sh")"
echo "$output"
actual="$(printf '%s\n' "$output" | tail -n 1 | cut -d ' ' -f 1)"

if [ "$actual" != "$expected" ]; then
  echo "arrival wasm sha256 is $actual, the README says $expected" >&2
  exit 1
fi
echo "arrival wasm matches the README: $actual"

# the budget tests run this copy, so it has to be the same build
tested="$(shasum -a 256 "$root/contracts/arrival/testdata/mavna_arrival.wasm" | cut -d ' ' -f 1)"
if [ "$tested" != "$expected" ]; then
  echo "contracts/arrival/testdata/mavna_arrival.wasm is $tested, the README says $expected" >&2
  exit 1
fi
echo "the wasm the tests run matches too"
