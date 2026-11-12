"""Synthetic, pure metadata tests; these add no installer or device evidence."""
import copy
from contextlib import ExitStack, contextmanager
import hashlib
import json
import tempfile
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest import mock


def no_process(*_args, **_kwargs):
    raise AssertionError("Installer metadata tests may not launch subprocesses")


SPEC = importlib.util.spec_from_file_location(
    "p0_installer_policy", Path(__file__).with_name("installer_policy.py")
)
POLICY = importlib.util.module_from_spec(SPEC)
with mock.patch.object(subprocess, "run", no_process), \
     mock.patch.object(subprocess, "Popen", no_process), \
     mock.patch.object(subprocess, "check_output", no_process), \
     mock.patch.object(subprocess, "check_call", no_process), \
     mock.patch.object(subprocess, "call", no_process):
    SPEC.loader.exec_module(POLICY)


ALLOWED = (
    "Frameworks/App.framework/App",
    "Frameworks/Flutter.framework/Flutter",
    "Frameworks/flutter_secure_storage.framework/flutter_secure_storage",
    "Frameworks/objective_c.framework/objective_c",
    "Runner.debug.dylib",
    "__preview.dylib",
)


@contextmanager
def synthetic_evidence(directory, module):
    """Test the proof gate with synthetic files, never the host's app/evidence.

    Production constants remain pinned to real original evidence. Only this
    scoped test fixture substitutes its three own hashes, so the pure suite is
    portable without treating synthetic files as new installer observations.
    """
    directory = Path(directory)
    prepared = [{"path": path, "kind": "file", "size": 100,
                 "executable": True, "sha256": "a" * 64} for path in ALLOWED]
    installed = copy.deepcopy(prepared)
    for entry in installed:
        entry["executable"] = False
    observed = {
        "schemaVersion": 1, "status": "exact-inventory-mismatch-preserved",
        "expected": {"files": prepared}, "installed": {"files": installed},
        "added": [], "missing": [], "allowlistApplied": False,
        "noPairingOrUITestsExecuted": True,
        "sourceBuildReceiptSha256": module.ORIGINAL_PRODUCER_SHA256,
    }
    failure = {"schemaVersion": 1, "status": "pre-pairing-binding-refused",
               "pairingPerformed": False, "C013Executed": False}
    bindings = {}

    def save(role, value):
        path = directory / (role + ".json")
        path.write_text(json.dumps(value, indent=2) + "\n")
        bindings[role] = {"role": role, "path": str(path),
                          "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        return bindings[role]["sha256"]

    observation_sha = save("installerObservation", observed)
    failure_sha = save("installerOriginalFailure", failure)
    policy = {
        "schemaVersion": 1, "id": module.POLICY_ID, "allowedPaths": sorted(ALLOWED),
        "transition": {"preparedExecutable": True, "installedExecutable": False},
        "observationSha256": observation_sha, "originalFailureSha256": failure_sha,
    }
    policy_sha = save("installerPolicy", policy)
    with mock.patch.multiple(module, POLICY_SHA256=policy_sha, OBSERVATION_SHA256=observation_sha,
                             ORIGINAL_FAILURE_SHA256=failure_sha):
        yield bindings


def scoped_synthetic_evidence(test, directory, module):
    # unittest.TestCase.enterContext requires Python 3.11; the runner also
    # supports the system Python 3.9 shipped on the development Mac.
    scope = ExitStack()
    test.addCleanup(scope.close)
    return scope.enter_context(synthetic_evidence(directory, module))


class InstallerMetadataPolicyTests(unittest.TestCase):
    def setUp(self):
        for name in ("run", "Popen", "check_output", "check_call", "call"):
            patch = mock.patch.object(subprocess, name, no_process)
            patch.start()
            self.addCleanup(patch.stop)
        self.prepared = [self.file(path) for path in ALLOWED]
        self.prepared += [
            self.file("Runner"),
            self.file("Frameworks/Unlisted.framework/Unlisted"),
            self.file("flutter_assets/AssetManifest.bin", executable=False),
            {"path": "Frameworks/Fixture.framework/Current", "kind": "symlink",
             "target": "Versions/A/Fixture", "sha256": "b" * 64},
        ]
        self.installed = copy.deepcopy(self.prepared)

    def file(self, path, executable=True):
        return {"path": path, "kind": "file", "size": 500,
                "executable": executable, "sha256": "a" * 64}

    def record(self, inventory, path):
        return next(item for item in inventory if item["path"] == path)

    def verify(self):
        return POLICY.verify_installer_metadata(self.prepared, self.installed, POLICY.POLICY_ID)

    def assert_refused(self):
        with self.assertRaises(ValueError):
            self.verify()

    def test_unchanged_inventory_has_no_differences(self):
        self.assertEqual(self.verify(), [])

    def test_default_comparison_accepts_identical_but_rejects_allowlisted_difference(self):
        self.assertEqual(POLICY.verify_installer_metadata(self.prepared, self.installed), [])
        self.record(self.installed, ALLOWED[0])["executable"] = False
        with self.assertRaises(ValueError):
            POLICY.verify_installer_metadata(self.prepared, self.installed)

    def test_unknown_policy_cannot_enable_an_exemption(self):
        self.record(self.installed, ALLOWED[0])["executable"] = False
        with self.assertRaises(ValueError):
            POLICY.verify_installer_metadata(self.prepared, self.installed, "future-unknown-policy")

    def test_exact_six_executable_bit_removals_are_accepted(self):
        for path in ALLOWED:
            self.record(self.installed, path)["executable"] = False
        original_prepared = copy.deepcopy(self.prepared)
        original_installed = copy.deepcopy(self.installed)
        differences = self.verify()
        self.assertIsInstance(differences, list)
        self.assertEqual(len(differences), 6)
        self.assertEqual(self.prepared, original_prepared)
        self.assertEqual(self.installed, original_installed)

    def test_each_allowlisted_path_is_an_independently_valid_subset(self):
        for path in ALLOWED:
            with self.subTest(path=path):
                self.installed = copy.deepcopy(self.prepared)
                self.record(self.installed, path)["executable"] = False
                self.assertEqual(len(self.verify()), 1)

    def test_same_size_changed_bytes_are_refused_even_with_allowed_bit_change(self):
        record = self.record(self.installed, ALLOWED[0])
        record.update(executable=False, sha256="c" * 64)
        self.assert_refused()

    def test_changed_size_is_refused_even_with_identical_sha(self):
        self.record(self.installed, ALLOWED[0]).update(executable=False, size=501)
        self.assert_refused()

    def test_new_member_is_refused(self):
        self.installed.append(self.file("flutter_assets/new-file", executable=False))
        self.assert_refused()

    def test_missing_member_is_refused(self):
        self.installed.remove(self.record(self.installed, ALLOWED[0]))
        self.assert_refused()

    def test_unlisted_framework_executable_bit_removal_is_refused(self):
        self.record(self.installed, "Frameworks/Unlisted.framework/Unlisted")["executable"] = False
        self.assert_refused()

    def test_reverse_executable_bit_change_is_refused_for_every_allowed_path(self):
        for path in ALLOWED:
            with self.subTest(path=path):
                prepared = copy.deepcopy(self.prepared)
                self.record(self.prepared, path)["executable"] = False
                self.installed = copy.deepcopy(self.prepared)
                self.record(self.installed, path)["executable"] = True
                self.assert_refused()
                self.prepared = prepared

    def test_main_runner_executable_bit_remains_strict(self):
        self.record(self.installed, "Runner")["executable"] = False
        self.assert_refused()

    def test_main_runner_bytes_remain_strict(self):
        self.record(self.installed, "Runner")["sha256"] = "c" * 64
        self.assert_refused()

    def test_allowlisted_path_kind_change_is_refused(self):
        self.record(self.installed, ALLOWED[0]).update(kind="symlink", target="OtherBinary", executable=False)
        self.assert_refused()

    def test_existing_link_target_change_is_refused(self):
        self.record(self.installed, "Frameworks/Fixture.framework/Current")["target"] = "Versions/B/Fixture"
        self.assert_refused()

    def test_allowlisted_path_cannot_be_a_link_with_an_executable_field(self):
        for inventory in (self.prepared, self.installed):
            self.record(inventory, ALLOWED[0]).update(kind="symlink", target="OtherBinary")
        self.record(self.installed, ALLOWED[0])["executable"] = False
        self.assert_refused()

    def test_duplicate_prepared_or_installed_paths_are_refused(self):
        for side in ("prepared", "installed", "both"):
            with self.subTest(side=side):
                prepared, installed = copy.deepcopy(self.prepared), copy.deepcopy(self.installed)
                if side in ("prepared", "both"):
                    self.prepared.append(copy.deepcopy(self.prepared[0]))
                if side in ("installed", "both"):
                    self.installed.append(copy.deepcopy(self.installed[0]))
                self.assert_refused()
                self.prepared, self.installed = prepared, installed

    def test_missing_executable_field_is_not_treated_as_false(self):
        self.record(self.installed, ALLOWED[0]).pop("executable")
        self.assert_refused()

    def test_added_or_changed_unknown_metadata_stays_strict(self):
        self.record(self.installed, ALLOWED[0]).update(executable=False, unexpected="new field")
        self.assert_refused()

    def test_invalid_inventory_paths_are_refused_on_either_side(self):
        for path in ("../Runner", "/Runner", "", ".", "./Runner", "a/../Runner", "a//Runner", "a\\Runner"):
            for side in ("prepared", "installed"):
                with self.subTest(path=path, side=side):
                    inventory = getattr(self, side)
                    before = inventory[0]["path"]
                    inventory[0]["path"] = path
                    self.assert_refused()
                    inventory[0]["path"] = before

    def test_invalid_regular_file_size_bool_and_hash_are_refused(self):
        for key, value in (("size", -1), ("size", True), ("executable", 0), ("sha256", "A" * 64), ("sha256", "a" * 63)):
            with self.subTest(key=key, value=value):
                entry = self.installed[0]
                previous = entry[key]
                entry[key] = value
                self.assert_refused()
                entry[key] = previous

    def test_returned_transformations_cannot_mutate_original_inventories(self):
        self.installed[0]["executable"] = False
        change = self.verify()[0]
        change["prepared"]["sha256"] = "c" * 64
        change["installed"]["sha256"] = "d" * 64
        self.assertEqual(self.prepared[0]["sha256"], "a" * 64)
        self.assertEqual(self.installed[0]["sha256"], "a" * 64)


class InstallerEvidenceBindingTests(unittest.TestCase):
    def setUp(self):
        for name in ("run", "Popen", "check_output", "check_call", "call"):
            patch = mock.patch.object(subprocess, name, no_process)
            patch.start()
            self.addCleanup(patch.stop)
        temporary = tempfile.TemporaryDirectory(prefix="ios-policy-synthetic-proof-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.bindings = scoped_synthetic_evidence(self, self.directory, POLICY)
        self.config = {"installerMetadataPolicy": POLICY.POLICY_ID}

    def verify(self):
        return POLICY.validate_installer_policy(self.config, self.bindings)

    def test_only_explicit_selected_policy_with_all_exact_proofs_is_accepted(self):
        original = copy.deepcopy(self.bindings)
        result = self.verify()
        self.assertEqual(result["id"], POLICY.POLICY_ID)
        self.assertEqual(result["originalObservation"], self.bindings["installerObservation"])
        self.assertEqual(result["originalFailure"], self.bindings["installerOriginalFailure"])
        self.assertEqual(self.bindings, original)
        self.assertTrue(result["archiveIdentityUnmodified"])
        self.assertTrue(result["installedInventoryUnmodified"])
        self.assertEqual(result["scope"], "consumer-installer-metadata-only-not-product-acceptance")

    def test_absent_policy_is_strict_only_when_no_policy_proofs_are_supplied(self):
        self.assertIsNone(POLICY.validate_installer_policy({}, {}))
        with self.assertRaises(ValueError):
            POLICY.validate_installer_policy({}, self.bindings)

    def test_null_or_unknown_selection_is_rejected(self):
        for choice in (None, "", True, {}, "future-policy"):
            with self.subTest(choice=choice), self.assertRaises(ValueError):
                POLICY.validate_installer_policy({"installerMetadataPolicy": choice}, self.bindings)

    def test_any_missing_policy_or_original_proof_is_rejected(self):
        for role in POLICY.EVIDENCE_ROLES:
            with self.subTest(role=role), self.assertRaises(ValueError):
                POLICY.validate_installer_policy(self.config, {key: item for key, item in self.bindings.items() if key != role})

    def test_changed_proof_bytes_are_rejected_even_when_config_hash_is_updated(self):
        for role in POLICY.EVIDENCE_ROLES:
            with self.subTest(role=role):
                original = copy.deepcopy(self.bindings[role])
                path = Path(original["path"])
                contents = path.read_bytes()
                path.write_bytes(contents + b" ")
                self.bindings[role]["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
                with self.assertRaises(ValueError):
                    self.verify()
                self.bindings[role] = original
                path.write_bytes(contents)

    def test_config_hash_cannot_hide_changed_proof_bytes(self):
        Path(self.bindings["installerObservation"]["path"]).write_text("{}\n")
        with self.assertRaisesRegex(ValueError, "evidence hash mismatch"):
            self.verify()

    def test_external_overlay_binding_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "external overlay"):
            POLICY.validate_installer_policy(self.config, {**self.bindings, "installerOverlay": {}})

    def test_reviewed_policy_file_keeps_original_bytes_and_six_path_boundary(self):
        # Check the actual production hash, unaffected by synthetic proof pins.
        path = Path(__file__).with_name("installer-policy-ios27-simctl-v1.json")
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(),
                         "9d617e94451d8cff9fe70c6cc02926fdb39152133fbf9df186043707fc6c8eb9")
        policy = json.loads(path.read_text())
        self.assertEqual(policy["allowedPaths"], sorted(ALLOWED))
        self.assertEqual(policy["observationSha256"], "e3e9669f52be9c3fed551b111ac1aa48c4c1b9d16899131515b525767f1392ea")
        self.assertEqual(policy["originalFailureSha256"], "5864b016c9251bf3b07e12a8000d8e451e630fd1bf2872c0c2f6a8195d4ac3c3")


if __name__ == "__main__":
    unittest.main()
