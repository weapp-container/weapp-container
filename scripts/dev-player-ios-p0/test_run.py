"""Pure filesystem/protocol tests: never build or inspect a simulator."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest import mock

import test_installer_policy as POLICY_FIXTURES


SPEC = importlib.util.spec_from_file_location(
    "dev_player_ios_p0_runner", Path(__file__).with_name("run.py")
)
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


class PureRunnerTest(unittest.TestCase):
    def setUp(self):
        # A regression that starts xcodebuild/simctl must fail these tests rather
        # than reaching the host's devices, services or installed applications.
        for method in ("run", "check_output", "Popen"):
            patch = mock.patch.object(
                RUNNER.subprocess, method,
                side_effect=AssertionError("Pure runner tests cannot launch subprocesses"),
            )
            patch.start()
            self.addCleanup(patch.stop)


class BindTestRootTests(PureRunnerTest):
    def test_recursively_binds_all_nested_path_and_environment_values(self):
        root = Path("/owned/current harness/Build/Products")
        supplied = {
            "SDKConsumerTests": {
                "TestHostPath": "__TESTROOT__/Debug-iphonesimulator/SDKConsumerTests-Runner.app",
                "TestBundlePath": "__TESTHOST__/PlugIns/SDKConsumerTests.xctest",
                "DependentProductPaths": [
                    "__TESTROOT__/Debug-iphonesimulator/SDKConsumer.app",
                    "__TESTROOT__/Debug-iphonesimulator/SDKConsumerTests.xctest",
                    {"nested": ["__PLATFORMS__/iPhoneSimulator.platform", "__TESTROOT__/fixture"]},
                ],
                "TestingEnvironmentVariables": {
                    "DYLD_FRAMEWORK_PATH": "__TESTROOT__/Debug-iphonesimulator",
                    "DYLD_INSERT_LIBRARIES": "__PLATFORMS__/Developer/libXCTestBundleInject.dylib",
                    "MIXED_PATH": "__TESTROOT__/A:__TESTHOST__/B:__PLATFORMS__/C",
                },
                "EnvironmentVariables": {"P0_FIXTURE": "__TESTROOT__/fixture"},
                "Unrelated": [None, True, 17, 1.5, {"empty": []}],
            },
            "__xctestrun_metadata__": {"FormatVersion": 1},
        }
        original = copy.deepcopy(supplied)
        actual = RUNNER.bind_testroot(supplied, root)
        target = actual["SDKConsumerTests"]
        self.assertEqual(target["TestHostPath"], str(root) + "/Debug-iphonesimulator/SDKConsumerTests-Runner.app")
        self.assertEqual(target["TestBundlePath"], "__TESTHOST__/PlugIns/SDKConsumerTests.xctest")
        self.assertEqual(target["DependentProductPaths"], [
            str(root) + "/Debug-iphonesimulator/SDKConsumer.app",
            str(root) + "/Debug-iphonesimulator/SDKConsumerTests.xctest",
            {"nested": ["__PLATFORMS__/iPhoneSimulator.platform", str(root) + "/fixture"]},
        ])
        self.assertEqual(target["TestingEnvironmentVariables"], {
            "DYLD_FRAMEWORK_PATH": str(root) + "/Debug-iphonesimulator",
            "DYLD_INSERT_LIBRARIES": "__PLATFORMS__/Developer/libXCTestBundleInject.dylib",
            "MIXED_PATH": str(root) + "/A:__TESTHOST__/B:__PLATFORMS__/C",
        })
        self.assertEqual(target["EnvironmentVariables"]["P0_FIXTURE"], str(root) + "/fixture")
        self.assertEqual(target["Unrelated"], original["SDKConsumerTests"]["Unrelated"])
        self.assertEqual(supplied, original)
        target["DependentProductPaths"][2]["nested"].append("new output only")
        target["Unrelated"][4]["empty"].append("new output only")
        self.assertEqual(supplied, original, "Recursive binding must not share mutable nested containers")

    def test_top_level_list_and_scalars_are_supported(self):
        root = Path("/current/products")
        self.assertEqual(RUNNER.bind_testroot(["__TESTROOT__/one", ["__TESTROOT__/two"]], root),
                         ["/current/products/one", ["/current/products/two"]])
        for value in (None, False, 0, 4.5, "__TESTHOST__/unchanged", "__PLATFORMS__/unchanged"):
            with self.subTest(value=value):
                self.assertEqual(RUNNER.bind_testroot(value, root), value)


class PreparationValidationTests(PureRunnerTest):
    def setUp(self):
        super().setUp()
        temporary = tempfile.TemporaryDirectory(prefix="ios-p0-source-binding-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.project = self.directory / "independent-copied-harness"
        self.project.mkdir()
        sources = {
            "Consumer.swift": "// independently copied consumer\n",
            "PlayerP0Tests.swift": "// independently copied UI tests\n",
            "SDKConsumer.xcodeproj/project.pbxproj": "// independent project\n",
            "SDKConsumer.xcodeproj/xcshareddata/xcschemes/SDKConsumer.xcscheme": "<Scheme/>\n",
        }
        for name, content in sources.items():
            source = self.project / name
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_text(content)
        self.receipt = {
            "schemaVersion": 1,
            "status": "prepared-not-built",
            "sourceFiles": [
                {"path": name, "sha256": hashlib.sha256((self.project / name).read_bytes()).hexdigest()}
                for name in sorted(sources)
            ],
        }
        self.write_receipt()

    def write_receipt(self):
        (self.project / "preparation.json").write_text(json.dumps(self.receipt))

    def assert_refused(self):
        with self.assertRaises((ValueError, OSError)):
            RUNNER.validate_preparation(self.project)

    def test_validates_actual_copied_sources_without_repository_here(self):
        # The preparation is authoritative for its own copied inputs; comparing
        # it with today's repository sources would relabel a historical build.
        with mock.patch.object(RUNNER, "HERE", self.directory / "absent-repository"):
            RUNNER.validate_preparation(self.project)

    def test_missing_receipt_is_refused(self):
        (self.project / "preparation.json").unlink()
        self.assert_refused()

    def test_missing_source_is_refused(self):
        (self.project / "PlayerP0Tests.swift").unlink()
        self.assert_refused()

    def test_changed_source_is_refused(self):
        (self.project / "PlayerP0Tests.swift").write_text("// changed after preparation\n")
        self.assert_refused()

    def test_added_source_is_refused(self):
        (self.project / "Extra.swift").write_text("// not part of the preparation receipt\n")
        self.assert_refused()

    def test_source_omitted_from_receipt_is_refused(self):
        self.receipt["sourceFiles"].pop()
        self.write_receipt()
        self.assert_refused()

    def test_schema_and_preparation_status_are_required(self):
        for key, bad in (("schemaVersion", 2), ("status", "built")):
            with self.subTest(field=key):
                previous = self.receipt[key]
                self.receipt[key] = bad
                self.write_receipt()
                self.assert_refused()
                self.receipt[key] = previous
                self.write_receipt()


class HarnessProductIdentityTests(PureRunnerTest):
    def setUp(self):
        super().setUp()
        temporary = tempfile.TemporaryDirectory(prefix="ios-p0-harness-binding-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.products = self.directory / "Products"
        self.host = self.products / "Debug-iphonesimulator/SDKConsumerTests-Runner.app"
        self.bundle = self.host / "PlugIns/SDKConsumerTests.xctest"
        self.make_bundle(self.host, "SDKConsumerTests-Runner")
        self.make_bundle(self.bundle, "SDKConsumerTests")
        self.xctestrun = self.products / "SDKConsumer_iphonesimulator-fixture.xctestrun"
        self.configuration = {
            "__xctestrun_metadata__": {"FormatVersion": 1},
            "SDKConsumerTests": {
                "IsUITestBundle": True,
                "ProductModuleName": "SDKConsumerTests",
                "TestHostPath": "__TESTROOT__/Debug-iphonesimulator/SDKConsumerTests-Runner.app",
                "TestBundlePath": "__TESTHOST__/PlugIns/SDKConsumerTests.xctest",
                "DependentProductPaths": ["__TESTROOT__/Debug-iphonesimulator/SDKConsumerTests-Runner.app"],
            },
        }
        self.save_configuration()

    def make_bundle(self, path, executable):
        path.mkdir(parents=True)
        (path / "Info.plist").write_bytes(plistlib.dumps({"CFBundleExecutable": executable}))
        (path / executable).write_bytes(b"test-only executable fixture, not a compiled application\n")
        (path / executable).chmod(0o755)

    def save_configuration(self):
        self.xctestrun.write_bytes(plistlib.dumps(self.configuration))

    def identity(self):
        return RUNNER.harness_product_identity(self.products, self.xctestrun)

    def assert_refused(self):
        with self.assertRaises((ValueError, OSError)):
            self.identity()

    def test_binds_real_runner_and_test_bundle_files_with_stable_inventory(self):
        identity = self.identity()
        self.assertEqual(identity, self.identity())
        self.assertEqual(identity["target"], "SDKConsumerTests")
        self.assertEqual(identity["testHost"], self.host.relative_to(self.products).as_posix())
        self.assertEqual(identity["testBundle"], self.bundle.relative_to(self.products).as_posix())
        self.assertEqual(identity["xctestrun"], self.xctestrun.name)
        self.assertRegex(identity["sha256"], r"^[0-9a-f]{64}$")
        inventory = {entry["path"]: entry for entry in identity["files"]}
        for executable in (self.host / "SDKConsumerTests-Runner", self.bundle / "SDKConsumerTests"):
            entry = inventory[executable.relative_to(self.products).as_posix()]
            self.assertEqual(entry["kind"], "file")
            self.assertTrue(entry["executable"])
            self.assertEqual(entry["size"], executable.stat().st_size)
            self.assertEqual(entry["sha256"], hashlib.sha256(executable.read_bytes()).hexdigest())

    def test_changed_test_binary_changes_identity_even_when_xctestrun_is_unchanged(self):
        before = self.identity()
        plist_hash = hashlib.sha256(self.xctestrun.read_bytes()).hexdigest()
        (self.bundle / "SDKConsumerTests").write_bytes(b"different compiled XCTest bytes\n")
        self.assertNotEqual(before["sha256"], self.identity()["sha256"])
        self.assertEqual(plist_hash, hashlib.sha256(self.xctestrun.read_bytes()).hexdigest())

    def test_added_visible_product_resource_changes_identity(self):
        before = self.identity()
        (self.bundle / "fixture.json").write_text('{"changed":true}\n')
        self.assertNotEqual(before["sha256"], self.identity()["sha256"])

    def test_format_two_is_refused(self):
        self.configuration["__xctestrun_metadata__"]["FormatVersion"] = 2
        self.save_configuration()
        self.assert_refused()

    def test_multiple_targets_are_refused(self):
        self.configuration["OtherTests"] = copy.deepcopy(self.configuration["SDKConsumerTests"])
        self.save_configuration()
        self.assert_refused()

    def test_non_ui_or_unexpected_module_is_refused(self):
        target = self.configuration["SDKConsumerTests"]
        for field, invalid in (("IsUITestBundle", False), ("ProductModuleName", "HistoricalTests")):
            with self.subTest(field=field):
                previous = target[field]
                target[field] = invalid
                self.save_configuration()
                self.assert_refused()
                target[field] = previous
                self.save_configuration()

    def test_xctestrun_outside_products_is_refused(self):
        outside = self.directory / "outside.xctestrun"
        outside.write_bytes(self.xctestrun.read_bytes())
        with self.assertRaises(ValueError):
            RUNNER.harness_product_identity(self.products, outside)

    def test_host_outside_products_is_refused(self):
        outside = self.directory / "unrelated-runner.app"
        self.make_bundle(outside, "UnrelatedRunner")
        self.configuration["SDKConsumerTests"]["TestHostPath"] = str(outside)
        self.save_configuration()
        self.assert_refused()

    def test_host_symlink_escape_is_refused(self):
        outside = self.directory / "unrelated-runner.app"
        self.make_bundle(outside, "UnrelatedRunner")
        alias = self.products / "EscapedRunner.app"
        alias.symlink_to(outside, target_is_directory=True)
        self.configuration["SDKConsumerTests"]["TestHostPath"] = "__TESTROOT__/EscapedRunner.app"
        self.save_configuration()
        self.assert_refused()

    def test_bundle_outside_its_host_is_refused(self):
        other = self.products / "Debug-iphonesimulator/UnrelatedTests.xctest"
        self.make_bundle(other, "UnrelatedTests")
        self.configuration["SDKConsumerTests"]["TestBundlePath"] = "__TESTROOT__/Debug-iphonesimulator/UnrelatedTests.xctest"
        self.save_configuration()
        self.assert_refused()

    def test_product_resource_symlink_escape_is_refused(self):
        outside = self.directory / "private-input"
        outside.write_text("must never be included by following a product symlink\n")
        (self.bundle / "escaped-resource").symlink_to(outside)
        self.assert_refused()

    def test_missing_runner_or_test_executable_is_refused(self):
        for executable in (self.host / "SDKConsumerTests-Runner", self.bundle / "SDKConsumerTests"):
            with self.subTest(executable=executable.name):
                original = executable.read_bytes()
                executable.unlink()
                self.assert_refused()
                executable.write_bytes(original)
                executable.chmod(0o755)


class InstalledAppTreeIdentityTests(PureRunnerTest):
    def test_dart_app_framework_tampering_changes_app_identity_without_changing_runner(self):
        with tempfile.TemporaryDirectory(prefix="ios-p0-app-binding-") as temporary:
            app = Path(temporary) / "WeappContainerDevPlayer.app"
            framework = app / "Frameworks/App.framework"
            framework.mkdir(parents=True)
            runner = app / "Runner"
            runner.write_bytes(b"unchanged native Runner fixture\n")
            dart = framework / "App"
            dart.write_bytes(b"first Dart AOT fixture\n")
            before = RUNNER.tree_identity(app)
            runner_hash = hashlib.sha256(runner.read_bytes()).hexdigest()
            dart.write_bytes(b"changed Dart AOT fixture\n")
            after = RUNNER.tree_identity(app)
            self.assertEqual(runner_hash, hashlib.sha256(runner.read_bytes()).hexdigest())
            self.assertNotEqual(before["sha256"], after["sha256"])
            record = next(entry for entry in after["files"] if entry["path"] == "Frameworks/App.framework/App")
            self.assertEqual(record["sha256"], hashlib.sha256(dart.read_bytes()).hexdigest())


class PlayerInstallationVerificationTests(PureRunnerTest):
    def setUp(self):
        super().setUp()
        temporary = tempfile.TemporaryDirectory(prefix="ios-p0-installation-verifier-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        app = self.directory / "Prepared.app"
        app.mkdir()
        self.executable = app / "Runner"
        self.executable.write_bytes(b"pure test executable fixture; never installed\n")
        self.executable.chmod(0o755)
        (app / "Info.plist").write_bytes(plistlib.dumps({"CFBundleExecutable": "Runner"}))
        framework = app / "Frameworks/App.framework/App"
        framework.parent.mkdir(parents=True)
        framework.write_bytes(b"pure test Dart framework fixture\n")
        framework.chmod(0o755)
        self.config = {
            "schemaVersion": 1, "dashboardOrigin": "http://127.0.0.1:58830",
            "profiles": [{"name": "iphone-se", "deviceId": "pure-test-not-paired",
                          "udid": "11111111-2222-3333-4444-555555555555", "ownership": "task-owned",
                          "deviceType": RUNNER.PROFILE_TYPES["iphone-se"],
                          "runtime": "com.apple.CoreSimulator.SimRuntime.iOS-27-0"}],
            "bindings": [{"role": "appExecutable", "path": str(self.executable),
                          "sha256": RUNNER.sha256(self.executable)}],
        }
        for role in ("runtimeLock", "sourceManifest", "playerBuildReceipt", "harnessBuildReceipt"):
            path = self.directory / (role + ".json")
            path.write_text('{"pureTestFixture":true}\n')
            self.config["bindings"].append({"role": role, "path": str(path), "sha256": RUNNER.sha256(path)})
        prepared = RUNNER.tree_identity(app)
        self.payload = {"schemaVersion": 1, "sourceAuthoredSha256": "d" * 64,
                        "prepared": prepared, "installed": copy.deepcopy(prepared)}
        self.installed_path = self.directory / "not-a-real-installed-app"

    def enable_policy(self):
        bindings = POLICY_FIXTURES.scoped_synthetic_evidence(self, self.directory, RUNNER.INSTALLER_POLICY)
        self.config["installerMetadataPolicy"] = RUNNER.INSTALLER_POLICY.POLICY_ID
        self.config["bindings"].extend(bindings.values())

    def change_installed(self, path="Frameworks/App.framework/App", **changes):
        entry = next(item for item in self.payload["installed"]["files"] if item["path"] == path)
        entry.update(changes)
        self.payload["installed"]["sha256"] = RUNNER.digest(self.payload["installed"]["files"])

    def invoke(self, returncode=0, stderr=""):
        # Return synthetic inventory only from the existing Node verifier call.
        # Any extra build/device subprocess remains forbidden by the base class.
        completed = RUNNER.subprocess.CompletedProcess([], returncode,
                                                        json.dumps(self.payload), stderr)
        with mock.patch.object(RUNNER.subprocess, "run", return_value=completed) as node:
            try:
                return RUNNER.verify_player_installation(self.config, self.installed_path)
            finally:
                if node.called:
                    node.assert_called_once()
                    command = node.call_args.args[0]
                    self.assertEqual(command[:3], ["node", "--input-type=module", "-e"])
                    self.assertIn("verifyBuildReceipt(receipt, current, prepared);", command[3])
                    options = json.loads(node.call_args.kwargs["input"])
                    self.assertEqual(options["installed"], str(self.installed_path))

    def test_default_strict_success_keeps_both_original_raw_identities(self):
        before = copy.deepcopy(self.payload)
        result = self.invoke()
        self.assertEqual(result["installationComparison"], "strict")
        self.assertNotIn("installerMetadataPolicy", result)
        self.assertEqual(result["installerGeneratedAdditions"], [])
        self.assertEqual(result["prepared"], before["prepared"])
        self.assertEqual(result["installed"], before["installed"])
        self.assertEqual(result["producerBuildReceipt"], self.config["bindings"][3])
        self.assertEqual(self.payload, before)

    def test_default_strict_rejects_even_an_allowlisted_metadata_change(self):
        self.change_installed(executable=False)
        with self.assertRaisesRegex(ValueError, "Unapproved installed"):
            self.invoke()

    def test_explicit_policy_keeps_distinct_raw_hashes_and_records_exact_transformation(self):
        self.enable_policy()
        self.change_installed(executable=False)
        before = copy.deepcopy(self.payload)
        result = self.invoke()
        self.assertEqual(result["installationComparison"], "explicit-installer-metadata")
        self.assertEqual(result["prepared"], before["prepared"])
        self.assertEqual(result["installed"], before["installed"])
        self.assertNotEqual(result["prepared"]["sha256"], result["installed"]["sha256"])
        policy = result["installerMetadataPolicy"]
        self.assertEqual(policy["actualTransformations"][0]["path"], "Frameworks/App.framework/App")
        self.assertEqual(len(policy["actualTransformations"]), 1)
        self.assertEqual(policy["scope"], "consumer-installer-metadata-only-not-product-acceptance")
        self.assertEqual(self.payload, before)

    def test_policy_does_not_hide_a_failed_original_producer_source_verification(self):
        self.enable_policy()
        self.change_installed(executable=False)
        with self.assertRaisesRegex(ValueError, "payload/source binding failed: changed original producer"):
            self.invoke(returncode=1, stderr="changed original producer")

    def test_policy_rejects_changed_framework_bytes_even_with_same_size(self):
        self.enable_policy()
        self.change_installed(executable=False, sha256="c" * 64)
        with self.assertRaisesRegex(ValueError, "Unapproved installed"):
            self.invoke()

    def test_policy_keeps_main_executable_metadata_strict(self):
        self.enable_policy()
        self.change_installed(path="Runner", executable=False)
        with self.assertRaisesRegex(ValueError, "Unapproved installed"):
            self.invoke()

    def test_bound_main_executable_change_is_rejected_before_subprocess(self):
        self.enable_policy()
        self.executable.write_bytes(b"changed after exact file binding\n")
        with self.assertRaisesRegex(ValueError, "Binding hash mismatch: appExecutable"):
            RUNNER.verify_player_installation(self.config, self.installed_path)

    def test_binding_a_framework_as_the_main_executable_is_rejected(self):
        self.enable_policy()
        executable = self.executable.parent / "__preview.dylib"
        executable.write_bytes(b"not the declared app executable\n")
        self.config["bindings"][0].update(path=str(executable), sha256=RUNNER.sha256(executable))
        with self.assertRaisesRegex(ValueError, "main executable"):
            RUNNER.verify_player_installation(self.config, self.installed_path)

    def test_missing_proof_is_rejected_before_original_node_verifier(self):
        self.enable_policy()
        for role in RUNNER.INSTALLER_POLICY.EVIDENCE_ROLES:
            with self.subTest(role=role):
                original = self.config["bindings"]
                self.config["bindings"] = [item for item in original if item["role"] != role]
                with self.assertRaisesRegex(ValueError, "reviewed original installer evidence"):
                    RUNNER.verify_player_installation(self.config, self.installed_path)
                self.config["bindings"] = original

    def test_duplicate_policy_binding_is_rejected_before_original_node_verifier(self):
        self.enable_policy()
        for binding in self.config["bindings"][-3:]:
            with self.subTest(role=binding["role"]):
                self.config["bindings"].append(copy.deepcopy(binding))
                with self.assertRaisesRegex(ValueError, "unique"):
                    RUNNER.verify_player_installation(self.config, self.installed_path)
                self.config["bindings"].pop()

    def test_proofs_without_explicit_policy_selection_do_not_change_strict_default(self):
        self.enable_policy()
        del self.config["installerMetadataPolicy"]
        with self.assertRaisesRegex(ValueError, "explicit installerMetadataPolicy"):
            RUNNER.verify_player_installation(self.config, self.installed_path)

    def test_load_config_requires_the_same_explicit_complete_proof_binding(self):
        self.enable_policy()
        path = self.directory / "config.json"
        path.write_text(json.dumps(self.config))
        loaded, profile = RUNNER.load_config(path, "iphone-se")
        self.assertEqual(loaded, self.config)
        self.assertEqual(profile["deviceId"], "pure-test-not-paired")
        self.config["bindings"].append(copy.deepcopy(self.config["bindings"][-1]))
        path.write_text(json.dumps(self.config))
        with self.assertRaisesRegex(ValueError, "unique"):
            RUNNER.load_config(path, "iphone-se")


class HarnessProducerBindingTests(PureRunnerTest):
    def setUp(self):
        super().setUp()
        temporary = tempfile.TemporaryDirectory(prefix="ios-p0-verifier-source-binding-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.authored = self.directory / "reviewed-harness-source"
        self.authored.mkdir()
        for name in RUNNER.HARNESS_INPUTS:
            (self.authored / name).write_text("pure reviewed source fixture: " + name + "\n")
        project = self.authored / "SDKConsumer.xcodeproj"
        project.mkdir()
        (project / "project.pbxproj").write_text("pure project fixture\n")
        patch = mock.patch.object(RUNNER, "HERE", self.authored)
        patch.start()
        self.addCleanup(patch.stop)
        self.prepared = self.directory / "prepared"
        with mock.patch("builtins.print"):
            RUNNER.prepare(self.prepared)
        build = self.directory / "build"
        build.mkdir()
        (build / "build.json").write_text('{"exitCode":0}\n')
        self.receipt = {
            "schemaVersion": 1, "status": "built", "preparedProject": str(self.prepared),
            "preparationSha256": RUNNER.sha256(self.prepared / "preparation.json"),
            "sourceFiles": RUNNER.authored_harness_sources(),
            "buildCommandSha256": RUNNER.sha256(build / "build.json"),
            "products": {"root": "/pure/fixture/products", "sha256": "a" * 64},
        }
        self.receipt_path = build / "harness-build.json"
        self.receipt_path.write_text(json.dumps(self.receipt))

    def verify(self):
        with mock.patch.object(RUNNER, "harness_product_identity", return_value=self.receipt["products"]):
            return RUNNER.validate_harness_build(self.receipt_path, self.directory / "fixture.xctestrun")

    def test_preparation_archives_driver_policy_geometry_and_test_producers(self):
        prepared = RUNNER.validate_preparation(self.prepared)
        self.assertEqual(prepared["sourceFiles"], RUNNER.authored_harness_sources())
        files = {item["path"] for item in prepared["sourceFiles"]}
        self.assertTrue({"run.py", "installer_policy.py", "installer-policy-ios27-simctl-v1.json",
                         "test_run.py", "test_installer_policy.py", "InputProbeGeometry.swift",
                         "InputProbeGeometryChecks.swift", "test_input_probe.py"} <= files)
        self.assertEqual(self.verify(), self.receipt)

    def test_changed_reviewed_driver_helper_definition_or_tests_refuse_an_old_build(self):
        for name in ("run.py", "installer_policy.py", "installer-policy-ios27-simctl-v1.json",
                     "test_run.py", "test_installer_policy.py", "InputProbeGeometry.swift",
                     "InputProbeGeometryChecks.swift", "test_input_probe.py"):
            with self.subTest(name=name):
                path = self.authored / name
                original = path.read_bytes()
                path.write_bytes(original + b"changed after old build\n")
                with self.assertRaisesRegex(ValueError, "current reviewed XCTest sources"):
                    self.verify()
                path.write_bytes(original)

    def test_copied_helper_changed_after_preparation_is_rejected(self):
        (self.prepared / "installer_policy.py").write_text("changed copied verifier\n")
        with self.assertRaisesRegex(ValueError, "source inventory differs"):
            self.verify()


class TestSummaryValidationTests(PureRunnerTest):
    udid = "11111111-2222-3333-4444-555555555555"

    def setUp(self):
        super().setUp()
        self.summary = {
            "result": "Passed",
            "totalTestCount": 1,
            "passedTests": 1,
            "failedTests": 0,
            "skippedTests": 0,
            "expectedFailures": 0,
            "testFailures": [],
            "devicesAndConfigurations": [{
                "device": {"deviceId": self.udid, "platform": "iOS Simulator"},
                "passedTests": 1,
                "failedTests": 0,
                "skippedTests": 0,
                "expectedFailures": 0,
            }],
        }

    def assert_refused(self):
        with self.assertRaises(ValueError):
            RUNNER.validate_test_summary(self.summary, self.udid)

    def test_exactly_one_pass_on_the_pinned_simulator_is_accepted(self):
        self.assertEqual(RUNNER.validate_test_summary(self.summary, self.udid), self.summary)

    def test_zero_executed_tests_cannot_pass(self):
        self.summary.update(totalTestCount=0, passedTests=0)
        self.summary["devicesAndConfigurations"][0]["passedTests"] = 0
        self.assert_refused()

    def test_skipped_test_cannot_pass(self):
        self.summary.update(passedTests=0, skippedTests=1)
        self.summary["devicesAndConfigurations"][0].update(passedTests=0, skippedTests=1)
        self.assert_refused()

    def test_wrong_device_cannot_pass(self):
        self.summary["devicesAndConfigurations"][0]["device"]["deviceId"] = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        self.assert_refused()

    def test_duplicate_device_configuration_cannot_pass(self):
        self.summary["devicesAndConfigurations"].append(copy.deepcopy(self.summary["devicesAndConfigurations"][0]))
        self.assert_refused()

    def test_non_simulator_platform_cannot_pass(self):
        self.summary["devicesAndConfigurations"][0]["device"]["platform"] = "iOS"
        self.assert_refused()

    def test_top_level_failure_counts_or_failure_records_cannot_pass(self):
        for field, invalid in (("result", "Failed"), ("failedTests", 1), ("expectedFailures", 1),
                               ("testFailures", [{"failureText": "real failure"}])):
            with self.subTest(field=field):
                original = self.summary[field]
                self.summary[field] = invalid
                self.assert_refused()
                self.summary[field] = original

    def test_device_configuration_counts_must_independently_match(self):
        configuration = self.summary["devicesAndConfigurations"][0]
        for field, invalid in (("passedTests", 0), ("failedTests", 1), ("skippedTests", 1), ("expectedFailures", 1)):
            with self.subTest(field=field):
                original = configuration[field]
                configuration[field] = invalid
                self.assert_refused()
                configuration[field] = original


if __name__ == "__main__":
    unittest.main()
