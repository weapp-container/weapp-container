"""Compile/run only pure Swift geometry; never xcodebuild, simctl, or a Player."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


HERE = Path(__file__).resolve().parent


class InputProbeGeometryTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("swiftc"), "Host Swift compiler is unavailable")
    def test_logical_screen_measurement_and_invalid_input_boundaries(self):
        with tempfile.TemporaryDirectory(prefix="ios-p0-pure-input-probe-") as directory:
            executable = Path(directory) / "input-probe-checks"
            built = subprocess.run([
                "swiftc", "-parse-as-library", str(HERE / "InputProbeGeometry.swift"),
                str(HERE / "InputProbeGeometryChecks.swift"), "-o", str(executable),
            ], capture_output=True, text=True, timeout=60)
            self.assertEqual(built.returncode, 0, built.stdout + built.stderr)
            checked = subprocess.run([str(executable)], capture_output=True, text=True, timeout=10)
            self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
            report = json.loads(checked.stdout)
            self.assertEqual(report["status"], "passed")
            self.assertEqual(report["count"], 17)
            self.assertEqual(len(set(report["checks"])), 17)
            self.assertFalse(report["simulatorUsed"])

    def test_post_fault_probe_does_not_resolve_hidden_native_view(self):
        source = (HERE / "PlayerP0Tests.swift").read_text()
        body = source.split("func tapFrozenScreenInputProbe(", 1)[1].split("func incrementJournal(", 1)[0]
        code = "\n".join(line.split("//", 1)[0] for line in body.splitlines())
        self.assertIn("player.coordinate(withNormalizedOffset: .zero)", code)
        self.assertIn("currentApplicationFrame: player.frame", code)
        self.assertIn("XCUIDevice.shared.orientation == probe.orientation", code)
        for forbidden in ("surface(", "target(", "assertLayout("):
            self.assertNotIn(forbidden, code)

    def test_fault_probe_is_frozen_before_trigger_and_checks_after_tap_identity(self):
        source = (HERE / "PlayerP0Tests.swift").read_text()
        body = source.split("func test30C012ViewFaultTimersAndRetry()", 1)[1].split("func test40C018", 1)[0]
        self.assertLess(body.index("freezeScreenInputProbe("), body.index('tap("p0-fault"'))
        self.assertLess(body.index('attach("C012-before-blocked-screen-input"'), body.index("tapFrozenScreenInputProbe("))
        self.assertIn("assertScreenInputProbeIdentity(before, ticking)", body)
        self.assertIn("incrementJournal(ticking), incrementEvents", body)
        self.assertIn('object(state(ticking)["executionHealth"])', body)
        self.assertIn("assertScreenInputProbeJournalRetained(fault, ticking)", body)
        self.assertIn("assertScreenInputProbeIdentity(before, stillFaulted, sameSurface: false)", body)
        self.assertIn('object(state(stillFaulted)["executionHealth"])', body)


if __name__ == "__main__":
    unittest.main()
