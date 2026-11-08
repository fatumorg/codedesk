#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out=$root/ui/vendor
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fetch() {
  local name=$1 version=$2 base=${1##*/}
  mkdir -p "$tmp/$name"
  curl -fsSL "https://registry.npmjs.org/$name/-/$base-$version.tgz" | tar xz -C "$tmp/$name" --strip-components=1
}
take() {
  local name=$1; shift
  for f in "$@"; do
    mkdir -p "$out/$name/$(dirname "$f")"
    cp -r "$tmp/$name/$f" "$out/$name/$f"
  done
}
rm -rf "$out/npm"
fetch marked 18.1.1
fetch dompurify 3.4.17
fetch katex 0.18.10
fetch marked-katex-extension 5.1.13
fetch @highlightjs/cdn-assets 11.12.0
fetch @xterm/xterm 6.0.0
fetch @xterm/addon-fit 0.11.0
fetch @phosphor-icons/web 2.1.2
fetch @fontsource-variable/geist 5.3.0
fetch @fontsource-variable/geist-mono 5.3.0
fetch @fontsource-variable/newsreader 5.3.0
out=$out/npm
take marked lib/marked.umd.js
take dompurify dist/purify.min.js
take katex dist/katex.min.js dist/katex.min.css
mkdir -p "$out/katex/dist/fonts" && cp "$tmp"/katex/dist/fonts/*.woff2 "$out/katex/dist/fonts/"
take marked-katex-extension lib/index.umd.js
take @highlightjs/cdn-assets highlight.min.js
take @xterm/xterm lib/xterm.js css/xterm.css
take @xterm/addon-fit lib/addon-fit.js
for w in bold fill; do
  take @phosphor-icons/web src/$w/style.css
  cp "$tmp"/@phosphor-icons/web/src/$w/*.woff2 "$out/@phosphor-icons/web/src/$w/"
done
take @fontsource-variable/geist index.css
take @fontsource-variable/geist-mono index.css
take @fontsource-variable/newsreader opsz.css opsz-italic.css
for f in geist geist-mono newsreader; do
  mkdir -p "$out/@fontsource-variable/$f/files"
  cp "$tmp"/@fontsource-variable/$f/files/*.woff2 "$out/@fontsource-variable/$f/files/"
done
