#!/usr/bin/env python3
"""Explicit, project-local dependency fetch; offline builds are the default."""
import argparse
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
ARTIFACTS = ROOT / "node_modules" / ".native-mel"
MANIFEST = json.loads((ROOT / "dependencies.json").read_text())


def run(*args, cwd=ROOT):
    subprocess.run(args, cwd=cwd, check=True)


def output(*args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fetch", action="store_true")
    parser.add_argument("--sanitize", action="store_true")
    parser.add_argument("--universal", action="store_true")
    args = parser.parse_args()
    if args.universal and args.sanitize:
        sys.exit("Universal packaging and native sanitizer testing are separate builds.")
    for name, pin in MANIFEST["dependencies"].items():
        path = ARTIFACTS / "dependencies" / name
        if not path.exists():
            if not args.fetch:
                sys.exit(f"Missing {name}; use --fetch explicitly.")
            path.mkdir(parents=True)
            run("git", "init", "--quiet", str(path))
            run("git", "remote", "add", "origin", pin["url"], cwd=path)
            run("git", "fetch", "--depth=1", "origin", pin["commit"], cwd=path)
            run("git", "checkout", "--detach", "FETCH_HEAD", cwd=path)
        if output("git", "rev-parse", "HEAD", cwd=path) != pin["commit"]:
            sys.exit(f"Wrong revision: {path}")
        if output("git", "status", "--porcelain", "--untracked-files=all", cwd=path):
            sys.exit(f"Modified dependency: {path}")
    cmake = ARTIFACTS / "venv/bin/cmake"
    if not cmake.exists():
        sys.exit("Missing local CMake; create node_modules/.native-mel/venv and install cmake=="
                 + MANIFEST["cmake"] + " there. No global installation is needed.")
    if output(str(cmake), "--version").splitlines()[0] != "cmake version " + MANIFEST["cmake"]:
        sys.exit("Local CMake version differs from manifest")
    build = ARTIFACTS / "build" / (
        "universal" if args.universal else "sanitize" if args.sanitize else "release")
    run(str(cmake), "-S", str(ROOT), "-B", str(build),
        "-DCMAKE_BUILD_TYPE=Debug" if args.sanitize else "-DCMAKE_BUILD_TYPE=Release",
        f"-DMEL_SANITIZE={'ON' if args.sanitize else 'OFF'}",
        "-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64" if args.universal else
        "-DCMAKE_OSX_ARCHITECTURES=arm64",
        "-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0")
    run(str(cmake), "--build", str(build), "--parallel", "2")
    run(str(cmake.parent / "ctest"), "--test-dir", str(build), "--output-on-failure")


if __name__ == "__main__":
    main()
