#!/bin/zsh
# Wraps the web extension in a macOS app, signs it with your Apple Development
# certificate (so Safari keeps it enabled without "Allow unsigned extensions"),
# builds it, and opens it once so Safari registers the extension.
set -euo pipefail
cd "$(dirname "$0")"

# Team ID: taken from the first Apple Development certificate in your keychain unless TEAM is set.
if [[ -z "${TEAM:-}" ]]; then
  TEAM="$(security find-certificate -c "Apple Development" -p 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null | sed -n 's/.*OU *= *\([A-Z0-9]\{10\}\).*/\1/p')"
fi
if [[ -z "$TEAM" ]]; then
  echo "No Apple Development certificate found. Sign in to Xcode with your Apple ID (Settings → Accounts)," >&2
  echo "or run: TEAM=<your team ID> ./build.sh" >&2
  exit 1
fi
BUNDLE_ID="${BUNDLE_ID:-com.hoverlens.HoverLens}"

if [[ ! -d App/HoverLens ]]; then
  xcrun safari-web-extension-converter Extension \
    --project-location App --app-name HoverLens --bundle-identifier "$BUNDLE_ID" \
    --macos-only --no-open --no-prompt --force
fi

xcodebuild -project App/HoverLens/HoverLens.xcodeproj -scheme HoverLens -configuration Release \
  -derivedDataPath build DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates -quiet build

APP=build/Build/Products/Release/HoverLens.app
rm -rf ~/Applications/HoverLens.app
mkdir -p ~/Applications
cp -R "$APP" ~/Applications/
open ~/Applications/HoverLens.app
echo "Built and installed ~/Applications/HoverLens.app"
echo "Now enable it in Safari → Settings → Extensions, and allow it on all websites."
