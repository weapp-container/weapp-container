#!/usr/bin/env python3
"""Prepare/build/run an owned iOS P0 XCTest harness. Never boots a simulator.

Preparation is filesystem-only. Execution requires explicit UDID + paired
device ID and exact source/runtime/app hashes. Pairing is performed separately
by the resource owner; no credential is printed or included in xctestrun.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
_POLICY_SPEC = importlib.util.spec_from_file_location("dev_player_ios_installer_policy", HERE / "installer_policy.py")
INSTALLER_POLICY = importlib.util.module_from_spec(_POLICY_SPEC)
_POLICY_SPEC.loader.exec_module(INSTALLER_POLICY)
# Both XCTest inputs and the Python execution/proof/test producers belong to
# a fresh harness build. A changed imported verifier must not reuse an old one.
HARNESS_INPUTS = (
    "Consumer.swift", "PlayerP0Tests.swift", "InputProbeGeometry.swift", "run.py", "installer_policy.py",
    "installer-policy-ios27-simctl-v1.json", "test_run.py", "test_installer_policy.py",
    "InputProbeGeometryChecks.swift", "test_input_probe.py",
)
STAGES = {
    "C013": ["test10C013TenRotationNavigationCycles"],
    "lifecycle": ["test20ToolsCloseReopenPersistentStorage"],
    "C012": ["test30C012ViewFaultTimersAndRetry"],
    "C018-baseline": ["test40C018CaptureAcceptedBaseline"],
    "C018-rejected": ["test41C018RejectedCandidateRetainsOwner"],
}
PROFILE_TYPES = {
    "iphone-se": "com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation",
    "iphone-max": "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro-Max",
    "ipad": "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB",
}


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def write_json(path, value):
    with Path(path).open("x") as output:
        json.dump(value, output, indent=2)
        output.write("\n")


def digest(value):
    return hashlib.sha256(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def bind_testroot(value, root):
    """Relocating the plist must not relocate its generated runner/products."""
    if isinstance(value, str):
        return value.replace("__TESTROOT__", str(Path(root).resolve()))
    if isinstance(value, list):
        return [bind_testroot(item, root) for item in value]
    if isinstance(value, dict):
        return {key: bind_testroot(item, root) for key, item in value.items()}
    return value


def tree_identity(root):
    root = Path(root).resolve(strict=True)
    files = []

    def walk(directory):
        for path in sorted(directory.iterdir()):
            name = path.relative_to(root).as_posix()
            if path.is_symlink():
                target = os.readlink(path)
                if Path(target).is_absolute() or not path.resolve(strict=True).is_relative_to(root):
                    raise ValueError("Nonportable product symlink: " + name)
                files.append({"path": name, "kind": "symlink", "target": target,
                              "sha256": hashlib.sha256(("symlink:" + target).encode()).hexdigest()})
            elif path.is_dir():
                walk(path)
            elif path.is_file():
                stat = path.stat()
                files.append({"path": name, "kind": "file", "size": stat.st_size,
                              "executable": bool(stat.st_mode & 0o111), "sha256": sha256(path)})
            else:
                raise ValueError("Unsupported product entry: " + name)

    walk(root)
    if not files:
        raise ValueError("Empty product inventory")
    return {"files": files, "sha256": digest(files)}


def source_identity(project):
    project = Path(project)
    files = []
    for path in sorted(project.rglob("*")):
        if path == project / "preparation.json":
            continue
        if path.is_symlink():
            raise ValueError("Harness sources may not contain symlinks")
        if path.is_file():
            files.append({"path": path.relative_to(project).as_posix(), "sha256": sha256(path)})
    return files


def authored_harness_sources():
    files = [HERE / name for name in HARNESS_INPUTS]
    files.extend(path for path in (HERE / "SDKConsumer.xcodeproj").rglob("*") if path.is_file())
    if any(path.is_symlink() for path in files):
        raise ValueError("Authored harness sources may not contain symlinks")
    return [{"path": path.relative_to(HERE).as_posix(), "sha256": sha256(path)} for path in sorted(files)]


def validate_preparation(project):
    project = Path(project)
    receipt = json.loads((project / "preparation.json").read_text())
    if (receipt.get("schemaVersion") != 1 or receipt.get("status") != "prepared-not-built"
            or not receipt.get("sourceFiles") or receipt["sourceFiles"] != source_identity(project)):
        raise ValueError("Prepared harness source inventory differs from its receipt")
    return receipt


def harness_product_identity(products, xctestrun):
    products, xctestrun = Path(products).resolve(strict=True), Path(xctestrun).resolve(strict=True)
    if not xctestrun.is_relative_to(products):
        raise ValueError("xctestrun escaped the fresh product directory")
    with xctestrun.open("rb") as source:
        value = plistlib.load(source)
    if value.get("__xctestrun_metadata__", {}).get("FormatVersion") != 1:
        raise ValueError("The P0 harness requires Xcode xctestrun format 1")
    targets = [(name, target) for name, target in value.items() if isinstance(target, dict) and "TestBundlePath" in target]
    if len(targets) != 1 or not targets[0][1].get("IsUITestBundle"):
        raise ValueError("Exactly one generated UI test target is required")
    name, target = targets[0]
    if name != "SDKConsumerTests" or target.get("ProductModuleName") != "SDKConsumerTests":
        raise ValueError("Unexpected P0 XCTest module")
    host = Path(str(target.get("TestHostPath", "")).replace("__TESTROOT__", str(products))).resolve(strict=True)
    bundle = Path(str(target["TestBundlePath"]).replace("__TESTROOT__", str(products)).replace("__TESTHOST__", str(host))).resolve(strict=True)
    if not host.is_relative_to(products) or not bundle.is_relative_to(host) or host.suffix != ".app" or bundle.suffix != ".xctest":
        raise ValueError("The generated test runner/bundle escaped the fresh products")
    for path in (host, bundle):
        with (path / "Info.plist").open("rb") as source:
            info = plistlib.load(source)
        executable = info.get("CFBundleExecutable")
        if not isinstance(executable, str) or Path(executable).name != executable or not (path / executable).is_file():
            raise ValueError("Generated XCTest executable is missing")
    return {"root": str(products), "xctestrun": xctestrun.relative_to(products).as_posix(),
            "target": name, "testHost": host.relative_to(products).as_posix(),
            "testBundle": bundle.relative_to(products).as_posix(), **tree_identity(products)}


def validate_harness_build(receipt_path, xctestrun):
    receipt_path = Path(receipt_path)
    receipt = json.loads(receipt_path.read_text())
    if receipt.get("schemaVersion") != 1 or receipt.get("status") != "built":
        raise ValueError("A completed source-bound harness build is required")
    project = Path(receipt["preparedProject"])
    prepared = validate_preparation(project)
    if (sha256(project / "preparation.json") != receipt.get("preparationSha256")
            or prepared["sourceFiles"] != receipt.get("sourceFiles")
            or prepared["sourceFiles"] != authored_harness_sources()):
        raise ValueError("Harness build does not contain the current reviewed XCTest sources")
    command_path = receipt_path.parent / "build.json"
    built = json.loads(command_path.read_text())
    if built.get("exitCode") != 0 or sha256(command_path) != receipt.get("buildCommandSha256"):
        raise ValueError("Harness build command receipt differs")
    expected = receipt["products"]
    actual = harness_product_identity(expected["root"], xctestrun)
    if actual != expected:
        raise ValueError("Harness products changed after their source-bound build")
    return receipt


def validated_bindings(config):
    supplied = config.get("bindings", [])
    if not isinstance(supplied, list) or any(not isinstance(item, dict) for item in supplied):
        raise ValueError("Expected explicit file bindings")
    bindings = {}
    for item in supplied:
        role = item.get("role")
        if not isinstance(role, str) or not role or role in bindings:
            raise ValueError("File binding roles must be nonempty and unique")
        if (not isinstance(item.get("path"), str) or not item["path"]
                or not isinstance(item.get("sha256"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"])
                or sha256(item["path"]) != item["sha256"]):
            raise ValueError("Binding hash mismatch: " + role)
        bindings[role] = item
    if not {"appExecutable", "runtimeLock", "sourceManifest", "playerBuildReceipt", "harnessBuildReceipt"} <= bindings.keys():
        raise ValueError("Bind unique appExecutable, runtimeLock, sourceManifest, playerBuildReceipt and harnessBuildReceipt")
    return bindings


def verify_player_installation(config, installed):
    """Use the existing build verifier; never reconstruct/rebind a past build."""
    bindings = validated_bindings(config)
    policy = INSTALLER_POLICY.validate_installer_policy(config, bindings)
    executable = Path(bindings["appExecutable"]["path"]).resolve(strict=True)
    bundle = executable.parent
    if bundle.suffix != ".app":
        raise ValueError("appExecutable must belong to the prepared .app bundle")
    with (bundle / "Info.plist").open("rb") as source:
        if plistlib.load(source).get("CFBundleExecutable") != executable.name:
            raise ValueError("appExecutable must bind the prepared app's main executable")
    module = (HERE.parent / "dev-player-build.mjs").as_uri()
    script = """
import {readFileSync, realpathSync} from 'node:fs';
import {resolve} from 'node:path';
const options = JSON.parse(readFileSync(0, 'utf8'));
const {captureOutputDirectory, captureSources, verifyBuildReceipt} = await import(options.module);
const receipt = JSON.parse(readFileSync(options.receipt, 'utf8'));
if (receipt.platform !== 'ios' || realpathSync(resolve(options.root, receipt.artifacts?.path ?? '')) !== realpathSync(options.bundle)) throw Error('Expected the exact prepared iOS application output');
const current = captureSources(options.root, 'ios');
const prepared = captureOutputDirectory(options.bundle);
verifyBuildReceipt(receipt, current, prepared);
const installed = captureOutputDirectory(options.installed);
process.stdout.write(JSON.stringify({schemaVersion:1, sourceAuthoredSha256:current.authoredSha256, prepared, installed}));
"""
    result = subprocess.run(["node", "--input-type=module", "-e", script],
                            input=json.dumps({"module": module, "root": str(HERE.parent.parent),
                                              "receipt": bindings["playerBuildReceipt"]["path"],
                                              "bundle": str(bundle), "installed": str(installed)}),
                            capture_output=True, text=True)
    if result.returncode != 0:
        raise ValueError("Player payload/source binding failed: " + result.stderr[-4096:])
    payload = json.loads(result.stdout)
    if not isinstance(payload, dict) or payload.get("schemaVersion") != 1:
        raise ValueError("Malformed Player inventory verification result")
    prepared, actual = payload.get("prepared"), payload.get("installed")
    if not isinstance(prepared, dict) or not isinstance(actual, dict):
        raise ValueError("Missing raw Player inventory verification result")
    changes = INSTALLER_POLICY.verify_installer_metadata(
        prepared.get("files"), actual.get("files"), policy["id"] if policy else None)
    # No main executable exemption, even if a caller bound an allowlisted name.
    before = next((entry for entry in prepared["files"] if entry["path"] == executable.name), None)
    after = next((entry for entry in actual["files"] if entry["path"] == executable.name), None)
    if (before is None or before != after or before["kind"] != "file"
            or before["sha256"] != bindings["appExecutable"]["sha256"]):
        raise ValueError("The main Player executable identity changed")
    payload["installerGeneratedAdditions"] = []
    payload["installationComparison"] = "explicit-installer-metadata" if policy else "strict"
    payload["producerBuildReceipt"] = dict(bindings["playerBuildReceipt"])
    if policy:
        payload["installerMetadataPolicy"] = {**policy, "actualTransformations": changes}
    return payload


def validate_test_summary(summary, udid):
    counts = {"totalTestCount": 1, "passedTests": 1, "failedTests": 0,
              "skippedTests": 0, "expectedFailures": 0}
    if (summary.get("result") != "Passed" or summary.get("testFailures") != []
            or any(summary.get(key) != value for key, value in counts.items())):
        raise ValueError("Expected exactly one passed XCTest, zero skipped/expected/actual failures")
    configurations = summary.get("devicesAndConfigurations")
    if not isinstance(configurations, list) or len(configurations) != 1:
        raise ValueError("Expected one exact simulator test configuration")
    configuration = configurations[0]
    device = configuration.get("device", {})
    if (device.get("deviceId") != udid or device.get("platform") != "iOS Simulator"
            or any(configuration.get(key) != value for key, value in counts.items() if key != "totalTestCount")):
        raise ValueError("XCTest summary belongs to a different simulator/configuration")
    return summary


def command(args, out, name):
    log = out / (name + ".log")
    record = {"command": args, "startedAt": now()}
    with log.open("x") as output:
        result = subprocess.run(args, stdout=output, stderr=subprocess.STDOUT)
    record.update(exitCode=result.returncode, finishedAt=now(), logSha256=sha256(log))
    write_json(out / (name + ".json"), record)
    return result.returncode


def prepare(out):
    out.mkdir(parents=True, exist_ok=False)
    for source in HARNESS_INPUTS:
        shutil.copy2(HERE / source, out / source)
    shutil.copytree(HERE / "SDKConsumer.xcodeproj", out / "SDKConsumer.xcodeproj")
    write_json(out / "preparation.json", {
        "schemaVersion": 1, "preparedAt": now(), "status": "prepared-not-built",
        "sourceFiles": source_identity(out),
        "resources": {"simulatorsCreated": [], "simulatorsBooted": [], "serversStarted": [], "pairingsCreated": []},
    })
    print("Prepared new harness sources; no app/build/device/server was started:", out)


def load_config(path, name):
    config = json.loads(path.read_text())
    if config.get("schemaVersion") != 1:
        raise ValueError("Expected config schemaVersion 1")
    origin = config.get("dashboardOrigin", "")
    if not re.fullmatch(r"http://127\.0\.0\.1:\d+", origin):
        raise ValueError("Only the loopback dashboard is allowed")
    profiles = [profile for profile in config["profiles"] if profile["name"] == name]
    if len(profiles) != 1 or not profiles[0].get("udid") or not profiles[0].get("deviceId"):
        raise ValueError("Select exactly one explicitly owned UDID and paired deviceId")
    profile = profiles[0]
    if profile.get("ownership") != "task-owned":
        raise ValueError("This runner requires a task-owned simulator")
    if (name not in PROFILE_TYPES or profile.get("deviceType") != PROFILE_TYPES[name]
            or profile.get("runtime") != "com.apple.CoreSimulator.SimRuntime.iOS-27-0"):
        raise ValueError("Pin the frozen SE3/ProMax/iPad device definition and iOS27.0 runtime")
    bindings = validated_bindings(config)
    INSTALLER_POLICY.validate_installer_policy(config, bindings)
    return config, profile


def run(args):
    config, profile = load_config(args.config, args.profile)
    harness_binding = next(item for item in config["bindings"] if item["role"] == "harnessBuildReceipt")
    harness = validate_harness_build(harness_binding["path"], args.xctestrun)
    # simctl list/get_app_container only inspect. xcodebuild can start a device,
    # so refuse before invoking it unless this exact owned simulator is booted.
    inventory = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "devices", "--json"]))
    matches = [{**device, "runtime": runtime} for runtime, devices in inventory["devices"].items() for device in devices if device["udid"] == profile["udid"]]
    if len(matches) != 1 or matches[0]["state"] != "Booted":
        raise ValueError("The explicitly owned simulator must already be Booted; this runner does not boot devices")
    if matches[0].get("deviceTypeIdentifier") != profile["deviceType"] or matches[0]["runtime"] != profile["runtime"]:
        raise ValueError("The owned simulator does not match the pinned matrix profile")
    bundle = config.get("bundleIdentifier", "dev.weapp.weappContainerDevPlayer")
    installed = Path(subprocess.check_output(["xcrun", "simctl", "get_app_container", profile["udid"], bundle, "app"], text=True).strip())
    with (installed / "Info.plist").open("rb") as file:
        metadata = plistlib.load(file)
    installed_hash = sha256(installed / metadata["CFBundleExecutable"])
    bound_app = next(item for item in config["bindings"] if item["role"] == "appExecutable")
    if installed_hash != bound_app["sha256"]:
        raise ValueError("Installed Player executable differs from the bound new app")
    args.out.mkdir(parents=True, exist_ok=False)
    payload = verify_player_installation(config, installed)
    write_json(args.out / "installed-payload.json", payload)
    # One owner per device. Never close or signal somebody else's test runner.
    lease = Path(os.getenv("TMPDIR", "/tmp")) / ("weapp-ios-p0-" + profile["udid"] + ".lock")
    descriptor = os.open(lease, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.write(descriptor, str(os.getpid()).encode()); os.close(descriptor)
    try:
        with args.xctestrun.open("rb") as source:
            test_run = bind_testroot(plistlib.load(source), args.xctestrun.resolve().parent)
        environment = {
            "P0_DASHBOARD": config["dashboardOrigin"], "P0_DEVICE_ID": profile["deviceId"],
            "P0_PROFILE": args.profile, "P0_PLAYER_BUNDLE": bundle,
        }
        if args.stage == "C018-rejected":
            expected = config.get("c018ExpectedAccepted", {})
            for field, variable in (("sessionId", "P0_EXPECT_SESSION"), ("root", "P0_EXPECT_ROOT"), ("acceptedPackRevision", "P0_EXPECT_ACCEPTED_REVISION")):
                if not isinstance(expected.get(field), str) or not expected[field]:
                    raise ValueError("C018 rejected stage needs the exact baseline accepted identity")
                environment[variable] = expected[field]
            candidate = config.get("c018ExpectedCandidate", {})
            if (not re.fullmatch(r"[0-9a-f]{64}", candidate.get("root", ""))
                    or candidate["root"] == expected["root"]
                    or not isinstance(candidate.get("generation"), str) or not candidate["generation"]
                    or not isinstance(candidate.get("runId"), str) or not candidate["runId"]):
                raise ValueError("C018 needs the actual candidate descriptor root/generation/runId")
            environment.update(P0_REJECTED_ROOT=candidate["root"], P0_REJECTED_GENERATION=candidate["generation"], P0_REJECTED_RUN_ID=candidate["runId"])
        targets = []
        for key, value in test_run.items():
            if isinstance(value, dict) and "TestBundlePath" in value:
                value.setdefault("EnvironmentVariables", {}).update(environment)
                targets.append(key)
        if len(targets) != 1:
            raise ValueError("Expected one P0 XCTest target")
        pinned = args.out / "owned.xctestrun"
        with pinned.open("xb") as output:
            plistlib.dump(test_run, output)
        write_json(args.out / "resource-ownership.json", {
            "schemaVersion": 1, "startedAt": now(), "profile": profile,
            "bindings": config["bindings"], "installedExecutableSha256": installed_hash,
            "harnessSha256": sha256(args.xctestrun), "testsSourceSha256": sha256(HERE / "PlayerP0Tests.swift"),
            "reviewedHarnessSources": harness["sourceFiles"],
            "runnerSourceSha256": sha256(HERE / "run.py"),
            "installerPolicySourceSha256": sha256(HERE / "installer_policy.py"),
            "harnessBuildReceiptSha256": harness_binding["sha256"], "harnessProductsSha256": harness["products"]["sha256"],
            "installedPayloadSha256": payload["installed"]["sha256"], "installerGeneratedAdditions": payload["installerGeneratedAdditions"],
            "installationComparison": payload["installationComparison"],
            "installerMetadataPolicy": payload.get("installerMetadataPolicy"),
            "stage": args.stage, "simulatorCreated": False, "bootedByRunner": False,
            "serverCreated": False, "pairingCreated": False, "cleanup": "Only runner lease is owned; existing app, simulator, service and pairing remain with their recorded owner.",
        })
        invocation = ["xcodebuild", "test-without-building", "-xctestrun", str(pinned),
                      "-destination", "platform=iOS Simulator,id=" + profile["udid"],
                      "-parallel-testing-enabled", "NO", "-maximum-concurrent-test-simulator-destinations", "1",
                      "-collect-test-diagnostics", "never", "-enablePerformanceTestsDiagnostics", "NO",
                      "-resultBundlePath", str(args.out / "result.xcresult")]
        invocation += ["-only-testing:" + targets[0] + "/PlayerP0Tests/" + test for test in STAGES[args.stage]]
        result = command(invocation, args.out, "xctest")
        bundle_path = args.out / "result.xcresult"
        stage_result = {"schemaVersion": 1, "status": "failed", "stage": args.stage,
                        "profile": args.profile, "xcodebuildExitCode": result}
        if bundle_path.exists():
            command(["xcrun", "xcresulttool", "export", "attachments", "--path", str(bundle_path), "--output-path", str(args.out / "attachments")], args.out, "export")
            summary = subprocess.run(["xcrun", "xcresulttool", "get", "test-results", "summary", "--path", str(bundle_path), "--format", "json"], capture_output=True, text=True)
            (args.out / "summary.json").write_text(summary.stdout if summary.returncode == 0 else json.dumps({"exportFailed": True}))
            try:
                if summary.returncode != 0:
                    raise ValueError("xcresult summary export failed")
                validate_test_summary(json.loads(summary.stdout), profile["udid"])
                if result == 0:
                    stage_result["status"] = "passed"
            except (ValueError, TypeError, KeyError) as error:
                stage_result["error"] = str(error)
        else:
            stage_result["error"] = "No XCTest result bundle"
        write_json(args.out / "stage-result.json", stage_result)
        if stage_result["status"] != "passed" and result == 0:
            result = 1
        print("XCTest", args.profile, args.stage, "exit", result, "evidence", args.out)
        return result
    finally:
        lease.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)
    prep = sub.add_parser("prepare"); prep.add_argument("--out", required=True, type=Path)
    build = sub.add_parser("build"); build.add_argument("--project", required=True, type=Path); build.add_argument("--out", required=True, type=Path)
    execute = sub.add_parser("run"); execute.add_argument("--config", required=True, type=Path); execute.add_argument("--profile", required=True)
    execute.add_argument("--stage", choices=STAGES, required=True); execute.add_argument("--xctestrun", required=True, type=Path); execute.add_argument("--out", required=True, type=Path)
    sub.add_parser("describe")
    args = parser.parse_args()
    if args.operation == "prepare": prepare(args.out); return 0
    if args.operation == "describe": print(json.dumps({"stages": STAGES, "cycles": 10, "bootsDevices": False, "startsServices": False, "status": "prepared-not-executed"}, indent=2)); return 0
    if args.operation == "build":
        prepared = validate_preparation(args.project)
        if prepared["sourceFiles"] != authored_harness_sources():
            raise ValueError("Prepare the current reviewed harness sources before building")
        args.out.mkdir(parents=True, exist_ok=False)
        result = command(["xcodebuild", "build-for-testing", "-project", str(args.project / "SDKConsumer.xcodeproj"), "-scheme", "SDKConsumer", "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", str(args.out / "derived"), "CODE_SIGNING_ALLOWED=NO"], args.out, "build")
        receipt = {"schemaVersion": 1, "status": "failed", "recordedAt": now(),
                   "preparedProject": str(args.project.resolve()), "preparationSha256": sha256(args.project / "preparation.json"),
                   "sourceFiles": prepared["sourceFiles"], "buildCommandSha256": sha256(args.out / "build.json")}
        if result == 0:
            if validate_preparation(args.project)["sourceFiles"] != prepared["sourceFiles"]:
                raise ValueError("Harness sources changed while building")
            products = args.out / "derived/Build/Products"
            runs = list(products.glob("*.xctestrun"))
            if len(runs) != 1:
                raise ValueError("Expected one fresh generated xctestrun")
            receipt.update(status="built", products=harness_product_identity(products, runs[0]))
        write_json(args.out / "harness-build.json", receipt)
        return result
    return run(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        # Messages above contain identities/paths only, never HTTP credentials.
        print("P0 runner refused:", str(error), file=sys.stderr)
        sys.exit(2)
