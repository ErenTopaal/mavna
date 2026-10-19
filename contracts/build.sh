#!/bin/sh
# Builds the Arrival Contract exactly as deployed and prints its sha256.
#
# The wasm records the CLI that built it (its `cliver` metadata), so any other
# stellar-cli version gives different bytes. This refuses to build with one.
# Set STELLAR to a stellar binary that is not first on PATH.
set -eu

REQUIRED="stellar 28.1.0 (c0f4d0da891bbf214c08b8c5035ae6db80e9a3bd)"
STELLAR="${STELLAR:-stellar}"

found="$("$STELLAR" --version | head -n 1)"
if [ "$found" != "$REQUIRED" ]; then
  echo "need $REQUIRED, found $found" >&2
  echo "install it with: cargo install --locked stellar-cli --version 28.1.0" >&2
  exit 1
fi

cd "$(dirname "$0")"
rm -f target/wasm32v1-none/release/mavna_arrival.wasm
"$STELLAR" contract build --package mavna-arrival
shasum -a 256 target/wasm32v1-none/release/mavna_arrival.wasm
