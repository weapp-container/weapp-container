"""Explicit consumer-only policy for a preserved iOS simulator observation.

This never rewrites producer receipts, app bytes or either raw inventory. The
reviewed proof authorizes only the listed regular-file executable-bit removals;
it is not evidence that a newly built Player or any product test has passed.
"""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re


POLICY_ID = "ios27-simctl-executable-bit-removal-observed-se-v1"
POLICY_PATHS = frozenset([
    "Frameworks/App.framework/App",
    "Frameworks/Flutter.framework/Flutter",
    "Frameworks/flutter_secure_storage.framework/flutter_secure_storage",
    "Frameworks/objective_c.framework/objective_c",
    "Runner.debug.dylib",
    "__preview.dylib",
])
POLICY_SHA256 = "9d617e94451d8cff9fe70c6cc02926fdb39152133fbf9df186043707fc6c8eb9"
OBSERVATION_SHA256 = "e3e9669f52be9c3fed551b111ac1aa48c4c1b9d16899131515b525767f1392ea"
ORIGINAL_FAILURE_SHA256 = "5864b016c9251bf3b07e12a8000d8e451e630fd1bf2872c0c2f6a8195d4ac3c3"
ORIGINAL_PRODUCER_SHA256 = "cef572c20499b07079fa7f083abfc144c647799b438207277144a6c82104372f"
EVIDENCE_ROLES = frozenset([
    "installerPolicy", "installerObservation", "installerOriginalFailure",
])


def _inventory_index(files):
    if not isinstance(files, list) or not files:
        raise ValueError("An exact nonempty file inventory is required")
    values = {}
    for entry in files:
        if not isinstance(entry, dict):
            raise ValueError("Malformed file inventory entry")
        path = entry.get("path")
        if (not isinstance(path, str) or not path or "\\" in path or "\0" in path
                or PurePosixPath(path).is_absolute() or ".." in PurePosixPath(path).parts
                or PurePosixPath(path).as_posix() != path or path == "." or path in values):
            raise ValueError("Duplicate or invalid inventory path")
        if entry.get("kind") == "file":
            if (set(entry) != {"path", "kind", "size", "executable", "sha256"}
                    or type(entry["size"]) is not int or entry["size"] < 0
                    or type(entry["executable"]) is not bool):
                raise ValueError("Malformed regular-file identity")
        elif entry.get("kind") == "symlink":
            if (set(entry) != {"path", "kind", "target", "sha256"}
                    or not isinstance(entry["target"], str) or not entry["target"]):
                raise ValueError("Malformed link identity")
        else:
            raise ValueError("Unsupported inventory kind")
        if not isinstance(entry.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]):
            raise ValueError("Missing exact file SHA-256")
        values[path] = entry
    return values


def verify_installer_metadata(prepared_files, installed_files, policy_id=None):
    """Return explicit transformations; strict comparison is the default."""
    if policy_id not in (None, POLICY_ID):
        raise ValueError("Unknown installer metadata policy")
    prepared, installed = _inventory_index(prepared_files), _inventory_index(installed_files)
    if set(prepared) != set(installed):
        raise ValueError("Installed member set differs; additions/removals are forbidden")
    if list(prepared) != list(installed):
        raise ValueError("Installed inventory ordering differs from the prepared build")
    changes = []
    for path in sorted(prepared):
        before, after = prepared[path], installed[path]
        if before == after:
            continue
        permitted = (policy_id == POLICY_ID and path in POLICY_PATHS
                     and before.get("kind") == after.get("kind") == "file"
                     and before["executable"] is True and after["executable"] is False
                     and {key: value for key, value in before.items() if key != "executable"}
                     == {key: value for key, value in after.items() if key != "executable"})
        if not permitted:
            raise ValueError("Unapproved installed payload/metadata difference: " + path)
        changes.append({"path": path, "prepared": before.copy(), "installed": after.copy(),
                        "transformation": "executable:true->false", "policyId": POLICY_ID})
    return changes


def _bound_json(binding, expected_sha256, role):
    if (not isinstance(binding, dict) or binding.get("sha256") != expected_sha256
            or not isinstance(binding.get("path"), str) or not binding["path"]):
        raise ValueError("Bind the reviewed original installer evidence: " + role)
    contents = Path(binding["path"]).read_bytes()
    if hashlib.sha256(contents).hexdigest() != expected_sha256:
        raise ValueError("Installer evidence hash mismatch: " + role)
    value = json.loads(contents)
    if not isinstance(value, dict):
        raise ValueError("Malformed installer evidence: " + role)
    return value


def validate_installer_policy(config, bindings):
    """Require opt-in plus immutable original proof, independent of app version."""
    if "installerOverlay" in bindings:
        raise ValueError("Use the reviewed canonical installer policy, not an external overlay")
    if "installerMetadataPolicy" not in config:
        if EVIDENCE_ROLES & bindings.keys():
            raise ValueError("Installer evidence requires an explicit installerMetadataPolicy")
        return None
    if config["installerMetadataPolicy"] != POLICY_ID:
        raise ValueError("Unknown installer metadata policy")
    policy = _bound_json(bindings.get("installerPolicy"), POLICY_SHA256, "installerPolicy")
    observed = _bound_json(bindings.get("installerObservation"), OBSERVATION_SHA256, "installerObservation")
    failure = _bound_json(bindings.get("installerOriginalFailure"), ORIGINAL_FAILURE_SHA256,
                          "installerOriginalFailure")
    if (type(policy.get("schemaVersion")) is not int or policy["schemaVersion"] != 1
            or policy.get("id") != POLICY_ID or policy.get("allowedPaths") != sorted(POLICY_PATHS)
            or policy.get("transition") != {"preparedExecutable": True, "installedExecutable": False}
            or policy.get("observationSha256") != OBSERVATION_SHA256
            or policy.get("originalFailureSha256") != ORIGINAL_FAILURE_SHA256):
        raise ValueError("Installer policy differs from the reviewed six-path transition")
    if (observed.get("schemaVersion") != 1 or observed.get("status") != "exact-inventory-mismatch-preserved"
            or observed.get("added") != [] or observed.get("missing") != []
            or observed.get("sourceBuildReceiptSha256") != ORIGINAL_PRODUCER_SHA256
            or observed.get("allowlistApplied") is not False
            or observed.get("noPairingOrUITestsExecuted") is not True):
        raise ValueError("The policy requires the original unmodified independent observation")
    proof = verify_installer_metadata(observed.get("expected", {}).get("files"),
                                      observed.get("installed", {}).get("files"), POLICY_ID)
    if {entry["path"] for entry in proof} != POLICY_PATHS:
        raise ValueError("The original observation must contain all six exact transitions")
    if (failure.get("schemaVersion") != 1 or failure.get("status") != "pre-pairing-binding-refused"
            or failure.get("pairingPerformed") is not False or failure.get("C013Executed") is not False):
        raise ValueError("The original pre-pairing failure must remain preserved")
    return {
        "id": POLICY_ID,
        "policy": dict(bindings["installerPolicy"]),
        "originalObservation": dict(bindings["installerObservation"]),
        "originalFailure": dict(bindings["installerOriginalFailure"]),
        "originalObservationProducerReceiptSha256": ORIGINAL_PRODUCER_SHA256,
        "implementationSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "archiveIdentityUnmodified": True, "installedInventoryUnmodified": True,
        "scope": "consumer-installer-metadata-only-not-product-acceptance",
    }
