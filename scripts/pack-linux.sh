#!/usr/bin/env bash
# Bundle a Linux electron-packager output into a tar.gz and emit a
# SHA256SUMS file alongside. Linux distros don't have a single
# code-signing path, so integrity is provided via the checksum file.
#
# Usage: scripts/pack-linux.sh <packaged-dir> <tar-path>
#   packaged-dir : e.g. dist/mini-linux-x64
#   tar-path     : e.g. dist/mini-0.2.3-linux-x64.tar.gz

set -euo pipefail

PACKAGED_DIR=${1:?packaged dir required}
TAR_PATH=${2:?tar path required}

if [[ ! -d "${PACKAGED_DIR}" ]]; then
  echo "pack-linux: ${PACKAGED_DIR} not found" >&2
  exit 1
fi

PARENT_DIR=$(dirname "${PACKAGED_DIR}")
BASE=$(basename "${PACKAGED_DIR}")

# Make the binary executable just in case (it should already be).
chmod +x "${PACKAGED_DIR}/mini" || true

echo "pack-linux: tarring -> ${TAR_PATH}"
rm -f "${TAR_PATH}"
( cd "${PARENT_DIR}" && tar -czf "$(basename "${TAR_PATH}")" "${BASE}" )
mv "${PARENT_DIR}/$(basename "${TAR_PATH}")" "${TAR_PATH}"

echo "pack-linux: writing checksum"
( cd "$(dirname "${TAR_PATH}")" && shasum -a 256 "$(basename "${TAR_PATH}")" > "$(basename "${TAR_PATH}").sha256" )

echo "pack-linux: done"
