#!/usr/bin/env bash
# Usage: verify-image-arch.sh <image-ref> [os/arch]
# Verifies from the registry that an image provides the expected platform (default linux/arm64).
# Works for single-platform manifests and for image indexes: the human-readable
# `imagetools inspect` output has no "Platform:" line for a single manifest, so the structured
# image configuration (os/architecture) is inspected instead.
set -euo pipefail

image="${1:?usage: verify-image-arch.sh <image-ref> [os/arch]}"
expected="${2:-linux/arm64}"

if ! config="$(docker buildx imagetools inspect --format '{{json .Image}}' "$image")"; then
  echo "::error::Could not inspect image '$image' in the registry" >&2
  exit 1
fi

# Single manifest: .Image is the image config. Index: .Image maps platform -> image config.
if ! platforms="$(printf '%s' "$config" | jq -c '
      (if type == "object" then (if has("architecture") then [.] else [.[]] end) else [] end)
      | map(select(type == "object") | "\(.os)/\(.architecture)")')"; then
  echo "::error::Unexpected image configuration output for '$image'" >&2
  exit 1
fi

if ! printf '%s' "$platforms" | jq -e --arg want "$expected" 'index($want) != null' >/dev/null; then
  echo "::error::Image '$image' does not provide $expected (found: $platforms)" >&2
  exit 1
fi
echo "Verified $image provides $expected (found: $platforms)"
