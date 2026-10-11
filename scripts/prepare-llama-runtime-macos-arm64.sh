#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE_URL="https://github.com/ggml-org/llama.cpp/releases/download/b11429/llama-b11429-bin-macos-arm64.tar.gz"
ARCHIVE_SHA256="740288ec6887be94280a5dfa25b5e23a78285cab104519e6c7e218904ee82459"
CACHE="$ROOT/src-tauri/target/llama-b11429-bin-macos-arm64.tar.gz"
DEST="$ROOT/src-tauri/resources/llama-v0.6.0"

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "This runtime preparer supports macOS arm64 only." >&2
  exit 1
fi

archive="${1:-$CACHE}"
if [[ ! -f "$archive" ]]; then
  if [[ "$archive" != "$CACHE" ]]; then
    echo "Archive not found: $archive" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$CACHE")"
  download="$CACHE.part.$$"
  trap 'rm -f "$download"' EXIT
  curl --fail --location --retry 3 "$ARCHIVE_URL" --output "$download"
  archive="$download"
fi

sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
verify_hash() {
  local file="$1" expected="$2" actual
  actual="$(sha256 "$file")"
  if [[ "$actual" != "$expected" ]]; then
    echo "SHA-256 mismatch for $(basename "$file"): $actual" >&2
    exit 1
  fi
}

verify_hash "$archive" "$ARCHIVE_SHA256"
if [[ "$archive" == *.part.* ]]; then
  mv "$archive" "$CACHE"
  archive="$CACHE"
  trap - EXIT
fi

mkdir -p "$ROOT/src-tauri/target"
tmp="$(mktemp -d "$ROOT/src-tauri/target/llama-stage.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

stage() {
  local name="$1" expected="$2" output="$tmp/bin/$1"
  tar -xOzf "$archive" "llama-b11429/$name" > "$output"
  verify_hash "$output" "$expected"
  if [[ "$name" == llama-server ]]; then chmod 755 "$output"; else chmod 644 "$output"; fi
}

stage llama-server 1bf5602a2be50097c44282a6ecc63234d94ee8f96d39fd45fed6eff4e74b6b41
stage libllama-common.0.6.0.dylib febeef087a261b0eb4eeee09b43239b6bf0863c58ad1dc30d0b610ef4308a411
stage libllama.0.6.0.dylib c5da330c56d4627d18714188350c14150a84237e38c1e6fd5f1d25997afd1046
stage libmtmd.0.6.0.dylib 2de2c7d40b72dc5fa14aed03cb8d7521ec5ab262bbb6038d6110666f3852232b
stage libggml-blas.0.26.0.dylib 6526259e8f70a5b3a394df3ba082050c290d7653846efbdc84b3710b22fb4eac
stage libllama-server-impl.dylib 8bd39e3755fe1e6b5f08736e131cb94eb741a7f64ca4ab2a10725ea4ea3e6815
stage libggml-metal.0.26.0.dylib 3b0e401627c00dc2843c0cdae08bd73639c21cdf97c64290dd88dd827c976045
stage libggml-cpu.0.26.0.dylib 75d7c5c73bad915b536d402eae361163f69c124762fdfdd9e1d2c4bd1b4adc04
stage libggml.0.26.0.dylib 85ac40d540a5cc86f28a70270ddcdde677e92eb585c3bacd1b7e82270fe8934b
stage libggml-base.0.26.0.dylib 4d483957511852e398564fe248da19e9c6b2f81ba668e4591ee4c29bccfbacdc
stage libggml-rpc.0.26.0.dylib 5a75e884d5feff030067ed7867925366c552c68f1b36653f03bc2b0bd87e8a56
# llama.cpp loads these stable ABI names while the archive ships versioned payload files.
ln -s libllama-common.0.6.0.dylib "$tmp/bin/libllama-common.0.dylib"
ln -s libllama.0.6.0.dylib "$tmp/bin/libllama.0.dylib"
ln -s libmtmd.0.6.0.dylib "$tmp/bin/libmtmd.0.dylib"
ln -s libggml-blas.0.26.0.dylib "$tmp/bin/libggml-blas.0.dylib"
ln -s libggml-metal.0.26.0.dylib "$tmp/bin/libggml-metal.0.dylib"
ln -s libggml-cpu.0.26.0.dylib "$tmp/bin/libggml-cpu.0.dylib"
ln -s libggml.0.26.0.dylib "$tmp/bin/libggml.0.dylib"
ln -s libggml-base.0.26.0.dylib "$tmp/bin/libggml-base.0.dylib"
ln -s libggml-rpc.0.26.0.dylib "$tmp/bin/libggml-rpc.0.dylib"
for mapping in \
  libllama-common.0.dylib:libllama-common.0.6.0.dylib \
  libllama.0.dylib:libllama.0.6.0.dylib \
  libmtmd.0.dylib:libmtmd.0.6.0.dylib \
  libggml-blas.0.dylib:libggml-blas.0.26.0.dylib \
  libggml-metal.0.dylib:libggml-metal.0.26.0.dylib \
  libggml-cpu.0.dylib:libggml-cpu.0.26.0.dylib \
  libggml.0.dylib:libggml.0.26.0.dylib \
  libggml-base.0.dylib:libggml-base.0.26.0.dylib \
  libggml-rpc.0.dylib:libggml-rpc.0.26.0.dylib; do
  IFS=: read -r link target <<< "$mapping"
  [[ -L "$tmp/bin/$link" && "$(readlink "$tmp/bin/$link")" == "$target" ]]
done
tar -xOzf "$archive" llama-b11429/LICENSE > "$tmp/LICENSE"
verify_hash "$tmp/LICENSE" 94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d
grep -q 'MIT License' "$tmp/LICENSE"

version="$(DYLD_LIBRARY_PATH="$tmp/bin" "$tmp/bin/llama-server" --version 2>&1)"
grep -Fq 'version: 0.6.0-dev (build 11429, commit d81235049)' <<< "$version"
help="$(DYLD_LIBRARY_PATH="$tmp/bin" "$tmp/bin/llama-server" --help 2>&1)"
for flag in '-m,' --offline --host --port --api-key-file --no-webui --no-agent \
  --no-ui-mcp-proxy --parallel '-c,' '-n,' '-b,' '-ub,' --threads \
  --threads-batch --reasoning; do
  grep -Fq -- "$flag" <<< "$help" || {
    echo "Pinned llama-server does not support ModelRuntime argument: $flag" >&2
    exit 1
  }
done

mkdir -p "$DEST"
rm -rf "$DEST/bin"
mv "$tmp/bin" "$DEST/bin"
cp "$tmp/LICENSE" "$DEST/LICENSE"
echo "Prepared verified llama.cpp 0.6.0 build 11429 runtime at $DEST/bin"
