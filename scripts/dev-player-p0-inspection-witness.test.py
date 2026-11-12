#!/usr/bin/env python3
"""No-device regressions for retaining the runner's existing inspector polls."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    'witness_driver', Path(__file__).with_name('dev-player-p0-android.py'))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


def completed(request='request1', device='device1'):
    return {
        'requestId': request, 'deviceId': device, 'status': 'completed',
        'snapshot': {'state': {
            'schemaVersion': 1, 'status': 'ready', 'ownerId': '2', 'sessionId': 'session1',
            'hostSurface': {'ownerId': '2', 'surfaceGeneration': '1'},
            'acceptedLayout': {'schemaVersion': 1, 'ownerId': '2',
                               'surfaceGeneration': '1', 'observationId': '13',
                               'layoutRevision': '14'},
            'executionHealth': {'schemaVersion': 1, 'requiresRestart': False,
                                'appServiceFault': None, 'viewFault': None,
                                'navigationFault': None},
        }},
    }


class Response:
    def __init__(self, data):
        self.data = data

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, limit):
        return self.data[:limit]


class Opener:
    def __init__(self, result, received=None):
        self.result = result
        self.received = received
        self.calls = []
        # Deliberate whitespace proves the receipt hashes HTTP bytes rather
        # than re-encoding the parsed dictionary.
        self.wire = ('  ' + json.dumps(result) + '\n').encode()

    def open(self, request, timeout):
        self.calls.append(request.full_url)
        if request.full_url.endswith('/inspect'):
            return Response(b'{"status":"pending","requestId":"request1"}')
        if self.received:
            self.received()
        return Response(self.wire)


class InspectionWitness(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.out = Path(self.temporary.name) / 'run'

    def runner(self, result=None, received=None):
        args = type('Args', (), dict(out=str(self.out), serial='emulator-5558',
                                    avd='owned', device_id='device1',
                                    apk_sha256='a' * 64, cycles=10,
                                    stage='full', admin='http://127.0.0.1:58830'))()
        runner = driver.Runner(args)
        runner.secret = 'private-admin-key'
        runner.opener = Opener(result or completed(), received)
        return runner

    def store(self, **limits):
        self.out.mkdir()
        return driver.InspectionWitnessStore(self.out, **limits)

    def record(self, store, result=None, **overrides):
        result = result or completed()
        wire = json.dumps(result).encode()
        args = dict(request_id='request1', device_id='device1',
                    started_ns=100, received_ns=200, deadline_ns=300,
                    wire_sha256=hashlib.sha256(wire).hexdigest(),
                    wire_bytes=len(wire))
        args.update(overrides)
        return store.record(result, **args)

    def test_existing_successful_poll_is_visible_without_a_screenshot_capture(self):
        runner = self.runner()
        result = runner.inspection()
        witnesses = list(self.out.glob('*.inspect.json'))
        self.assertEqual(len(witnesses), 1)
        self.assertEqual(json.loads(witnesses[0].read_text()), result)
        # The unchanged monitor's root-level glob can now see observation13.
        self.assertEqual(json.loads(witnesses[0].read_text())['snapshot']['state']
                         ['acceptedLayout']['observationId'], '13')
        self.assertEqual(len(runner.opener.calls), 2)

    def test_receipt_binds_exact_wire_bytes_scrubbed_bytes_request_and_clock(self):
        runner = self.runner()
        result = runner.inspection()
        receipt = json.loads((self.out / 'poll-witnesses/poll-000001.json').read_text())
        witness = self.out / receipt['snapshot']['path']
        self.assertEqual(receipt['requestId'], 'request1')
        self.assertEqual(receipt['deviceId'], 'device1')
        self.assertEqual(receipt['wire']['sha256'], hashlib.sha256(runner.opener.wire).hexdigest())
        self.assertEqual(receipt['wire']['bytes'], len(runner.opener.wire))
        self.assertEqual(receipt['snapshot']['sha256'], hashlib.sha256(witness.read_bytes()).hexdigest())
        self.assertTrue(receipt['publishedForLayoutProof'])
        self.assertEqual((self.out / receipt['layoutProofMirror']['path']).read_bytes(), witness.read_bytes())
        self.assertLessEqual(receipt['requestedMonotonicNs'], receipt['receivedMonotonicNs'])
        self.assertLess(receipt['receivedMonotonicNs'], receipt['deadlineMonotonicNs'])
        self.assertEqual(result['snapshot']['state']['sessionId'], 'session1')

    def test_secret_scrubbing_never_changes_native_health_or_returned_result(self):
        result = completed()
        result['snapshot']['secretToken'] = 'never-persist'
        result['snapshot']['message'] = 'Bearer abc ghp_sensitive weapp-container://private'
        original = copy.deepcopy(result)
        store = self.store()
        self.record(store, result)
        files = [p for p in self.out.rglob('*') if p.is_file()]
        text = '\n'.join(p.read_text() for p in files)
        for secret in ['never-persist', 'Bearer abc', 'ghp_sensitive', 'weapp-container://private']:
            self.assertNotIn(secret, text)
        saved = json.loads(next(self.out.glob('*.inspect.json')).read_text())
        self.assertEqual(saved['snapshot']['state'], original['snapshot']['state'])
        self.assertEqual(result, original)

    def test_unhealthy_completed_state_is_preserved_not_promoted_to_healthy(self):
        result = completed()
        result['snapshot']['state']['executionHealth'].update(
            requiresRestart=True, viewFault={'code': 'ERR_ENGINE'})
        self.record(self.store(), result)
        saved = json.loads(next((self.out / 'poll-witnesses').glob('*.snapshot.json')).read_text())
        self.assertTrue(saved['snapshot']['state']['executionHealth']['requiresRestart'])
        self.assertEqual(saved['snapshot']['state']['executionHealth']['viewFault'], {'code': 'ERR_ENGINE'})
        self.assertEqual(list(self.out.glob('*.inspect.json')), [])
        receipt = json.loads((self.out / 'poll-witnesses/poll-000001.json').read_text())
        self.assertFalse(receipt['publishedForLayoutProof'])
        self.assertIsNone(receipt['layoutProofMirror'])
        self.assertEqual(receipt['snapshot']['sha256'], hashlib.sha256(
            (self.out / receipt['snapshot']['path']).read_bytes()).hexdigest())

    def test_unknown_missing_or_foreign_native_owner_is_retained_but_never_mirrored(self):
        for mode in ['no-health', 'missing-fault-field', 'status-unknown', 'foreign-surface', 'no-state']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                result = completed()
                state = result['snapshot']['state']
                if mode == 'no-health':
                    del state['executionHealth']
                elif mode == 'missing-fault-field':
                    del state['executionHealth']['viewFault']
                elif mode == 'status-unknown':
                    state['status'] = 'unknown'
                elif mode == 'foreign-surface':
                    state['hostSurface']['ownerId'] = '3'
                else:
                    del result['snapshot']['state']
                store = driver.InspectionWitnessStore(Path(directory))
                self.record(store, result)
                self.assertEqual(list(Path(directory).glob('*.inspect.json')), [])
                saved = json.loads(next((Path(directory) / 'poll-witnesses').glob('*.snapshot.json')).read_text())
                self.assertEqual(saved, result)
                receipt = json.loads((Path(directory) / 'poll-witnesses/poll-000001.json').read_text())
                self.assertFalse(receipt['publishedForLayoutProof'])
                self.assertEqual(receipt['snapshot']['sha256'], hashlib.sha256(
                    (Path(directory) / receipt['snapshot']['path']).read_bytes()).hexdigest())

    def test_count_bound_fails_without_eviction_or_duplicate_publication(self):
        store = self.store(max_count=1)
        self.record(store)
        before = {p: p.read_bytes() for p in self.out.rglob('*') if p.is_file()}
        with self.assertRaisesRegex(RuntimeError, 'witness.*limit'):
            self.record(store, completed('request2'), request_id='request2')
        self.assertEqual(before, {p: p.read_bytes() for p in self.out.rglob('*') if p.is_file()})

    def test_byte_bound_is_checked_before_any_visible_witness(self):
        store = self.store(max_bytes=16)
        with self.assertRaisesRegex(RuntimeError, 'witness.*limit'):
            self.record(store)
        self.assertEqual(list(self.out.glob('*.inspect.json')), [])
        self.assertEqual(list((self.out / 'poll-witnesses').glob('*.json')), [])

    def test_snapshot_bound_is_checked_before_publication(self):
        store = self.store(max_snapshot_bytes=16)
        with self.assertRaisesRegex(RuntimeError, 'witness.*limit'):
            self.record(store)
        self.assertEqual(list(self.out.glob('*.inspect.json')), [])

    def test_publication_is_atomic_and_failure_cannot_expose_partial_json(self):
        store = self.store()
        real_replace = driver.os.replace
        observed = []

        def replace(source, destination):
            if str(destination).endswith('.inspect.json'):
                self.assertFalse(Path(destination).exists())
                observed.append(json.loads(Path(source).read_text()))
                self.assertEqual(list(self.out.glob('*.inspect.json')), [])
            return real_replace(source, destination)

        with mock.patch.object(driver.os, 'replace', side_effect=replace):
            self.record(store)
        self.assertEqual(observed, [completed()])
        self.assertFalse(list(self.out.rglob('*.part')))

    def test_failed_publication_has_no_visible_witness_and_keeps_originals(self):
        store = self.store()
        with mock.patch.object(driver.os, 'replace', side_effect=OSError('injected disk failure')):
            with self.assertRaisesRegex(OSError, 'injected'):
                self.record(store)
        self.assertEqual(list(self.out.glob('*.inspect.json')), [])
        self.assertEqual(store.count, 0)
        self.assertFalse(list(self.out.rglob('*.part')))

    def test_failed_mirror_retains_auditable_snapshot_but_cannot_publish_partial_proof(self):
        store = self.store()
        real_replace = driver.os.replace

        def replace(source, destination):
            if str(destination).endswith('.inspect.json'):
                raise OSError('injected mirror failure')
            return real_replace(source, destination)

        with mock.patch.object(driver.os, 'replace', side_effect=replace):
            with self.assertRaisesRegex(OSError, 'mirror failure'):
                self.record(store)
        self.assertEqual(list(self.out.glob('*.inspect.json')), [])
        self.assertEqual(store.count, 0)
        receipt = json.loads((self.out / 'poll-witnesses/poll-000001.json').read_text())
        snapshot = self.out / receipt['snapshot']['path']
        self.assertEqual(json.loads(snapshot.read_text()), completed())
        self.assertEqual(hashlib.sha256(snapshot.read_bytes()).hexdigest(), receipt['snapshot']['sha256'])
        self.assertFalse(list(self.out.rglob('*.part')))

    def test_duplicate_request_cannot_replace_the_first_witness(self):
        store = self.store()
        self.record(store)
        with self.assertRaisesRegex(RuntimeError, 'duplicate'):
            self.record(store)
        self.assertEqual(len(list(self.out.glob('*.inspect.json'))), 1)

    def test_successive_polls_are_immutable_ordered_and_account_for_both_copies(self):
        store = self.store()
        self.record(store)
        first = (self.out / 'poll-000001.inspect.json').read_bytes()
        second = completed('request2')
        second['snapshot']['state']['acceptedLayout']['observationId'] = '15'
        self.record(store, second, request_id='request2', started_ns=300,
                    received_ns=400, deadline_ns=500)
        self.assertEqual((self.out / 'poll-000001.inspect.json').read_bytes(), first)
        receipts = [json.loads((self.out / ('poll-witnesses/poll-%06d.json' % value)).read_text())
                    for value in (1, 2)]
        self.assertEqual([receipt['sequence'] for receipt in receipts], [1, 2])
        self.assertLess(receipts[0]['receivedMonotonicNs'], receipts[1]['requestedMonotonicNs'])
        self.assertEqual(store.bytes_written, sum(path.stat().st_size for path in self.out.rglob('*') if path.is_file()))
        self.assertEqual(store.count, 2)

    def test_failed_pending_foreign_or_late_responses_cannot_publish_healthy_proof(self):
        for mode in ['failed', 'pending', 'foreign-request', 'foreign-device', 'late']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                store = driver.InspectionWitnessStore(Path(directory))
                result = completed()
                args = {}
                if mode in ['failed', 'pending']:
                    result['status'] = mode
                elif mode == 'foreign-request':
                    result['requestId'] = 'other'
                elif mode == 'foreign-device':
                    result['deviceId'] = 'other'
                else:
                    args['received_ns'] = 301
                with self.assertRaises(RuntimeError):
                    self.record(store, result, **args)
                self.assertEqual(list(Path(directory).glob('*.inspect.json')), [])

    def test_late_completed_http_response_is_rejected_without_new_poll(self):
        clock = [0]
        runner = self.runner(received=lambda: clock.__setitem__(0, 8_000_000_000))
        with mock.patch.object(driver.time, 'monotonic_ns', side_effect=lambda: clock[0]), \
                mock.patch.object(driver.time, 'monotonic', side_effect=lambda: clock[0] / 1e9):
            with self.assertRaisesRegex(RuntimeError, 'timeout|deadline'):
                runner.inspection()
        self.assertEqual(len(runner.opener.calls), 2)
        self.assertEqual(list(self.out.glob('*.inspect.json')), [])

    def test_foreign_completed_response_is_rejected_without_new_poll(self):
        result = completed('other')
        runner = self.runner(result)
        with self.assertRaisesRegex(RuntimeError, 'request'):
            runner.inspection()
        self.assertEqual(len(runner.opener.calls), 2)
        self.assertEqual(list(self.out.glob('*.inspect.json')), [])


if __name__ == '__main__':
    unittest.main()
