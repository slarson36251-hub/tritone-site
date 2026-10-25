#!/usr/bin/env bash
# Downloads the band MP3s still hosted on Squarespace into public/audio/<band>/<kebab-title>.mp3,
# then points each band's frontmatter `src` at the local copy. Run on a Mac with internet access:
#   bash scripts/fetch-audio.sh && npm run build
# Reads the URLs from src/content/bands/*.md, so it stays in sync with the content.
set -euo pipefail
cd "$(dirname "$0")/.."

kebab() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E "s/&/and/g; s/['’!]//g; s/[^a-z0-9]+/-/g; s/^-+|-+$//g"; }

for md in src/content/bands/*.md; do
  band=$(basename "$md" .md)
  # Lines look like:  - { title: Caffeine, src: "https://static1.squarespace.com/....mp3" }
  { grep -E '^[[:space:]]*- \{ title: .*src: "https?://' "$md" || true; } | while IFS= read -r line; do
    title=$(printf '%s' "$line" | sed -E 's/.*title: "?([^",]+)"?,.*/\1/')
    url=$(printf '%s' "$line" | sed -E 's/.*src: "([^"]+)".*/\1/')
    out="public/audio/$band/$(kebab "$title").mp3"
    mkdir -p "$(dirname "$out")"
    if [ ! -s "$out" ]; then
      echo "↓ $band: $title"
      curl -fsSL --retry 3 -o "$out.part" "$url" && mv "$out.part" "$out"
    fi
    # Point the frontmatter at the local file (macOS and GNU sed).
    local_src="/${out#public/}"
    sed -i.bak "s#src: \"$url\"#src: \"$local_src\"#" "$md" && rm -f "$md.bak"
  done
done
echo "Done. Check 'git diff src/content/bands' and commit public/audio if you want the MP3s in the repo."
