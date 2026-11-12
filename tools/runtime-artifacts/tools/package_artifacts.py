#!/usr/bin/env python3
"""Package already-built, explicitly pinned runtime/SDK distributions locally."""
import argparse
import contextlib
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import shutil
import stat
import struct
import sys
import tarfile
import tempfile
import unicodedata
import zipfile

REPO = Path(__file__).resolve().parent.parent
POLICY = json.loads((REPO / "policy.json").read_text())
VERSION = POLICY["runtimeVersion"]
ABI_VERSION = POLICY["abiVersion"]
HEADER_SHA256 = POLICY["headerSha256"]
CONTRACT_LICENSE_SHA256 = POLICY["contractLicenseSha256"]
REPOSITORY = POLICY["repository"]
RELEASE_TAG = "runtime-v" + VERSION
MAX_BYTES = 8 * 1024 ** 3
MAX_FILES = 100000
TARGETS = {
    "aarch64-linux-android": ("android", "arm64-v8a", ["libweapp_container_sdk.so", "libc++_shared.so"], ["quickjs-native-android", "skia-gpu-gles"]),
    "x86_64-linux-android": ("android", "x86_64", ["libweapp_container_sdk.so", "libc++_shared.so"], ["quickjs-native-android", "skia-gpu-gles"]),
    "aarch64-apple-ios": ("ios", "arm64-device", ["libweapp_container_sdk.a"], ["quickjs-native-ios", "skia-gpu-metal"]),
    "aarch64-apple-ios-sim": ("ios", "arm64-simulator", ["libweapp_container_sdk.a"], ["quickjs-native-ios", "skia-gpu-metal"]),
    "x86_64-apple-ios": ("ios", "x86_64-simulator", ["libweapp_container_sdk.a"], ["quickjs-native-ios", "skia-gpu-metal"]),
    "aarch64-apple-darwin": ("macos", "arm64", ["libweapp_container_sdk.a", "libweapp_container_sdk.dylib"], ["quickjs-native", "skia-gpu-metal"]),
    "x86_64-apple-darwin": ("macos", "x86_64", ["libweapp_container_sdk.a", "libweapp_container_sdk.dylib"], ["quickjs-native", "skia-gpu-metal"]),
    "x86_64-pc-windows-msvc": ("windows", "x86_64", ["weapp_container_sdk.lib"], ["quickjs-native", "skia-backend"]),
    "x86_64-unknown-linux-gnu": ("linux", "x86_64", ["libweapp_container_sdk.a", "libweapp_container_sdk.so"], ["quickjs-native", "skia-backend"]),
}
LIBRARIES = {"libweapp_container_sdk.a", "libweapp_container_sdk.so", "libweapp_container_sdk.dylib", "libc++_shared.so", "weapp_container_sdk.lib", "weapp_container_sdk.dll", "weapp_container_sdk.dll.lib"}
FORBIDDEN_PARTS = {".git", "node_modules", "target", ".gradle", ".dart_tool", ".cache", "cache", "caches", ".cxx", "__pycache__", ".env", ".npmrc", ".netrc", ".gitconfig", "credentials", "id_rsa", "id_ed25519", ".DS_Store", ".build", ".idea", ".pub-cache", ".ninja_log", ".ninja_deps", "CMakeFiles"}
PRIVATE_PATH = re.compile(rb"(?<![A-Za-z0-9_./-])/(?:Users/|home/|private/(?:var|tmp)/|var/folders/|Volumes/)|[A-Za-z]:[\\/](?:Users|a|Temp|work|build|actions-runner)[\\/]|\\\\[A-Za-z0-9_.-]{3,}\\[A-Za-z0-9_.-]{3,}\\")
SECRET = re.compile(rb"(?:github_pat_[A-Za-z0-9_]{15,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----)")
SENSITIVE_KEYS = {"password", "authorization", "access_token", "refresh_token", "privatekey", "private_key", "weapp_container_runtime_token", "sdk_repositories_read_token"}
NON_NOTICE_EXTENSIONS = set("rs c h cc hh cpp hpp cxx hxx c++ h++ m mm s asm inc js mjs cjs jsx ts mts cts tsx py pyi pyw rb go java kt kts swift cs fs fsx vb scala sc dart vue svelte css scss sass less json jsonl toml yaml yml xml sh bash zsh fish ps1 bat cmd cmake mak mk gradle sql r lua pl pm php ex exs erl beam clj cljs cljc edn a so dylib lib dll o obj exe rlib rmeta wasm jar zip tar gz tgz xz bz2 zst 7z class pyc pyo p12 p8 pem key mobileprovision".split())

class PackagingError(ValueError):
    pass

def require(condition, message):
    if not condition:
        raise PackagingError(message)

def digest_bytes(data):
    return hashlib.sha256(data).hexdigest()

def canonical(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()

def regular_file(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "Input is not an independent regular file: " + path.name)
    return info

def is_notice_filename(name):
    if not isinstance(name, str) or re.fullmatch(r"(?:licen[cs]e|copying|notice|copyright)(?:[._-][A-Za-z0-9._+-]+)?", name, re.IGNORECASE) is None:
        return False
    return name.lower() == "copying.lib" or name.rsplit(".", 1)[-1].lower() not in NON_NOTICE_EXTENSIONS

def safe_name(name, allow_html_notice=False):
    require(isinstance(name, str) and name and name == unicodedata.normalize("NFC", name), "Archive paths must be normalized UTF-8")
    require("\\" not in name and ":" not in name and not any(ord(char) < 32 or ord(char) == 127 for char in name), "Unsafe archive path")
    parts = name.split("/")
    require(not name.startswith("/") and all(part and part not in {".", ".."} for part in parts), "Archive path traversal")
    require(not any(part in FORBIDDEN_PARTS or part.startswith(".env.") for part in parts), "Cache or credential path is forbidden")
    require(not any(part.lower().startswith("cargo.") for part in parts) and not name.lower().endswith((".rs", ".rlib", ".rmeta", ".jsonl", ".pyc", ".p12", ".p8", ".mobileprovision", ".key", ".pem")), "Private source, build output or signing material is forbidden")
    if name.lower().endswith((".html", ".htm")):
        require((allow_html_notice or "licenses" in parts[:-1]) and is_notice_filename(parts[-1]), "HTML is permitted only as a complete notice under licenses")
    return name

def input_file(root, name, allow_html_notice=False):
    safe_name(name, allow_html_notice=allow_html_notice)
    root = root.resolve(strict=True)
    require(root.is_dir(), "Input root must be a directory")
    cursor = root
    for part in name.split("/"):
        cursor = cursor / part
        require(not cursor.is_symlink(), "Symlink input is forbidden")
    regular_file(cursor)
    return cursor

def walk_files(root, allow_html_notice=False):
    root = root.resolve(strict=True)
    result = []
    for parent, directories, files in os.walk(root, followlinks=False):
        for name in directories:
            path = Path(parent) / name
            safe_name(path.relative_to(root).as_posix(), allow_html_notice=allow_html_notice)
            require(not path.is_symlink(), "Symlink directory is forbidden")
        for name in files:
            path = Path(parent) / name
            relative = safe_name(path.relative_to(root).as_posix(), allow_html_notice=allow_html_notice)
            regular_file(path)
            result.append((relative, path))
            require(len(result) <= MAX_FILES, "Input file count limit exceeded")
    return sorted(result)

def scan_content(path):
    digest = hashlib.sha256()
    size = 0
    overlap = b""
    with path.open("rb") as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            data = overlap + chunk
            require(not PRIVATE_PATH.search(data), "Absolute private/local path found in " + path.name)
            require(not SECRET.search(data), "Credential material found in " + path.name)
            overlap = data[-512:]
            digest.update(chunk)
            size += len(chunk)
            require(size <= MAX_BYTES, "Input exceeds size limit")
    return size, digest.hexdigest()

def validate_json(value):
    if isinstance(value, dict):
        for key, child in value.items():
            require(not (key.lower() in SENSITIVE_KEYS and child), "Sensitive credential field is forbidden")
            validate_json(child)
    elif isinstance(value, list):
        for child in value:
            validate_json(child)
    elif isinstance(value, str):
        require(not re.match(r"^(?:/|[A-Za-z]:[\\/]|\\\\|file://)", value), "Absolute local path in distribution metadata")
        require(not PRIVATE_PATH.search(value.encode()), "Private local path in distribution metadata")

def read_json(path, portable=True):
    require(regular_file(path).st_size <= 16 * 1024 ** 2, "JSON metadata exceeds size limit")
    data = path.read_bytes()
    require(not SECRET.search(data), "Credential material in metadata")
    value = json.loads(data)
    if portable:
        validate_json(value)
    return value, digest_bytes(data)

def content(path):
    info = regular_file(path)
    size, digest = scan_content(path)
    require(info.st_size == size, "Input changed while hashing")
    return {"source": path, "size": size, "sha256": digest, "mode": 0o755 if info.st_mode & 0o111 else 0o644}

def generated(data):
    if not isinstance(data, bytes):
        data = canonical(data)
    require(not PRIVATE_PATH.search(data) and not SECRET.search(data), "Generated metadata leaks a private path or credential")
    return {"data": data, "size": len(data), "sha256": digest_bytes(data), "mode": 0o644}

def add(files, name, item):
    safe_name(name)
    if name in files:
        require(files[name]["sha256"] == item["sha256"] and files[name]["size"] == item["size"], "Conflicting archive path: " + name)
    else:
        files[name] = item

def add_tree(files, source, prefix):
    for name, path in walk_files(source):
        add(files, prefix + name, content(path))

def validate_native_receipt(receipt, target, expected_source, identity_only=False):
    platform, arch, required, features = TARGETS[target]
    require(isinstance(receipt, dict) and type(receipt.get("schemaVersion")) is int and receipt["schemaVersion"] == 1 and receipt.get("sdkVersion") == VERSION and receipt.get("status") == "built", "Native receipt is not a successful pinned build")
    require(receipt.get("target") == target and receipt.get("platform") == platform and receipt.get("profile") == "release", "Native target/profile mismatch")
    require(receipt.get("sourceCommit") == expected_source and receipt.get("sourceDirty") is False, "Native source must be the selected clean commit " + expected_source)
    require(set(receipt.get("features", [])) == set(features), "Native engine/renderer feature mismatch")
    require(type(receipt.get("abiVersion")) is int and receipt["abiVersion"] == ABI_VERSION, "Native ABI version is invalid")
    if not identity_only:
        require(type(receipt.get("exitCode")) is int and receipt["exitCode"] == 0, "Native compiler exit status is invalid")
    require(not receipt.get("error"), "Successful native receipt still records a failure")
    artifacts = receipt.get("artifacts")
    require(isinstance(artifacts, list) and artifacts, "Native artifact receipt is empty")
    allowed_libraries = {
        "android": {"libweapp_container_sdk.a", "libweapp_container_sdk.so", "libc++_shared.so"},
        "ios": {"libweapp_container_sdk.a", "libweapp_container_sdk.dylib"},
        "macos": {"libweapp_container_sdk.a", "libweapp_container_sdk.dylib"},
        "linux": {"libweapp_container_sdk.a", "libweapp_container_sdk.so"},
        "windows": {"weapp_container_sdk.lib", "weapp_container_sdk.dll", "weapp_container_sdk.dll.lib"},
    }[platform]
    names = set()
    for item in artifacts:
        name = safe_name(item.get("file"))
        require(name not in names, "Duplicate native artifact")
        names.add(name)
        require(name in allowed_libraries or name == "weapp_container_sdk.h" or re.fullmatch(r"platform-notices/(?:[A-Za-z0-9._-]+-)?(?:NOTICE|LICENSE|COPYING)(?:[._-][A-Za-z0-9._-]+)?", name), "Native artifact is outside the allowlist: " + name)
        require(re.fullmatch(r"[0-9a-f]{64}", item.get("sha256", "")) and type(item.get("bytes")) is int and 0 < item["bytes"] <= MAX_BYTES, "Invalid native digest/size")
    require(set(required + ["weapp_container_sdk.h"]).issubset(names), "Native receipt omits required library/header")
    if platform == "android":
        require(any(name.startswith("platform-notices/") for name in names), "Android NDK platform notices are required")
    return {item["file"]: item for item in artifacts}

def library_header(path, target):
    with path.open("rb") as source:
        header = source.read(64)
    name = path.name
    if name.endswith((".a", ".lib")):
        require(header.startswith(b"!<arch>\n"), "Static library is not an ar archive")
    elif name.endswith(".so"):
        machine = 183 if target.startswith("aarch64") else 62
        require(header[:6] == b"\x7fELF\x02\x01" and len(header) >= 20 and struct.unpack_from("<H", header, 18)[0] == machine, "ELF target architecture mismatch")
    elif name.endswith(".dylib"):
        cpu = 0x100000c if target.startswith("aarch64") else 0x1000007
        require(header[:4] == b"\xcf\xfa\xed\xfe" and struct.unpack_from("<I", header, 4)[0] == cpu, "Mach-O target architecture mismatch")
    elif name.endswith(".dll"):
        require(len(header) >= 64 and header[:2] == b"MZ", "DLL is not a PE image")
        offset = struct.unpack_from("<I", header, 60)[0]
        with path.open("rb") as source:
            source.seek(offset)
            signature = source.read(6)
        require(signature == b"PE\0\0\x64\x86", "PE target architecture mismatch")

def native_input(native_root, licenses_root, target, expected_source):
    require(target in TARGETS, "Unsupported runtime target")
    directory = native_root.resolve(strict=True) / target
    receipt_path = input_file(directory, "build.json")
    receipt, receipt_sha = read_json(receipt_path)
    artifacts = validate_native_receipt(receipt, target, expected_source)
    required = set(TARGETS[target][2]) | {"weapp_container_sdk.h"}
    distributed = {name: item for name, item in artifacts.items() if name in required or name.startswith("platform-notices/")}
    excluded = [{**item, "validation": "producer-receipt-only-not-distributed"} for name, item in artifacts.items() if name not in distributed]
    files = {"build.json": content(receipt_path)}
    artifact_identity = lambda item: {key: item[key] for key in ["file", "bytes", "sha256"]}
    distribution = {"schemaVersion": 1, "sdkVersion": VERSION, "abiVersion": ABI_VERSION, "target": target,
                    "sourceCommit": expected_source, "sourceDirty": False,
                    "producerReceipt": {"file": "build.json", "sha256": receipt_sha},
                    "selectedArtifacts": [artifact_identity(distributed[name]) for name in sorted(distributed)],
                    "omittedArtifacts": [artifact_identity(artifacts[name]) for name in sorted(artifacts) if name not in distributed]}
    distribution_item = generated(distribution)
    add(files, "runtime-distribution.json", distribution_item)
    for name, expected in distributed.items():
        item = content(input_file(directory, name))
        require(item["sha256"] == expected["sha256"] and item["size"] == expected["bytes"], "Native file differs from its successful build receipt: " + name)
        if name in LIBRARIES:
            library_header(item["source"], target)
        add(files, name, item)
    require(files["weapp_container_sdk.h"]["sha256"] == HEADER_SHA256, "Public header differs from the fixed reviewed contract")
    license_file = input_file(directory, "RUNTIME-LICENSE")
    require(license_file.read_bytes() == (REPO / "RUNTIME-LICENSE").read_bytes(), "Runtime license differs from release policy")
    add(files, "RUNTIME-LICENSE", content(license_file))
    root_license = input_file(native_root, "RUNTIME-LICENSE")
    require(root_license.read_bytes() == license_file.read_bytes(), "Root and target runtime licenses differ")
    notices = licenses_root.resolve(strict=True) / target
    inventory_path = input_file(notices, "licenses.json")
    inventory, license_sha = read_json(inventory_path)
    require(inventory.get("schemaVersion") == 1 and inventory.get("target") == target and set(inventory.get("features", [])) == set(receipt["features"]), "License inventory target/features mismatch")
    packages = inventory.get("packages")
    require(isinstance(packages, list) and packages, "Complete dependency notices are required")
    selected = {"licenses.json", "README.txt"}
    for package in packages:
        require(isinstance(package.get("files"), list) and package["files"], "A native dependency has no license files")
        for expected in package["files"]:
            name = safe_name(expected.get("path"), allow_html_notice=True)
            require(is_notice_filename(PurePosixPath(name).name), "License inventory points to a non-notice filename")
            item = content(input_file(notices, name, allow_html_notice=True))
            require(item["sha256"] == expected.get("sha256"), "License notice digest mismatch")
            selected.add(name)
            add(files, "licenses/" + name, item)
    require({name for name, _ in walk_files(notices, allow_html_notice=True)} == selected, "License directory has omitted or unlisted files; use a fresh complete inventory")
    for name in ["licenses.json", "README.txt"]:
        add(files, "licenses/" + name, content(input_file(notices, name)))
    return {"target": target, "receipt": receipt, "receiptSha256": receipt_sha, "distributionSha256": distribution_item["sha256"], "licensesSha256": license_sha, "licenseCollector": inventory.get("collector"), "excludedArtifacts": excluded, "files": files}

def compare_wrapper_native(receipt, natives, expected_source):
    identities = receipt.get("native")
    require(isinstance(identities, list) and len(identities) == len(natives), "Wrapper must identify every exact native slice")
    by_target = {identity.get("target"): identity for identity in identities}
    require(set(by_target) == {native["target"] for native in natives}, "Wrapper native target set mismatch")
    for native in natives:
        identity = by_target[native["target"]]
        actual = validate_native_receipt(identity, native["target"], expected_source, identity_only=True)
        expected = validate_native_receipt(native["receipt"], native["target"], expected_source)
        require(actual == expected, "Wrapper native artifact digests differ from pinned core receipts")

def check_wrapper_artifacts(root, entries):
    require(isinstance(entries, list) and entries, "Wrapper receipt has no artifact digests")
    seen = set()
    for entry in entries:
        name = safe_name(entry.get("file"))
        require(name not in seen, "Duplicate wrapper artifact")
        seen.add(name)
        item = content(input_file(root, name))
        require(item["sha256"] == entry.get("sha256"), "Wrapper artifact digest mismatch: " + name)

def hash_range(path, offset, size):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        source.seek(offset)
        while size:
            chunk = source.read(min(size, 1024 * 1024))
            require(chunk, "Truncated native slice")
            digest.update(chunk)
            size -= len(chunk)
    return digest.hexdigest()

def verify_archive_slices(path, natives):
    if len(natives) == 1:
        expected = natives[0]["files"]["weapp_container_sdk.lib" if path.suffix == ".lib" else "libweapp_container_sdk.a"]
        require(content(path)["sha256"] == expected["sha256"], "Installed core archive differs from native slice")
        return
    with path.open("rb") as source:
        header = source.read(8)
        require(header[:4] in [b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"], "Universal archive requires a real fat Mach-O container")
        count = struct.unpack(">I", header[4:])[0]
        require(count == len(natives), "Universal archive slice count differs from declared architectures")
        width = 32 if header[:4] == b"\xca\xfe\xba\xbf" else 20
        table = source.read(width * count)
    expected = {0x100000c if native["target"].startswith("aarch64") else 0x1000007: native["files"]["libweapp_container_sdk.a"] for native in natives}
    require(len(expected) == len(natives), "Universal archive cannot combine two environments with the same CPU")
    require(len(table) == width * count, "Truncated universal archive header")
    seen, ranges = set(), []
    table_end = 8 + width * count
    for index in range(count):
        cpu, subtype = struct.unpack_from(">II", table, index * width)
        offset, size = struct.unpack_from(">QQ" if width == 32 else ">II", table, index * width + 8)
        require(cpu in expected and cpu not in seen and offset >= table_end and size == expected[cpu]["size"] and all(offset >= previous_end or offset + size <= previous_start for previous_start, previous_end in ranges), "Invalid or overlapping universal archive slice")
        require(offset + size <= path.stat().st_size and hash_range(path, offset, size) == expected[cpu]["sha256"], "Universal archive bytes differ from native receipts")
        seen.add(cpu)
        ranges.append((offset, offset + size))


def scan_zip(archive, depth=0, budget=None):
    require(depth <= 2, "Nested ZIP depth limit exceeded")
    budget = budget if budget is not None else [0, 0]
    names = set()
    results = {}
    for member in archive.infolist():
        name = safe_name(member.filename.rstrip("/"))
        require(name not in names, "Duplicate ZIP entry")
        names.add(name)
        require(not stat.S_ISLNK(member.external_attr >> 16), "ZIP contains a symlink")
        require(member.file_size <= MAX_BYTES and not member.flag_bits & 1, "Encrypted or oversized ZIP member")
        budget[0] += 1
        budget[1] += member.file_size
        require(budget[0] <= MAX_FILES and budget[1] <= MAX_BYTES, "Nested ZIP count/size budget exceeded")
        if member.is_dir():
            continue
        digest, total, overlap = hashlib.sha256(), 0, b""
        with contextlib.ExitStack() as stack:
            nested = stack.enter_context(tempfile.TemporaryFile()) if name.lower().endswith((".jar", ".zip")) else None
            source = stack.enter_context(archive.open(member))
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                data = overlap + chunk
                require(not PRIVATE_PATH.search(data) and not SECRET.search(data), "ZIP content leaks a private path or credential")
                overlap = data[-512:]
                digest.update(chunk)
                total += len(chunk)
                require(total <= member.file_size, "ZIP decompression exceeded declared size")
                if nested is not None:
                    nested.write(chunk)
            require(total == member.file_size, "ZIP member size mismatch")
            if nested is not None:
                nested.seek(0)
                with zipfile.ZipFile(nested) as child:
                    scan_zip(child, depth + 1, budget)
        results[name] = digest.hexdigest()
    return results


def verify_aar(path, natives, binaries):
    by_abi = {TARGETS[native["target"]][1]: native for native in natives}
    require(isinstance(binaries, list) and binaries, "Android receipt omits verified JNI binary hashes")
    recorded = {}
    for binary in binaries:
        key = (binary.get("abi"), binary.get("library"))
        require(key not in recorded and re.fullmatch(r"[a-f0-9]{64}", binary.get("sha256", "")), "Invalid/duplicate Android binary digest")
        recorded[key] = binary["sha256"]
    actual = set()
    with zipfile.ZipFile(path) as archive:
        digests = scan_zip(archive)
    for name, digest in digests.items():
        if name.startswith("jni/") and name.endswith(".so"):
            parts = name.split("/")
            require(len(parts) == 3 and parts[1] in by_abi and parts[2] in {"libweapp_container_sdk.so", "libc++_shared.so", "libweapp_container_android.so"}, "Unexpected AAR native library/ABI")
            abi, library = parts[1:]
            key = (abi, library)
            actual.add(key)
            require(recorded.get(key) == digest, "AAR JNI bytes differ from wrapper validation receipt")
            if library != "libweapp_container_android.so":
                require(digest == by_abi[abi]["files"][library]["sha256"], "AAR JNI bytes differ from pinned native receipts")
    expected = {(abi, lib) for abi in by_abi for lib in ["libweapp_container_sdk.so", "libc++_shared.so", "libweapp_container_android.so"]}
    require(actual == expected and set(recorded) == expected, "AAR does not contain exactly the declared native ABI libraries")


def wrapper_input(component, platform, arch, architectures, install_dir, natives, expected_source):
    install_dir = install_dir.resolve(strict=True)
    receipt_name = {"android-sdk": "distribution.json", "ios-sdk": "build.json", "desktop-sdk": "package.json"}[component]
    receipt_path = input_file(install_dir, receipt_name)
    receipt, receipt_sha = read_json(receipt_path)
    status = {"android-sdk": "passed", "ios-sdk": "built", "desktop-sdk": "verified"}[component]
    require(receipt.get("schemaVersion") == 1 and receipt.get("sdkVersion") == VERSION and receipt.get("status") == status, "Wrapper installation is not successfully validated for packaging")
    require(re.fullmatch(r"[0-9a-f]{40}", receipt.get("sourceCommit", "")) and receipt.get("sourceDirty") is False, "Wrapper source must be a clean committed SDK revision")
    require(not receipt.get("error"), "Wrapper receipt still records a failure")
    for check in receipt.get("checks", []):
        if isinstance(check, dict):
            require(not check.get("error") and check.get("exitCode", 0) == 0 and check.get("status") not in {"failed", "blocked"} and check.get("result") != "failed", "Wrapper validation contains a failed check")
    compare_wrapper_native(receipt, natives, expected_source)
    files = {}
    if component == "android-sdk":
        check_wrapper_artifacts(install_dir / "maven", receipt.get("mavenArtifacts"))
        maven_files = walk_files(install_dir / "maven")
        require({name for name, _ in maven_files} == {item["file"] for item in receipt["mavenArtifacts"]}, "Maven installation contains unlisted files")
        aars = [path for name, path in maven_files if name.endswith(".aar")]
        require(len(aars) == 1, "Android SDK must contain exactly one pinned release AAR")
        expected_aar = f"maven/io/github/weapp-container/weapp-container-android/{VERSION}/weapp-container-android-{VERSION}.aar"
        require(aars[0].relative_to(install_dir).as_posix() == expected_aar, "Maven AAR coordinate/version mismatch")
        verify_aar(aars[0], natives, receipt.get("binaries"))
        add_tree(files, install_dir / "maven", "maven/")
        add(files, "validation.json", generated(receipt))
        if (install_dir / "validation.json").exists():
            external, external_sha = read_json(input_file(install_dir, "validation.json"), portable=False)
            require(external.get("status") == status and not external.get("error") and all(external.get(key) == receipt.get(key) for key in ["sdkVersion", "sourceCommit", "sourceDirty", "native", "mavenArtifacts", "binaries"]), "Portable Android receipt differs from current external validation/failure")
        else:
            external_sha = None
    elif component == "ios-sdk":
        check_wrapper_artifacts(install_dir, receipt.get("artifacts"))
        required = ["Package.swift", "WeappContainer.podspec", "LICENSE", "CONTRACT.md", "README.md", "ORIGIN.json"]
        for name in required:
            add(files, name, content(input_file(install_dir, name)))
        add_tree(files, install_dir / "Sources", "Sources/")
        framework = install_dir / "Frameworks/WeappContainerNative.xcframework"
        info = plistlib.loads(input_file(framework, "Info.plist").read_bytes())
        libraries = info.get("AvailableLibraries", [])
        environments = {"sim" in native["target"] or native["target"] == "x86_64-apple-ios" for native in natives}
        require(len(libraries) == len(environments), "XCFramework environment count differs from declared slices")
        seen = set()
        for library in libraries:
            identifier = safe_name(library.get("LibraryIdentifier"))
            require(library.get("SupportedPlatform") == "ios", "XCFramework platform mismatch")
            require(library.get("SupportedPlatformVariant") in {None, "simulator"} and "/" not in identifier, "Unsupported XCFramework platform variant/identifier")
            require(library.get("LibraryPath") == "libweapp_container_sdk.a" and library.get("HeadersPath") == "Headers", "XCFramework archive/header layout mismatch")
            simulator = library.get("SupportedPlatformVariant") == "simulator"
            selected = [native for native in natives if ("sim" in native["target"] or native["target"] == "x86_64-apple-ios") == simulator]
            expected_arches = {"arm64" if native["target"].startswith("aarch64") else "x86_64" for native in selected}
            require(selected and set(library.get("SupportedArchitectures", [])) == expected_arches, "XCFramework architectures differ from declared native slices")
            archive = input_file(framework, identifier + "/" + safe_name(library.get("LibraryPath")))
            verify_archive_slices(archive, selected)
            header = input_file(framework, identifier + "/" + safe_name(library.get("HeadersPath")) + "/weapp_container_sdk.h")
            require(content(header)["sha256"] == HEADER_SHA256, "XCFramework public header mismatch")
            require(simulator not in seen, "Duplicate XCFramework environment")
            seen.add(simulator)
        require(seen == environments, "XCFramework environment missing")
        add_tree(files, install_dir / "Frameworks", "Frameworks/")
        add(files, "build.json", generated(receipt))
        external_sha = None
    else:
        check_wrapper_artifacts(install_dir, receipt.get("artifacts"))
        library = input_file(install_dir, "lib/" + ("weapp_container_sdk.lib" if platform == "windows" else "libweapp_container_sdk.a"))
        verify_archive_slices(library, natives)
        require(content(input_file(install_dir, "include/weapp_container_sdk.h"))["sha256"] == HEADER_SHA256, "Desktop public header mismatch")
        for name in ["lib", "include", "share"]:
            add_tree(files, install_dir / name, name + "/")
        add(files, "package.json", generated(receipt))
        external_sha = None
    if (install_dir / "RUNTIME-LICENSE").exists():
        require(input_file(install_dir, "RUNTIME-LICENSE").read_bytes() == (REPO / "RUNTIME-LICENSE").read_bytes(), "Installed wrapper runtime license mismatch")
    for name, item in files.items():
        if name.endswith("RUNTIME-LICENSE"):
            require(item["sha256"] == digest_bytes((REPO / "RUNTIME-LICENSE").read_bytes()), "Installed nested runtime license mismatch")
    add(files, "RUNTIME-LICENSE", generated((REPO / "RUNTIME-LICENSE").read_bytes()))
    for native in natives:
        for name, item in native["files"].items():
            if name.startswith("licenses/"):
                if component == "desktop-sdk":
                    destination = "share/weapp-container/licenses/native/" + native["target"] + "/" + name[len("licenses/"):]
                else:
                    destination = "licenses/" + native["target"] + "/" + name[len("licenses/"):]
                add(files, destination, item)
            elif name.startswith("platform-notices/"):
                add(files, "platform-notices/" + native["target"] + "/" + name[len("platform-notices/"):], item)
    if component != "android-sdk":
        for artifact in receipt["artifacts"]:
            require(artifact["file"] in files and files[artifact["file"]]["sha256"] == artifact["sha256"], "Packaged wrapper artifact inventory differs from its validated installation")
    return files, {"wrapperSourceCommit": receipt["sourceCommit"], "wrapperReceiptSha256": receipt_sha, "wrapperReceiptFile": receipt_name,
                   "externalValidationSha256": external_sha, "validationStatus": status, "deviceExecution": receipt.get("deviceExecution", "not-recorded")}

@contextlib.contextmanager
def secure_source(path):
    """Open each ancestor without following links, then pin the file descriptor."""
    path = path.absolute()
    descriptors = []
    try:
        directory = os.open(path.anchor, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        descriptors.append(directory)
        for part in path.parts[1:-1]:
            directory = os.open(part, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0), dir_fd=directory)
            descriptors.append(directory)
        descriptor = os.open(path.name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=directory)
        with os.fdopen(descriptor, "rb") as source:
            info = os.fstat(source.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "Input changed to a link or special file")
            yield source, info
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)

class HashingReader:
    def __init__(self, source):
        self.source, self.digest = source, hashlib.sha256()
    def read(self, size=-1):
        data = self.source.read(size)
        self.digest.update(data)
        return data

def write_archive(path, files):
    require(files and len(files) <= MAX_FILES and sum(item["size"] for item in files.values()) <= MAX_BYTES, "Archive count/size budget exceeded")
    with path.open("xb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=6) as compressed, tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as archive:
        for name in sorted(files, key=lambda value: value.encode("utf-8")):
            item = files[name]
            entry = tarfile.TarInfo(safe_name(name))
            entry.size, entry.mode, entry.mtime = item["size"], item["mode"], 0
            entry.uid = entry.gid = 0
            entry.uname = entry.gname = ""
            if "data" in item:
                archive.addfile(entry, io.BytesIO(item["data"]))
            else:
                with secure_source(item["source"]) as (source, before):
                    require(before.st_size == item["size"], "Input size changed before archive write")
                    reader = HashingReader(source)
                    archive.addfile(entry, reader)
                    require(not source.read(1) and reader.digest.hexdigest() == item["sha256"], "Input bytes changed during archive write")
                    after = os.fstat(source.fileno())
                    require((before.st_size, before.st_mtime_ns, before.st_ino) == (after.st_size, after.st_mtime_ns, after.st_ino), "Input changed during archive write")
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"size": path.stat().st_size, "sha256": digest.hexdigest()}

def validate_manifest(manifest):
    require(set(manifest) == {"schemaVersion", "runtimeVersion", "abiVersion", "source", "artifacts"} and type(manifest["schemaVersion"]) is int and manifest["schemaVersion"] == 1 and manifest["runtimeVersion"] == VERSION and type(manifest["abiVersion"]) is int and manifest["abiVersion"] == ABI_VERSION, "Existing manifest schema/version mismatch")
    require(manifest["source"] == {"repository": REPOSITORY, "releaseTag": RELEASE_TAG}, "Existing manifest repository/release mismatch")
    require(isinstance(manifest["artifacts"], list) and 0 < len(manifest["artifacts"]) <= 1000, "Existing artifact list is invalid")
    seen = set()
    targets = set()
    for item in manifest["artifacts"]:
        name = item.get("fileName")
        require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.tar\.gz", name or "") and name not in seen, "Existing artifact filename is invalid or duplicated")
        identity = (item.get("component"), item.get("platform"), item.get("arch"))
        require(set(item).issubset({"component", "platform", "arch", "architectures", "fileName", "size", "sha256"}), "Unexpected artifact manifest field")
        supported = {arch for platform, arch, _, _ in TARGETS.values() if platform == item.get("platform")}
        component = item.get("component")
        require(component == "runtime" or component == "android-sdk" and item.get("platform") == "android" or component == "ios-sdk" and item.get("platform") == "ios" or component == "desktop-sdk" and item.get("platform") in {"macos", "windows", "linux"}, "Manifest component/platform mismatch")
        if item.get("arch") == "universal":
            architectures = item.get("architectures")
            require(isinstance(architectures, list) and len(architectures) >= 2 and len(architectures) == len(set(architectures)) and set(architectures).issubset(supported), "Universal manifest architectures invalid")
        else:
            require(item.get("arch") in supported and ("architectures" not in item or item["architectures"] == [item["arch"]]), "Manifest architecture invalid")
        require(identity not in targets and re.fullmatch(r"[0-9a-f]{64}", item.get("sha256", "")) and type(item.get("size")) is int and 0 < item["size"] <= MAX_BYTES, "Existing artifact pin is invalid or duplicated")
        seen.add(name)
        targets.add(identity)

def package(options):
    expected_source = options.source_commit
    require(re.fullmatch(r"[0-9a-f]{40}", expected_source or ""), "--source-commit must be an explicit full lowercase Git commit")
    require(os.name == "posix", "Secure packaging currently requires a POSIX host; Windows-target archives can be packaged from verified Windows build inputs on POSIX")
    native_root = Path(options.native_root).resolve(strict=True)
    licenses_root = Path(options.licenses_root).resolve(strict=True)
    out = Path(options.out_dir).resolve()
    require(out != native_root and native_root not in out.parents and out != licenses_root and licenses_root not in out.parents, "Output must be outside native and license inputs")
    out.mkdir(parents=True, exist_ok=True)
    lock = out / ".packaging.lock"
    descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.write(descriptor, str(os.getpid()).encode())
    os.close(descriptor)
    try:
        with tempfile.TemporaryDirectory(prefix=".packaging-", dir=out) as temporary:
            staging = Path(temporary)
            manifest_path = out / "manifest.json"
            provenance_path = out / "provenance.json"
            if manifest_path.exists():
                manifest, _ = read_json(manifest_path)
                validate_manifest(manifest)
                provenance, _ = read_json(provenance_path)
                require(provenance.get("schemaVersion") == 1 and provenance.get("runtimeVersion") == VERSION and provenance.get("abiVersion") == ABI_VERSION and provenance.get("sourceCommit") == expected_source and provenance.get("sourceDirty") is False and provenance.get("headerSha256") == HEADER_SHA256 and provenance.get("runtimeLicenseSha256") == digest_bytes((REPO / "RUNTIME-LICENSE").read_bytes()), "Existing provenance policy mismatch")
                require(len(provenance.get("artifacts", [])) == len(manifest["artifacts"]) and {item.get("fileName") for item in provenance.get("artifacts", [])} == {item["fileName"] for item in manifest["artifacts"]}, "Existing provenance artifact inventory mismatch")
                for pin in manifest["artifacts"]:
                    origin = next(item for item in provenance["artifacts"] if item["fileName"] == pin["fileName"])
                    require(origin.get("sha256") == pin["sha256"] and origin.get("sourceCommit") == expected_source and origin.get("headerSha256") == HEADER_SHA256 and origin.get("sourceDirty") is False, "Existing per-artifact provenance mismatch")
                    artifact_path = input_file(out, pin["fileName"])
                    require(artifact_path.stat().st_size == pin["size"] and hash_range(artifact_path, 0, pin["size"]) == pin["sha256"], "Existing release archive differs from its pin")
            else:
                require(not provenance_path.exists(), "Orphan release provenance requires manual review")
                manifest = {"schemaVersion": 1, "runtimeVersion": VERSION, "abiVersion": ABI_VERSION, "source": {"repository": REPOSITORY, "releaseTag": RELEASE_TAG}, "artifacts": []}
                provenance = {"schemaVersion": 1, "runtimeVersion": VERSION, "abiVersion": ABI_VERSION, "sourceCommit": expected_source, "sourceDirty": False, "headerSha256": HEADER_SHA256, "runtimeLicenseSha256": digest_bytes((REPO / "RUNTIME-LICENSE").read_bytes()), "artifacts": []}
            jobs = []
            if options.component == "runtime":
                require(not any([options.platform, options.arch, options.architectures, options.install_dir]), "Runtime mode selects --target, not wrapper installation options")
                if not options.target:
                    require(not any(child.is_dir() and (child / "build.json").exists() and child.name not in TARGETS for child in native_root.iterdir()), "Unsupported runtime receipt target present; select an explicit supported --target")
                selected = options.target.split(",") if options.target else [target for target in TARGETS if (native_root / target).exists()]
                require(selected and len(selected) == len(set(selected)), "No native target selected or duplicate target")
                for target in selected:
                    native = native_input(native_root, licenses_root, target, expected_source)
                    platform, arch = TARGETS[target][:2]
                    jobs.append(({"component": "runtime", "platform": platform, "arch": arch}, native["files"], [native], {}))
            else:
                require(not options.target and options.platform and options.arch and options.install_dir, "Wrapper mode requires --platform --arch --install-dir and no --target")
                expected = "android-sdk" if options.platform == "android" else "ios-sdk" if options.platform == "ios" else "desktop-sdk"
                require(options.component == expected and options.platform in {"android", "ios", "macos", "windows", "linux"}, "SDK component/platform mismatch")
                available = {arch: target for target, (platform, arch, _, _) in TARGETS.items() if platform == options.platform}
                architectures = options.architectures.split(",") if options.architectures else [options.arch]
                require(len(architectures) == len(set(architectures)) and set(architectures).issubset(available), "Unsupported or duplicate SDK architecture")
                if options.arch == "universal":
                    require(options.architectures and len(architectures) >= 2, "Universal SDKs must declare actual distinct slices")
                else:
                    require(architectures == [options.arch], "SDK architecture metadata mismatch")
                architectures = [architecture for architecture in available if architecture in architectures]
                natives = [native_input(native_root, licenses_root, available[arch], expected_source) for arch in architectures]
                files, extra = wrapper_input(options.component, options.platform, options.arch, architectures, Path(options.install_dir), natives, expected_source)
                identity = {"component": options.component, "platform": options.platform, "arch": options.arch}
                if options.arch == "universal":
                    identity["architectures"] = architectures
                jobs.append((identity, files, natives, extra))
            pending = []
            for identity, files, natives, extra in jobs:
                contract_license = content(REPO / "LICENSE-APACHE-2.0")
                require(contract_license["sha256"] == CONTRACT_LICENSE_SHA256, "Public contract Apache license differs from its reviewed pin")
                public_contract = {"repository": "weapp-container/sdk-contract", "version": POLICY["contractVersion"],
                                   "header": "weapp_container_sdk.h", "headerSha256": HEADER_SHA256,
                                   "licenseFile": "SDK-CONTRACT-LICENSE", "licenseSha256": CONTRACT_LICENSE_SHA256}
                add(files, "SDK-CONTRACT-LICENSE", contract_license)
                add(files, "SDK-CONTRACT-NOTICE.json", generated(public_contract))
                source = {"sourceCommit": expected_source, "sourceDirty": False, "headerSha256": HEADER_SHA256, "targets": [native["target"] for native in natives],
                          "publicContract": public_contract,
                          "nativeReceipts": [{"target": native["target"], "sha256": native["receiptSha256"], "distributionSha256": native["distributionSha256"], "licensesSha256": native["licensesSha256"], **({"licenseCollector": native["licenseCollector"]} if native["licenseCollector"] is not None else {})} for native in natives], **extra}
                excluded = [{"target": native["target"], "artifacts": native["excludedArtifacts"]} for native in natives if native["excludedArtifacts"]]
                if excluded:
                    source["excludedNativeBuildArtifacts"] = excluded
                add(files, "runtime-provenance.json", generated(source))
                name = "-".join([identity["component"], VERSION, identity["platform"], identity["arch"]]) + ".tar.gz"
                built = write_archive(staging / name, files)
                pin = {**identity, "fileName": name, "size": built["size"], "sha256": built["sha256"]}
                existing = next((item for item in manifest["artifacts"] if item["fileName"] == name or (item["component"], item["platform"], item["arch"]) == (identity["component"], identity["platform"], identity["arch"])), None)
                if existing:
                    require(existing == pin, "Immutable release refuses same name/target with different bytes")
                    previous = next(item for item in provenance["artifacts"] if item["fileName"] == name)
                    require(previous == {"fileName": name, "sha256": built["sha256"], **source}, "Immutable release provenance changed")
                else:
                    require(not (out / name).exists(), "Untracked archive name already exists; review it manually")
                    manifest["artifacts"].append(pin)
                    provenance["artifacts"].append({"fileName": name, "sha256": built["sha256"], **source})
                    pending.append(name)
            manifest["artifacts"].sort(key=lambda item: item["fileName"])
            provenance["artifacts"].sort(key=lambda item: item["fileName"])
            validate_manifest(manifest)
            for name, value in [("manifest.json", manifest), ("provenance.json", provenance)]:
                (staging / name).write_bytes(canonical(value))
            sums = [(pin["fileName"], pin["sha256"]) for pin in manifest["artifacts"]]
            sums += [(name, digest_bytes((staging / name).read_bytes())) for name in ["manifest.json", "provenance.json"]]
            (staging / "SHA256SUMS").write_text("".join(digest + "  " + name + "\n" for name, digest in sorted(sums)), encoding="utf-8")
            for name in pending:
                # Never overwrite an archive, even if another process ignores the lock.
                os.link(staging / name, out / name)
                (staging / name).unlink()
            for name in ["provenance.json", "SHA256SUMS", "manifest.json"]:
                os.replace(staging / name, out / name)
            return {"status": "packaged", "runtimeVersion": VERSION, "abiVersion": ABI_VERSION, "sourceCommit": expected_source, "archivesAdded": pending, "archives": len(manifest["artifacts"]), "compiled": False, "published": False}
    finally:
        lock.unlink()

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-commit", required=True, help="Reviewed full clean core source revision; every slice must match")
    parser.add_argument("--native-root", required=True, help="Successful pinned runtime distributions, keyed by Rust target")
    parser.add_argument("--licenses-root", required=True, help="Complete target-specific license inventories")
    parser.add_argument("--out-dir", required=True, help="Local incremental release archive directory (not Git)")
    parser.add_argument("--target", help="Runtime Rust target or comma-separated explicit target list; default all present supported targets")
    parser.add_argument("--component", choices=["runtime", "android-sdk", "ios-sdk", "desktop-sdk"], default="runtime")
    parser.add_argument("--platform", choices=["android", "ios", "macos", "windows", "linux"])
    parser.add_argument("--arch", help="Exact public architecture name or universal")
    parser.add_argument("--architectures", help="Comma-separated actual universal slices (required for universal)")
    parser.add_argument("--install-dir", help="Already validated wrapper installation; never a source/build root")
    selected_args = list(sys.argv[1:] if argv is None else argv)
    option_names = [item.split("=", 1)[0] for item in selected_args if item.startswith("--")]
    if len(option_names) != len(set(option_names)):
        parser.error("Duplicate options are not accepted")
    options = parser.parse_args(selected_args)
    try:
        print(json.dumps(package(options), sort_keys=True))
    except (PackagingError, OSError, ValueError, KeyError, TypeError, AttributeError, zipfile.BadZipFile, tarfile.TarError) as error:
        print("Packaging rejected: " + str(error), file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
