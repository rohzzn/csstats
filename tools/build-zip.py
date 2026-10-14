"""Validate the extension and build the Chrome Web Store package.

    python tools/build-zip.py            ->  dist/cs-stats-<version>.zip

Only runtime files go in the zip: the manifest's scripts/pages/icons, the popup's
references, and the asset files matched by web_accessible_resources. Dev tooling
(.dev, server, tools, store, README) stays out.
"""
import fnmatch
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
errors = []


def need(path, why):
    if not (ROOT / path).is_file():
        errors.append(f"missing {path} ({why})")
    return path


manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
version = manifest["version"]
files = {"manifest.json"}

files.add(need(manifest["background"]["service_worker"], "background"))
for script in manifest.get("content_scripts", []):
    for path in script.get("js", []) + script.get("css", []):
        files.add(need(path, "content script"))
for path in list(manifest.get("icons", {}).values()) + list(manifest.get("action", {}).get("default_icon", {}).values()):
    files.add(need(path, "icon"))
for page in filter(None, [manifest.get("options_page"), manifest.get("action", {}).get("default_popup")]):
    files.add(need(page, "page"))
    html = (ROOT / page).read_text(encoding="utf-8")
    for ref in re.findall(r'(?:src|href)="([^":#?]+\.(?:js|css|png|svg))"', html):
        files.add(need(ref, f"referenced by {page}"))

# background.js imports
for ref in re.findall(r'importScripts\("([^"]+)"\)', (ROOT / "background.js").read_text(encoding="utf-8")):
    files.add(need(ref, "importScripts"))

# web-accessible assets
all_files = [p.relative_to(ROOT).as_posix() for p in ROOT.rglob("*") if p.is_file() and ".git" not in p.parts]
for entry in manifest.get("web_accessible_resources", []):
    for pattern in entry["resources"]:
        matched = [f for f in all_files if fnmatch.fnmatch(f, pattern) and f.count("/") == pattern.count("/")]
        if not matched:
            errors.append(f"web_accessible_resources pattern matches nothing: {pattern}")
        files.update(matched)

# every catalog medal must have its image
catalog_src = (ROOT / "collectibles-map.js").read_text(encoding="utf-8-sig")
catalog = json.loads(catalog_src[catalog_src.index("{"):catalog_src.rindex("}") + 1])
for key, item in catalog.items():
    if not (ROOT / "collectibles-images" / item["file"]).is_file():
        errors.append(f"collectible {key} image missing: {item['file']}")

# syntax
for path in sorted(f for f in files if f.endswith(".js")):
    result = subprocess.run(["node", "--check", str(ROOT / path)], capture_output=True, text=True)
    if result.returncode != 0:
        errors.append(f"syntax error in {path}: {result.stderr.strip()[:200]}")

if len(manifest.get("description", "")) > 132:
    errors.append("manifest description is over the 132-character Web Store limit")

if errors:
    print("BUILD FAILED")
    for error in errors:
        print("  -", error)
    sys.exit(1)

out = ROOT / "dist" / f"cs-stats-{version}.zip"
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in sorted(files):
        archive.write(ROOT / path, path)

size = out.stat().st_size / 1e6
print(f"OK  {out.relative_to(ROOT)}  {len(files)} files  {size:.1f} MB  (catalog {len(catalog)} medals)")
