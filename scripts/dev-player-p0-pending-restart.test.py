#!/usr/bin/env python3
"""Pure counterexamples for the bounded, explicit View-restart wait contract."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('p0_existing_tests', Path(__file__).with_name('dev-player-p0-android.test.py'))
existing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(existing)
runner = existing.runner


def fault_context():
    result = existing.fixture()
    result.update(status='completed', requestId='old-inspection', deviceId='owned-device')
    state = result['snapshot']['state']
    state.update(inputEnabled=False, presentationEnabled=False)
    state['executionHealth'].update(requiresRestart=True,
        viewFault={'domain': 'view', 'code': 'ERR_TIMEOUT', 'requiresRestart': True})
    result['snapshot']['pages'][-1]['data'].update(fixtureVersion=1, triggerViewFault=True)
    accepted = state['acceptedPackIdentity']
    result['snapshot']['developmentAttempt'] = {
        'schemaVersion': 1, 'projectId': result['projectId'], 'runId': result['runId'],
        'generation': result['generation'], 'targetRoot': accepted['root'],
        'resolution': 'terminal', 'source': 'event',
        'receipt': {'schemaVersion': 1, 'ownerId': state['ownerId'], 'attemptId': '5',
                    'status': 'accepted', 'operation': 'load', 'targetRoot': accepted['root'],
                    'reloadKind': 'restart', 'expectedAccepted': None,
                    'acceptedPackIdentity': copy.deepcopy(accepted)}}
    return result


def pending(context=None, attempt_id='6'):
    context = context or fault_context()
    result = {key: copy.deepcopy(context[key]) for key in
              ('status', 'requestId', 'deviceId', 'projectId', 'runId', 'generation')}
    result['requestId'] = 'pending-inspection'
    attempt = copy.deepcopy(context['snapshot']['developmentAttempt'])
    attempt.update(resolution='pending', source='begin')
    attempt['receipt'].update(attemptId=attempt_id, status='prepared', operation='applyDevPack',
        expectedAccepted=copy.deepcopy(context['snapshot']['state']['acceptedPackIdentity']))
    result['snapshot'] = {'pages': [], 'acceptedPack': None, 'developmentAttempt': attempt}
    return result


def healthy():
    result = existing.fixture()
    result.update(status='completed', requestId='new-inspection', deviceId='owned-device')
    state = result['snapshot']['state']
    state['sessionId'] = 'session-two'
    state['acceptedPackIdentity'].update(sessionId='session-two', acceptedPackRevision='3')
    state['acceptedLayout']['chrome']['sessionId'] = 'session-two'
    geometry = {'window': state['acceptedLayout']['windowMetrics'],
                'capsule': state['acceptedLayout']['chrome']['menuButtonRect']}
    result['snapshot']['pages'][-1]['data'].update(fixtureVersion=1, triggerViewFault=False,
        events=[json.dumps({'event': 'onLoad', 'sequence': 1, 'geometry': 0})],
        geometries=[json.dumps(geometry)])
    attempt = pending()['snapshot']['developmentAttempt']
    attempt.update(resolution='terminal', source='apply')
    attempt['receipt'].update(status='accepted', acceptedPackIdentity=copy.deepcopy(state['acceptedPackIdentity']))
    result['snapshot']['developmentAttempt'] = attempt
    return result


class Clock:
    def __init__(self):
        self.now = 100.0
        self.sleeps = []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class PendingRestart(unittest.TestCase):
    def harness(self, samples, repeated=None):
        item = runner.Runner.__new__(runner.Runner)
        item.args = SimpleNamespace(device_id='owned-device')
        item.last_page = fault_context()
        item.layout_observations = {}
        item.calls = []
        item.samples = iter(samples)
        item.native_reads = []
        clock = Clock()

        def api(path):
            self.assertEqual(path, '/state', 'The wait must not make a mutation request')
            item.calls.append(('read', path))
            return {'devices': [{'id': 'owned-device', 'connected': True}]}

        def inspection():
            item.calls.append(('inspection', clock.now))
            clock.now += .02
            try:
                sample = next(item.samples)
            except StopIteration:
                if repeated is None:
                    self.fail('The wait requested an unexpected inspection')
                sample = repeated
            if isinstance(sample, Exception):
                raise sample
            return copy.deepcopy(sample)

        def observe(result):
            item.native_reads.append(len([call for call in item.calls if call[0] == 'inspection']))
            result['nativeObservation'] = {'unitTest': 'independent-read-required'}

        item.api, item.inspection, item.observe_native_geometry = api, inspection, observe
        item.adb = lambda *args, **kwargs: self.fail('A wait must not issue reload/input/ADB operations')
        return item, clock

    def run_wait(self, item, clock, **kwargs):
        with mock.patch.object(runner, 'time', SimpleNamespace(monotonic=clock.monotonic, sleep=clock.sleep)):
            return item.wait_page('home', **kwargs)

    def test_exact_pending_metadata_is_only_a_wait_reason(self):
        context, result = fault_context(), pending()
        self.assertEqual(runner.require_pending_view_restart(context, result, 'owned-device'),
                         ('17', '6', 'a' * 64, '2', 'session-one'))
        with self.assertRaisesRegex(RuntimeError, 'Typed native SDK state'):
            runner.presentation_identity(result)

    def test_metadata_identity_schema_error_and_terminal_counterexamples(self):
        cases = [
            (('status',), 'pending'), (('status',), 'error'), (('requestId',), ''),
            (('requestId',), 'old-inspection'), (('deviceId',), 'foreign-device'),
            (('projectId',), 'd' * 32), (('runId',), 'e' * 32), (('generation',), '3'),
            (('error',), 'ERR_ENGINE'), (('snapshot', 'pages'), None),
            (('snapshot', 'pages'), [{}]), (('snapshot', 'state'), None),
            (('snapshot', 'acceptedPack'), {}),
            (('snapshot', 'developmentAttempt', 'schemaVersion'), True),
            (('snapshot', 'developmentAttempt', 'schemaVersion'), 2),
            (('snapshot', 'developmentAttempt', 'projectId'), 'd' * 32),
            (('snapshot', 'developmentAttempt', 'runId'), 'e' * 32),
            (('snapshot', 'developmentAttempt', 'generation'), '3'),
            (('snapshot', 'developmentAttempt', 'targetRoot'), 'd' * 64),
            (('snapshot', 'developmentAttempt', 'resolution'), 'unknown'),
            (('snapshot', 'developmentAttempt', 'resolution'), 'terminal'),
            (('snapshot', 'developmentAttempt', 'source'), 'event'),
            (('snapshot', 'developmentAttempt', 'receipt', 'schemaVersion'), True),
            (('snapshot', 'developmentAttempt', 'receipt', 'ownerId'), '18'),
            (('snapshot', 'developmentAttempt', 'receipt', 'ownerId'), 17),
            (('snapshot', 'developmentAttempt', 'receipt', 'attemptId'), '5'),
            (('snapshot', 'developmentAttempt', 'receipt', 'attemptId'), '4'),
            (('snapshot', 'developmentAttempt', 'receipt', 'attemptId'), '06'),
            (('snapshot', 'developmentAttempt', 'receipt', 'attemptId'), 6),
            (('snapshot', 'developmentAttempt', 'receipt', 'attemptId'), '18446744073709551616'),
            (('snapshot', 'developmentAttempt', 'receipt', 'status'), 'applying'),
            (('snapshot', 'developmentAttempt', 'receipt', 'status'), 'accepted'),
            (('snapshot', 'developmentAttempt', 'receipt', 'status'), 'rejected'),
            (('snapshot', 'developmentAttempt', 'receipt', 'operation'), 'load'),
            (('snapshot', 'developmentAttempt', 'receipt', 'reloadKind'), 'hotUpdate'),
            (('snapshot', 'developmentAttempt', 'receipt', 'targetRoot'), 'd' * 64),
            (('snapshot', 'developmentAttempt', 'receipt', 'expectedAccepted'), None),
            (('snapshot', 'developmentAttempt', 'receipt', 'expectedAccepted', 'root'), 'd' * 64),
            (('snapshot', 'developmentAttempt', 'receipt', 'expectedAccepted', 'sessionId'), 'foreign'),
            (('snapshot', 'developmentAttempt', 'receipt', 'expectedAccepted', 'acceptedPackRevision'), '3'),
            (('snapshot', 'developmentAttempt', 'receipt', 'acceptedPackIdentity', 'sessionId'), 'foreign'),
            (('snapshot', 'developmentAttempt', 'receipt', 'acceptedPackIdentity', 'acceptedPackRevision'), '3'),
            (('snapshot', 'developmentAttempt', 'receipt', 'error'), {'code': 'ERR_ENGINE'}),
            (('snapshot', 'developmentAttempt', 'receipt', 'observationErrors'), [{'code': 'ERR_ENGINE'}]),
        ]
        for path, value in cases:
            wrong = pending()
            parent = wrong
            for key in path[:-1]:
                parent = parent[key]
            parent[path[-1]] = value
            with self.subTest(path=path, value=value), self.assertRaises(RuntimeError):
                runner.require_pending_view_restart(fault_context(), wrong, 'owned-device')
        for key in ('pages', 'acceptedPack', 'developmentAttempt'):
            wrong = pending()
            wrong['snapshot'].pop(key)
            with self.subTest(missing=key), self.assertRaises(RuntimeError):
                runner.require_pending_view_restart(fault_context(), wrong, 'owned-device')

    def test_fault_context_cannot_be_healthy_foreign_or_a_non_fixture_timeout(self):
        cases = [
            (('deviceId',), 'foreign-device'), (('status',), 'error'),
            (('snapshot', 'pages', -1, 'data', 'triggerViewFault'), False),
            (('snapshot', 'pages', -1, 'data', 'fixtureVersion'), 2),
            (('snapshot', 'state', 'executionHealth', 'requiresRestart'), False),
            (('snapshot', 'state', 'executionHealth', 'appServiceFault'), {'code': 'ERR_ENGINE'}),
            (('snapshot', 'state', 'inputEnabled'), True),
            (('snapshot', 'state', 'presentationEnabled'), True),
            (('snapshot', 'state', 'foreground'), False),
            (('snapshot', 'developmentAttempt', 'resolution'), 'unknown'),
            (('snapshot', 'developmentAttempt', 'receipt', 'status'), 'prepared'),
            (('snapshot', 'developmentAttempt', 'receipt', 'ownerId'), '18'),
            (('snapshot', 'developmentAttempt', 'receipt', 'acceptedPackIdentity', 'sessionId'), 'foreign'),
        ]
        for path, value in cases:
            context = fault_context()
            parent = context
            for key in path[:-1]:
                parent = parent[key]
            parent[path[-1]] = value
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                runner.require_pending_view_restart(context, pending(), 'owned-device')

    def test_pending_then_strict_healthy_settle_still_needs_native_and_final_reads(self):
        item, clock = self.harness([pending(), healthy(), healthy(), healthy()])
        result = self.run_wait(item, clock, restart_after=fault_context())
        self.assertEqual(runner.presentation_identity(result)[0], 'session-two')
        self.assertEqual(item.native_reads, [3])
        self.assertEqual(len([call for call in item.calls if call[0] == 'inspection']), 4)
        self.assertEqual(result['nativeObservation']['unitTest'], 'independent-read-required')
        self.assertIs(item.last_page, result)

    def test_pending_breaks_two_sample_stability(self):
        item, clock = self.harness([healthy(), pending(), healthy(), healthy(), healthy()])
        self.run_wait(item, clock, restart_after=fault_context())
        self.assertEqual(item.native_reads, [4])

    def test_empty_page_without_explicit_context_remains_an_immediate_failure(self):
        item, clock = self.harness([pending()])
        with self.assertRaisesRegex(RuntimeError, 'No active page'):
            self.run_wait(item, clock)
        self.assertEqual(len(item.calls), 2)
        self.assertEqual(clock.sleeps, [])

    def test_arbitrary_empty_metadata_is_never_swallowed_with_explicit_context(self):
        for result in ({'snapshot': {'pages': []}}, {'snapshot': {}},
                       {'status': 'completed', 'snapshot': {'pages': [], 'state': None}}):
            item, clock = self.harness([result])
            with self.subTest(result=result), self.assertRaises(RuntimeError):
                self.run_wait(item, clock, restart_after=fault_context())
            self.assertEqual(clock.sleeps, [])

    def test_pending_attempt_cannot_switch_to_another_new_attempt(self):
        item, clock = self.harness([pending(), pending(attempt_id='7')])
        with self.assertRaisesRegex(RuntimeError, 'changed native attempt'):
            self.run_wait(item, clock, restart_after=fault_context())
        self.assertEqual(item.native_reads, [])

    def test_infinite_pending_uses_the_original_fifteen_second_deadline_once(self):
        item, clock = self.harness([], repeated=pending())
        with self.assertRaisesRegex(RuntimeError, 'Exact prepared View restart remains pending'):
            self.run_wait(item, clock, restart_after=fault_context())
        self.assertGreaterEqual(clock.now, 115)
        self.assertLess(clock.now, 115.18)
        self.assertEqual(item.native_reads, [])
        self.assertTrue(all(0 < duration <= .15 for duration in clock.sleeps))

    def test_pending_does_not_allow_a_damaged_or_wrong_final_frame(self):
        for defect in ('fault', 'owner', 'geometry'):
            result = healthy()
            if defect == 'fault':
                result['snapshot']['state']['inputEnabled'] = False
            elif defect == 'owner':
                result['snapshot']['state']['hostSurface']['ownerId'] = '18'
            else:
                geometries = result['snapshot']['pages'][-1]['data']['geometries']
                wrong = json.loads(geometries[0])
                wrong['capsule']['top'] += 5
                geometries[0] = json.dumps(wrong)
            item, clock = self.harness([pending()], repeated=result)
            with self.subTest(defect=defect), self.assertRaisesRegex(RuntimeError, 'Stable presented page'):
                self.run_wait(item, clock, restart_after=fault_context())
            self.assertEqual(item.native_reads, [])

    def test_unknown_inspector_error_is_immediate_and_same_session_layout_mode_cannot_mix(self):
        item, clock = self.harness([RuntimeError('ERR_ENGINE unrelated fault')])
        with self.assertRaisesRegex(RuntimeError, 'ERR_ENGINE'):
            self.run_wait(item, clock, restart_after=fault_context())
        self.assertEqual(clock.sleeps, [])
        item, clock = self.harness([])
        with self.assertRaisesRegex(RuntimeError, 'same-session layout'):
            self.run_wait(item, clock, after=healthy(), restart_after=fault_context())
        self.assertEqual(item.calls, [])


if __name__ == '__main__':
    unittest.main()
