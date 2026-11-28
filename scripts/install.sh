#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="meharajM/ai-worker-desktop"
API_URL="https://api.github.com/repos/${REPOSITORY}/releases?per_page=100"
DOWNLOAD_ROOT="https://github.com/${REPOSITORY}/releases/download"

say_error() {
  printf 'AI-Worker installer: %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || say_error "curl is required."

case "$(uname -s)" in
  Darwin)
    platform_key="macos"
    case "$(uname -m)" in
      arm64|aarch64) architecture_key="arm64" ;;
      x86_64) architecture_key="x64" ;;
      *) say_error "This Mac architecture is not supported yet: $(uname -m)" ;;
    esac
    ;;
  Linux)
    platform_key="linux"
    case "$(uname -m)" in
      x86_64|amd64) architecture_key="x64" ;;
      aarch64|arm64) architecture_key="arm64" ;;
      *) say_error "This Linux architecture is not supported yet: $(uname -m)" ;;
    esac
    ;;
  *) say_error "This installer supports macOS and Linux. On Windows, run scripts/install.ps1 from PowerShell." ;;
esac

release_json="$(curl -fsSL -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' "$API_URL")" \
  || say_error "Could not reach the GitHub release service. Check your connection and retry."
release_tag="$(printf '%s\n' "$release_json" | awk -F'"' '/"tag_name": "tauri-v/ { print $4; exit }')"
[ -n "$release_tag" ] || say_error "No published Tauri installer release was found yet."

temporary_dir="$(mktemp -d)"
mountpoint="${temporary_dir}/dmg"
mkdir -p "$mountpoint"
mounted=0
app_path=""
staged_app=""
backup_app=""
cleanup() {
  if [ "$mounted" -eq 1 ]; then hdiutil detach "$mountpoint" -quiet >/dev/null 2>&1 || true; fi
  if [ -n "$staged_app" ] && [ -e "$staged_app" ]; then rm -rf "$staged_app"; fi
  if [ -n "$backup_app" ] && [ -n "$app_path" ] && [ -e "$backup_app" ] && [ ! -e "$app_path" ]; then
    mv "$backup_app" "$app_path" || true
  fi
  rm -rf "$temporary_dir"
}
trap cleanup EXIT

manifest_path="${temporary_dir}/install-manifest.txt"
manifest_url="${DOWNLOAD_ROOT}/${release_tag}/install-manifest.txt"
curl -fsSL "$manifest_url" -o "$manifest_path" || say_error "The latest installer manifest could not be downloaded."
asset_key="${platform_key}-${architecture_key}"
asset_name="$(awk -F= -v key="$asset_key" '$1 == key { print substr($0, index($0, "=") + 1); exit }' "$manifest_path")"
[ -n "$asset_name" ] || say_error "No installer is published for ${asset_key}."
case "$asset_name" in
  *[!A-Za-z0-9._-]*|*/*) say_error "The release contains an invalid installer filename." ;;
esac

asset_path="${temporary_dir}/${asset_name}"
checksum_path="${asset_path}.sha256"
asset_url="${DOWNLOAD_ROOT}/${release_tag}/${asset_name}"
curl -fL --progress-bar "$asset_url" -o "$asset_path" || say_error "Could not download ${asset_name}."
curl -fsSL "${asset_url}.sha256" -o "$checksum_path" || say_error "Could not download the installer checksum."
expected_sha="$(awk '{ print $1; exit }' "$checksum_path")"
if command -v sha256sum >/dev/null 2>&1; then
  actual_sha="$(sha256sum "$asset_path" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual_sha="$(shasum -a 256 "$asset_path" | awk '{ print $1 }')"
else
  say_error "A SHA-256 utility (sha256sum or shasum) is required to verify the download."
fi
[ -n "$expected_sha" ] && [ "$actual_sha" = "$expected_sha" ] || say_error "The installer checksum did not match. The download was not installed."

if [ "$platform_key" = "macos" ]; then
  command -v hdiutil >/dev/null 2>&1 || say_error "hdiutil is required to install the macOS disk image."
  hdiutil attach -nobrowse -readonly -mountpoint "$mountpoint" "$asset_path" >/dev/null \
    || say_error "Could not open the downloaded disk image."
  mounted=1
  source_app="$(find "$mountpoint" -name 'AI-Worker.app' -print -quit)"
  [ -n "$source_app" ] || say_error "The disk image did not contain AI-Worker.app."

  if [ -w /Applications ]; then
    install_dir="/Applications"
  else
    install_dir="${HOME}/Applications"
  fi
  mkdir -p "$install_dir"
  app_path="${install_dir}/AI-Worker.app"
  staged_app="${install_dir}/.AI-Worker.app.installing.$$"
  backup_app="${install_dir}/.AI-Worker.app.previous.$$"
  if [ -e "$staged_app" ] || [ -e "$backup_app" ]; then
    say_error "An incomplete install transaction already exists for this process. Resolve it before retrying."
  fi
  osascript -e 'tell application "AI-Worker" to quit' >/dev/null 2>&1 || true
  ditto "$source_app" "$staged_app" || say_error "Could not copy AI-Worker into ${install_dir}."
  if [ -e "$app_path" ]; then mv "$app_path" "$backup_app"; fi
  if mv "$staged_app" "$app_path"; then
    rm -rf "$backup_app"
  else
    [ ! -e "$backup_app" ] || mv "$backup_app" "$app_path"
    say_error "Could not finish installing AI-Worker."
  fi
  printf 'AI-Worker was installed to %s\n' "$app_path"
  open "$app_path" || printf 'Open AI-Worker from your Applications folder.\n'
else
  install_dir="${HOME}/.local/bin"
  mkdir -p "$install_dir"
  app_path="${install_dir}/AI-Worker.AppImage"
  cp "$asset_path" "$app_path"
  chmod 755 "$app_path"
  ln -sfn "$app_path" "${install_dir}/ai-worker"
  printf 'AI-Worker was installed to %s\n' "$app_path"
  nohup "$app_path" >/dev/null 2>&1 </dev/null &
fi
