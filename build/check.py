"""Everything that can be checked without building anything.

    python build/check.py

Six checks, each of which has broken this project at least once:

  1. every path the manifest names exists;
  2. the extension has a stable id, and it matches the one the native host
     will be registered for;
  3. every JavaScript file parses, as a module or as a classic script;
  4. every Python module byte-compiles;
  5. the backend's routes are all still there;
  6. the versions that have to agree, agree.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

failures: list[str] = []
checks = 0


def check(name: str, ok: bool, detail: str = "") -> bool:
    global checks
    checks += 1
    print(f"  [{'ok  ' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if detail else ""))
    if not ok:
        failures.append(name)
    return ok


def heading(text: str) -> None:
    print()
    print(text)


# --------------------------------------------------------------------------- #

def manifest() -> dict:
    return json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))


def check_manifest_paths() -> None:
    heading("Manifest")
    document = manifest()
    referenced: list[str] = []

    def collect(value):
        if isinstance(value, str):
            if value.endswith((".js", ".html", ".css", ".png", ".json")):
                referenced.append(value)
        elif isinstance(value, dict):
            for item in value.values():
                collect(item)
        elif isinstance(value, list):
            for item in value:
                collect(item)

    collect(document)
    missing = sorted({path for path in referenced if not (ROOT / path).is_file()})
    check("every file the manifest names exists",
          not missing,
          f"{len(set(referenced))} referenced" if not missing else ", ".join(missing))


def check_extension_identity() -> None:
    heading("Identity")
    document = manifest()
    key = document.get("key")
    if not check("manifest.json declares a key", bool(key),
                 "without one the id changes with the folder"):
        return

    digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
    derived = "".join(chr(ord("a") + int(char, 16)) for char in digest)

    source = (ROOT / "native-host/hozayt/__init__.py").read_text(encoding="utf-8")
    marker = 'EXTENSION_ID = "'
    start = source.index(marker) + len(marker)
    declared = source[start:source.index('"', start)]

    check("the native host is registered for that id",
          derived == declared,
          derived if derived == declared else f"manifest {derived} != host {declared}")


def check_javascript() -> None:
    heading("JavaScript")
    if shutil.which("node") is None:
        check("node is available to parse with", False, "install Node to run this check")
        return

    files = sorted((ROOT / "src").rglob("*.js"))
    bad = []
    with tempfile.TemporaryDirectory() as scratch:
        for path in files:
            # The tree mixes both module kinds: background and core files are
            # modules, content scripts are classic scripts. A file only has to
            # be one of them.
            copy = Path(scratch) / (path.stem + ".mjs")
            copy.write_bytes(path.read_bytes())
            classic = subprocess.run(["node", "--check", str(path)],
                                     capture_output=True)
            module = subprocess.run(["node", "--check", str(copy)],
                                    capture_output=True)
            if classic.returncode != 0 and module.returncode != 0:
                bad.append(str(path.relative_to(ROOT)))
    check("every source file parses", not bad,
          f"{len(files)} files" if not bad else ", ".join(bad))


def check_python() -> None:
    heading("Python")
    for label, folder in (("backend", ROOT / "server"), ("engine", ROOT / "native-host")):
        done = subprocess.run(
            [sys.executable, "-m", "compileall", "-q", str(folder)],
            capture_output=True, text=True,
        )
        check(f"{label} byte-compiles", done.returncode == 0,
              (done.stdout + done.stderr).strip()[:200])


def check_routes() -> None:
    heading("Backend")
    script = (
        "import sys; sys.path.insert(0, r'%s')\n"
        "import app.main as m\n"
        "paths = {getattr(r, 'path', '') for r in m.app.routes}\n"
        "required = {'/api/health', '/api/about', '/api/analyze', '/api/jobs',"
        " '/api/extension/ping', '/setup', '/api/setup/state'}\n"
        "missing = sorted(required - paths)\n"
        "print('MISSING:' + ','.join(missing) if missing else 'OK:%%d' %% len(paths))\n"
    ) % (ROOT / "server")

    environment = dict(os.environ)
    environment["HOZA_DATA_DIR"] = tempfile.mkdtemp(prefix="hoza-check-")
    done = subprocess.run([sys.executable, "-c", script], capture_output=True,
                          text=True, env=environment)
    output = (done.stdout or done.stderr).strip().splitlines()
    last = output[-1] if output else "no output"
    check("the application imports and registers its routes",
          done.returncode == 0 and last.startswith("OK:"), last[:200])


def check_versions() -> None:
    heading("Versions")
    product = manifest()["version"]
    for name, path in (
        ("the engine", ROOT / "native-host/hozayt/__init__.py"),
        ("the backend", ROOT / "server/app/__init__.py"),
    ):
        source = path.read_text(encoding="utf-8")
        marker = '__version__ = "'
        start = source.index(marker) + len(marker)
        found = source[start:source.index('"', start)]
        check(f"{name} reports {product}", found == product,
              "" if found == product else f"reports {found}")


def main() -> int:
    print()
    print(f"  Hoza YT -- pre-build checks ({ROOT})")
    print("  " + "=" * 56)

    check_manifest_paths()
    check_extension_identity()
    check_javascript()
    check_python()
    check_routes()
    check_versions()

    print()
    if failures:
        print(f"  {len(failures)} of {checks} checks failed:")
        for name in failures:
            print(f"    - {name}")
        print()
        return 1
    print(f"  All {checks} checks passed.")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
