#!/usr/bin/env bash
# Sign the Windows mini.exe using osslsigncode.
#
# - If build/winsign.pfx exists, it is used (password from env WIN_PFX_PASS,
#   default empty).
# - Otherwise a self-signed code-signing cert is generated on the fly and
#   stored at build/winsign.pfx (password: "mini"). A self-signed cert
#   does NOT pass Windows SmartScreen — to ship without warnings you need
#   a real EV/OV certificate from a CA. This is "ad-hoc" parity with the
#   macOS sign so the binary at least carries an Authenticode signature.
#
# Usage: scripts/sign-win.sh <packaged-dir> <zip-path>
#   packaged-dir : e.g. dist/mini-win32-x64
#   zip-path     : e.g. dist/mini-0.2.3-win32-x64.zip

set -euo pipefail

PACKAGED_DIR=${1:?packaged dir required}
ZIP_PATH=${2:?zip path required}
EXE_PATH="${PACKAGED_DIR}/mini.exe"

if [[ ! -f "${EXE_PATH}" ]]; then
  echo "sign-win: ${EXE_PATH} not found" >&2
  exit 1
fi

PFX_PATH=${WIN_PFX_PATH:-build/winsign.pfx}
PFX_PASS=${WIN_PFX_PASS:-mini}

if [[ ! -f "${PFX_PATH}" ]]; then
  echo "sign-win: no cert at ${PFX_PATH}, generating self-signed"
  TMP=$(mktemp -d)
  trap 'rm -rf "${TMP}"' EXIT
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "${TMP}/key.pem" -out "${TMP}/cert.pem" \
    -days 3650 \
    -subj "/CN=mini ad-hoc/O=mini/C=ES" \
    -addext "extendedKeyUsage=codeSigning" 2>/dev/null
  openssl pkcs12 -export \
    -inkey "${TMP}/key.pem" -in "${TMP}/cert.pem" \
    -out "${PFX_PATH}" -password "pass:${PFX_PASS}"
  echo "sign-win: cert stored at ${PFX_PATH} (password: ${PFX_PASS})"
fi

SIGNED_TMP="${EXE_PATH}.signed"
echo "sign-win: signing ${EXE_PATH}"
osslsigncode sign \
  -pkcs12 "${PFX_PATH}" -pass "${PFX_PASS}" \
  -h sha256 \
  -n "mini" \
  -i "https://github.com/jlopezbsa/mini" \
  -in "${EXE_PATH}" \
  -out "${SIGNED_TMP}"
mv "${SIGNED_TMP}" "${EXE_PATH}"

echo "sign-win: verifying"
osslsigncode verify "${EXE_PATH}" || true

PARENT_DIR=$(dirname "${PACKAGED_DIR}")
BASE=$(basename "${PACKAGED_DIR}")
echo "sign-win: zipping -> ${ZIP_PATH}"
rm -f "${ZIP_PATH}"
( cd "${PARENT_DIR}" && zip -r -q "$(basename "${ZIP_PATH}")" "${BASE}" )
mv "${PARENT_DIR}/$(basename "${ZIP_PATH}")" "${ZIP_PATH}"

echo "sign-win: writing checksum"
( cd "$(dirname "${ZIP_PATH}")" && shasum -a 256 "$(basename "${ZIP_PATH}")" > "$(basename "${ZIP_PATH}").sha256" )

echo "sign-win: done"
