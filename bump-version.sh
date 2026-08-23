#!/usr/bin/env bash
set -euo pipefail

# Usage: ./bump-version.sh <version>
# Example: ./bump-version.sh 1.0.5
#
# Does:
# 1. Replaces "version" in manifest.json
# 2. git add manifest.json && git commit -m 'Bump version to {version}'
# 3. git tag -a {version} -m "{version}" && git push origin {version}

VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 1.0.5"
  exit 1
fi

# Basic semver validation (x.y.z, allows prerelease/build metadata)
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  echo "Error: '$VERSION' does not look like a valid semver version (e.g. 1.0.5)"
  exit 1
fi

if [ ! -f "manifest.json" ]; then
  echo "Error: manifest.json not found in current directory"
  exit 1
fi

# 1. Replace "version" in manifest.json (using node to preserve JSON validity)
node -e "
const fs = require('fs');
const version = process.argv[1];
const manifest = JSON.parse(fs.readFileSync('manifest.json','utf8'));
const oldVersion = manifest.version;
manifest.version = version;
fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, '\t') + '\n');
console.log('Bumped manifest.json: ' + oldVersion + ' -> ' + manifest.version);
" "$VERSION"

# 2. git add & commit
git add manifest.json
git commit -m "Bump version to $VERSION"

# 3. tag and push tag
git tag -a "$VERSION" -m "$VERSION"
git push origin "$VERSION"

echo "Done: version $VERSION committed and pushed as tag."
