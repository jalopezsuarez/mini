#!/usr/bin/env bash
# Deep ad-hoc sign an Electron .app bundle and produce a notarization-friendly
# zip with ditto. Without this step, macOS Gatekeeper greets users with
# `"mini" is damaged and can't be opened.` after they download the zip,
# because electron-packager only leaves the linker's auto-signature on each
# Mach-O — the bundle structure itself stays unsigned.
#
# Usage: scripts/sign-mac.sh <packaged-dir> <zip-path>
#   packaged-dir : e.g. dist/mini-darwin-arm64
#   zip-path     : e.g. dist/mini-0.2.0-arm64.zip

set -euo pipefail

PACKAGED_DIR=${1:?packaged dir required}
ZIP_PATH=${2:?zip path required}
APP_PATH="${PACKAGED_DIR}/mini.app"

if [[ ! -d "${APP_PATH}" ]]; then
  echo "sign-mac: ${APP_PATH} not found" >&2
  exit 1
fi

# Strip any quarantine xattrs left over from previous runs.
xattr -cr "${APP_PATH}"

# Sign bottom-up: dylibs and nested helper apps first, then frameworks,
# then the outer bundle. codesign --deep is too aggressive for Electron's
# layout, so we walk it explicitly.
SIGN_ID="-"

echo "sign-mac: signing dylibs"
find "${APP_PATH}" -type f \( -name '*.dylib' -o -name '*.so' \) -print0 \
  | xargs -0 -I{} codesign --force --sign "${SIGN_ID}" --timestamp=none "{}"

echo "sign-mac: signing nested framework helper executables"
# Frameworks like Electron Framework ship extra Mach-O binaries under
# Versions/<v>/Helpers (e.g. chrome_crashpad_handler) that need to be signed
# before the framework itself is sealed.
find "${APP_PATH}" -type f -path '*.framework/Versions/*/Helpers/*' -perm -u+x -print0 \
  | xargs -0 -I{} codesign --force --sign "${SIGN_ID}" --timestamp=none "{}"

echo "sign-mac: signing helper apps"
for helper in "${APP_PATH}/Contents/Frameworks/"*.app; do
  [[ -d "${helper}" ]] || continue
  codesign --force --sign "${SIGN_ID}" --timestamp=none "${helper}"
done

echo "sign-mac: signing frameworks"
for fw in "${APP_PATH}/Contents/Frameworks/"*.framework; do
  [[ -d "${fw}" ]] || continue
  codesign --force --sign "${SIGN_ID}" --timestamp=none "${fw}"
done

echo "sign-mac: signing main bundle"
codesign --force --sign "${SIGN_ID}" --timestamp=none "${APP_PATH}"

echo "sign-mac: verifying"
codesign --verify --strict --verbose=2 "${APP_PATH}"

echo "sign-mac: zipping with ditto -> ${ZIP_PATH}"
rm -f "${ZIP_PATH}"
ditto -c -k --sequesterRsrc --keepParent "${APP_PATH}" "${ZIP_PATH}"

echo "sign-mac: done"
