#!/usr/bin/env python3
"""No-device counterexamples for the actual Android P0 evidence validators."""
import copy
import importlib.util
import io
import json
import stat
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('player_android_p0', Path(__file__).with_name('dev-player-p0-android.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def fixture():
    metrics = {'windowWidth': 400, 'windowHeight': 700, 'pixelRatio': 3, 'screenWidth': 400,
               'screenHeight': 850, 'statusBarHeight': 24, 'screenTop': 72, 'deviceOrientation': 'portrait',
               'safeArea': {'left': 0, 'right': 400, 'top': 24, 'bottom': 826, 'width': 400, 'height': 802}}
    chrome = {'schemaVersion': 1, 'revision': 9, 'sessionId': 'session-one', 'pageId': 1,
              'contentRect': {'left': 0, 'top': 72, 'width': 400, 'height': 700},
              'menuButtonRect': {'left': 304, 'right': 392, 'top': 32, 'bottom': 64, 'width': 88, 'height': 32}}
    state = {'schemaVersion': 1, 'status': 'ready', 'sessionId': 'session-one', 'ownerId': '17',
             'acceptedPackIdentity': {'root': 'a' * 64, 'acceptedPackRevision': '2', 'sessionId': 'session-one'},
             'page': {'id': 1, 'route': 'pages/home/index'}, 'frameId': 7, 'frameRevision': 8,
             'foreground': True, 'inputEnabled': True, 'presentationEnabled': True, 'previewOccluded': False,
             'executionHealth': {'schemaVersion': 1, 'appServiceFault': None, 'viewFault': None,
                                 'navigationFault': None, 'requiresRestart': False},
             'hostSurface': {'ownerId': '17', 'surfaceGeneration': '4'},
             'acceptedLayout': {'schemaVersion': 1, 'ownerId': '17', 'surfaceGeneration': '4',
                                'observationId': '6', 'layoutRevision': '9', 'windowMetrics': metrics, 'chrome': chrome},
             'pendingHostLayout': None, 'pendingNavigation': None, 'chromeGeometryReady': True,
             'viewport': {'width': 400, 'height': 700}, 'observedViewport': {'width': 400, 'height': 700}}
    return {'projectId': 'b' * 32, 'runId': 'c' * 32, 'generation': '2', 'snapshot': {'state': state,
            'acceptedPack': {'projectId': 'b' * 32, 'runId': 'c' * 32, 'generation': '2', 'root': 'a' * 64},
            'pages': [{'id': 1, 'route': 'pages/home/index', 'data': {}}]}}


class EvidenceValidators(unittest.TestCase):
    def test_native_raw_evidence_is_private_exact_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory(prefix='p0-private-raw-unit-') as directory:
            path = Path(directory) / 'native.window.zip'
            raw = b'raw-native-evidence\x00\xff'
            runner.write_private_raw(path, raw)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(path.read_bytes(), raw)
            with self.assertRaises(FileExistsError):
                runner.write_private_raw(path, b'must-not-replace-original')
            self.assertEqual(path.read_bytes(), raw)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_installed_apk_paths_accept_modern_and_legacy_literal_components(self):
        for path in ('/data/app/~~hash_+==/dev.weapp.player-hash_+==/base.apk',
                     '/data/app/dev.weapp.player-1/base.apk', '/data/app/dev.weapp.player-1.apk'):
            self.assertEqual(runner.installed_apk_path(path), path)
        for path in ('/data/app/../x.apk', '/data/app/./x.apk', '/data/app//x.apk',
                     '/data/app/x/../../x.apk', '/data/app/x\n.apk', '/data/app/x\r.apk',
                     '/data/app/x\x00.apk', '/data/app/x y.apk', '/data/app/x;id.apk',
                     '/data/app/$(id).apk', '/data/app/`id`.apk', '/data/app/"x".apk',
                     '/data/app/x&y.apk', '/data/app/x|y.apk', '/tmp/x.apk',
                     '/data/app/' + 'a' * 2048 + '.apk'):
            with self.subTest(path=repr(path)), self.assertRaisesRegex(RuntimeError, 'bounded'):
                runner.installed_apk_path(path)

    def test_preflight_capture_has_no_synthetic_inspector_or_uninitialized_auth(self):
        with tempfile.TemporaryDirectory(prefix='p0-capture-unit-') as directory:
            item = runner.Runner.__new__(runner.Runner)
            item.out, item.index, item.secret = Path(directory), 0, None
            item.ui = lambda: ('<hierarchy/>', None)
            item.adb = lambda *args, **kwargs: b'unit-test-image-placeholder'
            def forbidden(*args, **kwargs):
                self.fail('Uninitialized admin API must not be called')
            item.api = forbidden
            base = item.capture('preflight')
            self.assertFalse(base.with_suffix('.state.json').exists())
            self.assertFalse(base.with_suffix('.inspect.json').exists())
            self.assertEqual(json.loads(base.with_suffix('.capture.json').read_text())['adminState'], 'not-attempted')

    def test_plan_names_fixture_contract_without_claiming_runtime_version(self):
        self.assertEqual(runner.PLAN['fixtureContract'], 'p0-fixed-controls-v1')
        self.assertNotIn('sdkSourceVersion', runner.PLAN)
        self.assertIn('external reviewed Player build receipt', runner.PLAN['runtimeIdentity'])

    def test_no_native_state_or_phase_only_is_never_presented(self):
        with self.assertRaises(RuntimeError):
            runner.presentation_identity({'phase': 'presented', 'snapshot': {'pages': []}})
        result = fixture()
        result['snapshot']['state']['inputEnabled'] = False
        result['phase'] = 'presented'
        with self.assertRaisesRegex(RuntimeError, 'not interactively presented'):
            runner.presentation_identity(result)

    def test_owner_surface_page_and_session_are_exact(self):
        for path, value in ((('hostSurface', 'ownerId'), '18'), (('hostSurface', 'surfaceGeneration'), '5'),
                            (('acceptedPackIdentity', 'sessionId'), 'stale-session'),
                            (('acceptedLayout', 'chrome', 'pageId'), 2),
                            (('acceptedLayout', 'chrome', 'sessionId'), 'stale-session')):
            result = fixture()
            parent = result['snapshot']['state']
            for key in path[:-1]:
                parent = parent[key]
            parent[path[-1]] = value
            with self.assertRaises(RuntimeError, msg=str(path)):
                runner.presentation_identity(result)

    def test_native_density_and_painted_capsule_are_independent_of_guest_viewport(self):
        observed = runner.validate_native_geometry(fixture(), (0, 216, 1200, 2316), (912, 78, 1176, 210), 3)
        self.assertEqual(observed['density'], 3)
        self.assertEqual(runner.android_density('Physical density: 480\nOverride density: 320\n'), 2)
        with self.assertRaises(RuntimeError):
            runner.android_density('density: unverified')
        with self.assertRaisesRegex(RuntimeError, 'pixelRatio'):
            runner.validate_native_geometry(fixture(), (0, 216, 1200, 2316), (912, 78, 1176, 210), 2)
        with self.assertRaisesRegex(RuntimeError, 'vertical center'):
            runner.validate_native_geometry(fixture(), (0, 216, 1200, 2316), (912, 90, 1176, 222), 3)

    def test_proportional_wrong_logical_viewport_cannot_self_normalize_to_pass(self):
        result = fixture()
        state = result['snapshot']['state']
        state['acceptedLayout']['chrome']['contentRect'].update(width=200, height=350)
        state['acceptedLayout']['windowMetrics'].update(windowWidth=200, windowHeight=350)
        state['viewport'] = state['observedViewport'] = {'width': 200, 'height': 350}
        # The old runner derived 1200/200 == 2100/350 == 6 and accepted this.
        # Actual Android density remains 3, so this must fail independently.
        with self.assertRaisesRegex(RuntimeError, 'surface width'):
            runner.validate_native_geometry(result, (0, 216, 1200, 2316), (912, 78, 1176, 210), 3)

    def test_a_to_b_to_a_needs_fresh_observation_and_layout_even_for_identical_geometry(self):
        old = fixture()
        with self.assertRaisesRegex(RuntimeError, 'stale'):
            runner.require_fresh_layout(old, copy.deepcopy(old))
        new = copy.deepcopy(old)
        new['snapshot']['state']['acceptedLayout'].update(observationId='7', layoutRevision='10')
        runner.require_fresh_layout(old, new)
        new['snapshot']['state']['acceptedLayout']['layoutRevision'] = '9'
        with self.assertRaisesRegex(RuntimeError, 'stale'):
            runner.require_fresh_layout(old, new)

    def test_guest_initial_geometry_is_compared_to_authoritative_destination(self):
        result = fixture()
        layout = result['snapshot']['state']['acceptedLayout']
        geometry = {'window': copy.deepcopy(layout['windowMetrics']), 'capsule': copy.deepcopy(layout['chrome']['menuButtonRect'])}
        runner.require_guest_geometry(result, geometry)
        geometry['capsule']['top'] += 4
        with self.assertRaisesRegex(RuntimeError, 'capsule.top'):
            runner.require_guest_geometry(result, geometry)

    def test_unrelated_history_timeout_or_another_fault_cannot_pass_view_interruption(self):
        before = fixture()
        unrelated = copy.deepcopy(before)
        unrelated['history'] = [{'deviceId': 'another-device', 'code': 'ERR_TIMEOUT'}]
        unrelated['snapshot']['state'].update(inputEnabled=False, presentationEnabled=False)
        with self.assertRaisesRegex(RuntimeError, 'isolated typed View timeout'):
            runner.require_view_fault(before, unrelated)
        state = unrelated['snapshot']['state']
        state['executionHealth']['requiresRestart'] = True
        state['executionHealth']['viewFault'] = {'domain': 'view', 'code': 'ERR_TIMEOUT', 'requiresRestart': True}
        runner.require_view_fault(before, unrelated)
        state['executionHealth']['appServiceFault'] = {'domain': 'appService', 'code': 'ERR_ENGINE', 'requiresRestart': True}
        with self.assertRaisesRegex(RuntimeError, 'isolated typed View timeout'):
            runner.require_view_fault(before, unrelated)

    def test_lossless_sdk_identities_never_accept_numbers_or_overflow(self):
        self.assertEqual(runner.decimal('18446744073709551615'), 18446744073709551615)
        for invalid in (1, '01', '0', '18446744073709551616'):
            with self.assertRaises(RuntimeError):
                runner.decimal(invalid)
        self.assertIn('C018 candidate rejection', runner.PLAN['notClaimed'])

    def test_c018_needs_the_actual_terminal_rejected_distinct_candidate(self):
        baseline = fixture()
        candidate = {'projectId': baseline['projectId'], 'runId': baseline['runId'], 'generation': '3', 'integrityRoot': 'd' * 64}
        observed = copy.deepcopy(baseline)
        observed['generation'] = '3'  # request generation is not page ownership
        accepted = baseline['snapshot']['state']['acceptedPackIdentity']
        attempt = {'schemaVersion': 1, 'projectId': baseline['projectId'], 'runId': baseline['runId'],
                   'generation': '3', 'targetRoot': 'd' * 64, 'resolution': 'terminal', 'source': 'event',
                   'receipt': {'schemaVersion': 1, 'ownerId': '17', 'attemptId': '9', 'status': 'rejected',
                               'operation': 'applyDevPack', 'targetRoot': 'd' * 64, 'reloadKind': 'restart',
                               'expectedAccepted': accepted, 'acceptedPackIdentity': accepted,
                               'error': {'code': 'ERR_ENGINE', 'message': 'P0_CANDIDATE_STARTUP_FAILURE'}}}
        observed['snapshot']['developmentAttempt'] = copy.deepcopy(attempt)
        runner.require_candidate_rejection(baseline, observed, candidate)
        for path, value in ((('resolution',), 'unknown'), (('resolution',), 'pending'),
                            (('generation',), '2'), (('targetRoot',), 'a' * 64),
                            (('receipt', 'status'), 'accepted'), (('receipt', 'ownerId'), '18'),
                            (('receipt', 'error', 'message'), 'unrelated cancellation')):
            wrong = copy.deepcopy(observed)
            parent = wrong['snapshot']['developmentAttempt']
            for key in path[:-1]:
                parent = parent[key]
            parent[path[-1]] = value
            with self.assertRaises(RuntimeError, msg=str(path)):
                runner.require_candidate_rejection(baseline, wrong, candidate)
        observed['snapshot'].pop('developmentAttempt')
        with self.assertRaisesRegex(RuntimeError, 'actual Player-observed'):
            runner.require_candidate_rejection(baseline, observed, candidate)

    def test_request_generation_cannot_relabel_old_pages_as_candidate(self):
        baseline = fixture()
        wrong = copy.deepcopy(baseline)
        wrong['generation'] = '3'
        wrong['snapshot']['acceptedPack']['root'] = 'd' * 64
        with self.assertRaisesRegex(RuntimeError, 'publication provenance'):
            runner.presentation_identity(wrong)
        missing = copy.deepcopy(baseline)
        del missing['snapshot']['acceptedPack']
        with self.assertRaisesRegex(RuntimeError, 'publication provenance'):
            runner.presentation_identity(missing)

    def test_closed_runtime_inspector_rejection_remains_typed_instead_of_key_error(self):
        instance = runner.Runner.__new__(runner.Runner)
        instance.args = SimpleNamespace(admin='http://127.0.0.1:51791', device_id='owned-device')
        instance.secret = 'not-a-real-secret'

        class RejectedEndpoint:
            def open(self, request, timeout):
                raise runner.urllib.error.HTTPError(request.full_url, 400, 'bad request', {},
                    io.BytesIO(b'{"error":"ERR_DEV_NOT_STARTED"}'))

        instance.opener = RejectedEndpoint()
        with self.assertRaisesRegex(RuntimeError, 'ERR_DEV_NOT_STARTED'):
            instance.inspection()

    def test_every_resize_callback_is_atomic_even_when_final_geometry_is_good(self):
        before = fixture()
        old = before['snapshot']['state']['acceptedLayout']
        old_geometry = {'window': old['windowMetrics'], 'capsule': old['chrome']['menuButtonRect']}
        journal = {'schemaVersion': 1, 'events': [json.dumps([1, 'home', 1, 'onLoad', 0, None])],
                   'geometries': [json.dumps(old_geometry)]}
        before['snapshot']['pages'][-1]['data']['journal'] = journal
        after = copy.deepcopy(before)
        new = after['snapshot']['state']['acceptedLayout']
        new.update(observationId='7', layoutRevision='10')
        new['windowMetrics'].update(windowWidth=700, windowHeight=400, deviceOrientation='landscape')
        new['chrome']['menuButtonRect'].update(left=604, right=692)
        geometry = {'window': new['windowMetrics'], 'capsule': new['chrome']['menuButtonRect']}
        after_journal = after['snapshot']['pages'][-1]['data']['journal']
        after_journal['geometries'].append(json.dumps(geometry))
        after_journal['events'].append(json.dumps([2, 'home', 1, 'onResize', 1,
            {'size': {'size': {'windowWidth': 700, 'windowHeight': 400}}}]))
        self.assertEqual(runner.require_resize_journal(before, after, [new]), 1)
        for bad_geometry, bad_size in (({'window': geometry['window'], 'capsule': old_geometry['capsule']}, (700, 400)),
                                       (old_geometry, (400, 700)), (geometry, (400, 700))):
            wrong = copy.deepcopy(after)
            j = wrong['snapshot']['pages'][-1]['data']['journal']
            j['geometries'][1] = json.dumps(bad_geometry)
            j['events'][1] = json.dumps([2, 'home', 1, 'onResize', 1,
                {'size': {'size': dict(zip(('windowWidth', 'windowHeight'), bad_size))}}])
            with self.assertRaises(RuntimeError):
                runner.require_resize_journal(before, wrong, [new])
        wrong = copy.deepcopy(after)
        wrong['snapshot']['pages'][-1]['data']['journal']['events'].pop()
        with self.assertRaisesRegex(RuntimeError, 'no retained onResize'):
            runner.require_resize_journal(before, wrong, [new])


class CycleBoundaryHarness:
    """Pure platform double: exercise the canonical cycles and real validators.

    Native orientation comes from this independent display model. The tested
    runner must request the right direction; the double never derives its actual
    state from the direction requested by wait_page.
    """
    def __init__(self, test, natural_portrait, postures):
        self.test, self.natural_portrait, self.rotation = test, natural_portrait, 0
        self.value = fixture()
        self.sequence, self.revision, self.next_instance = 0, 9, 1
        self.journal = {'schemaVersion': 1, 'events': [], 'geometries': []}
        self.pages, self.waits, self.captures = [], [], []
        self.item = runner.Runner.__new__(runner.Runner)
        self.item.args = SimpleNamespace(cycles=10, postures=postures)
        self.item.report = {'deviceAssociation': {'status': 'passed'}}
        self.item.assert_ = lambda condition, label: test.assertTrue(condition, label)
        self.item.wait_page, self.item.adb = self.wait_page, self.adb
        self.item.observe_native_geometry = lambda value: copy.deepcopy(value['nativeObservation'])
        self.item.target = lambda value, identifier: (24, 36)
        self.item.tap, self.item.capture = self.tap, self.capture
        self.item.save = lambda: None
        self.install('home', initial=True)

    def geometry(self):
        layout = self.value['snapshot']['state']['acceptedLayout']
        return {'window': copy.deepcopy(layout['windowMetrics']),
                'capsule': copy.deepcopy(layout['chrome']['menuButtonRect'])}

    def append(self, page, event, detail=None):
        self.sequence += 1
        data, geometry = page['data'], self.geometry()
        encoded = json.dumps(geometry, sort_keys=True)
        for values in (data['geometries'], self.journal['geometries']):
            if encoded not in values:
                values.append(encoded)
        own_index = data['geometries'].index(encoded)
        global_index = self.journal['geometries'].index(encoded)
        record = {'sequence': self.sequence, 'event': event, 'geometry': own_index, 'detail': detail}
        data['events'].append(json.dumps(record))
        self.journal['events'].append(json.dumps([self.sequence, data['kind'], data['instance'], event, global_index, detail]))
        if not data['first']:
            data['first'] = copy.deepcopy(record)

    def update_layout(self):
        self.revision += 1
        portrait = self.natural_portrait != bool(self.rotation % 2)
        width, height = (400, 850) if portrait else (850, 400)
        state = self.value['snapshot']['state']
        page = self.pages[-1]
        top = 0 if page['data']['kind'] == 'custom' else 72
        metrics = state['acceptedLayout']['windowMetrics']
        metrics.update(windowWidth=width, windowHeight=height-top, screenWidth=width, screenHeight=height,
                       screenTop=top, deviceOrientation='portrait' if portrait else 'landscape',
                       safeArea={'left': 0, 'right': width, 'top': 24, 'bottom': height-24,
                                 'width': width, 'height': height-48})
        chrome = state['acceptedLayout']['chrome']
        chrome.update(pageId=page['id'])
        chrome['contentRect'].update(left=0, top=top, width=width, height=height-top)
        chrome['menuButtonRect'].update(left=width-96, right=width-8)
        state['page'] = {'id': page['id'], 'route': page['route']}
        state['acceptedLayout'].update(observationId=str(self.revision), layoutRevision=str(self.revision))
        state['viewport'] = state['observedViewport'] = {'width': width, 'height': height-top}
        self.value['nativeObservation'] = {'density': 3, 'surfacePhysical': [0, top*3, width*3, height*3],
            'nativeWitness': {'display': {'schemaVersion': 1, 'displayId': int(self.natural_portrait),
                'rotation': self.rotation, 'orientation': metrics['deviceOrientation'],
                'boundsPhysical': [0, 0, width*3, height*3]}}}

    def install(self, kind, initial=False):
        if not initial:
            self.append(self.pages[-1], 'onHide')
        instance = self.next_instance
        self.next_instance += 1
        page = {'id': instance, 'route': runner.ROUTES[kind], 'data': {'fixtureVersion': 1,
            'kind': kind, 'instance': instance, 'count': 0, 'events': [], 'geometries': [], 'first': None}}
        self.pages.append(page)
        self.update_layout()
        for name in ('onLoad', 'onShow', 'onReady'):
            self.append(page, name)

    def snapshot(self):
        result = copy.deepcopy(self.value)
        result['snapshot']['pages'] = copy.deepcopy(self.pages)
        for page in result['snapshot']['pages']:
            page['data']['journal'] = copy.deepcopy(self.journal)
        return result

    def wait_page(self, route, orientation=None, after=None, display_rotation=None):
        result = self.snapshot()
        actual = runner.native_state(result)['acceptedLayout']['windowMetrics']['deviceOrientation']
        self.test.assertEqual(self.pages[-1]['route'], runner.ROUTES[route])
        if orientation is not None:
            self.test.assertEqual(orientation, actual, 'Canonical navigation must retain the actual completed orientation')
        if after is not None:
            runner.require_fresh_layout(after, result)
        if display_rotation is not None:
            runner.require_observed_rotation(result['nativeObservation']['nativeWitness']['display'], display_rotation)
        runner.presentation_identity(result)
        self.waits.append({'route': route, 'expected': orientation, 'actual': actual, 'rotation': self.rotation,
                           'naturalPortrait': self.natural_portrait, 'fresh': after is not None})
        return result

    def adb(self, *args):
        if args[:5] == ('shell', 'settings', 'put', 'system', 'user_rotation'):
            rotation = int(args[5])
            changed = self.rotation != rotation
            self.rotation = rotation
        else:
            self.test.assertEqual(args[:4], ('shell', 'cmd', 'device_state', 'state'))
            natural_portrait = bool(int(args[4]))
            changed = self.natural_portrait != natural_portrait
            self.natural_portrait = natural_portrait
        if changed:
            self.update_layout()
            self.append(self.pages[-1], 'onResize', {'size': {'windowWidth': self.geometry()['window']['windowWidth'],
                                                            'windowHeight': self.geometry()['window']['windowHeight']}})
        return ''

    def tap(self, before, identifier):
        page = self.pages[-1]
        if identifier == 'p0-increment':
            self.append(page, 'increment.begin', {'x': 24, 'y': 36})
            page['data']['count'] += 1
            self.append(page, 'increment.callback')
            self.append(page, 'increment.return')
            observed = before['nativeObservation']
            x0, y0, _, _ = observed['surfacePhysical']
            self.item.last_tap = {'physical': [x0+72, y0+108], 'nativeObservation': observed}
        elif identifier in ('p0-custom', 'p0-normal'):
            self.install('custom' if identifier == 'p0-custom' else 'detail')
        else:
            self.test.assertEqual(identifier, 'p0-back')
            self.append(page, 'navigateBack')
            self.append(page, 'onUnload')
            retired = copy.deepcopy(self.pages.pop()['data'])
            self.update_layout()
            self.pages[-1]['data']['lastRetired'] = retired
            self.append(self.pages[-1], 'onShow')

    def capture(self, name, result=None):
        self.captures.append((name, copy.deepcopy(result)))


class RotationCommandBoundary(unittest.TestCase):
    def test_rotate_derives_expectation_from_fresh_actual_witness_and_confirms_target(self):
        for actual, requested, portrait in ((0, 0, True), (0, 0, False), (0, 1, False),
                                            (1, 0, True), (0, 2, True), (3, 1, False)):
            with self.subTest(actual=actual, requested=requested, portrait=portrait):
                before = fixture()
                metrics = before['snapshot']['state']['acceptedLayout']['windowMetrics']
                width, height = (1200, 2400) if portrait else (2400, 1200)
                orientation = 'portrait' if portrait else 'landscape'
                metrics.update(deviceOrientation=orientation, screenWidth=width / 3, screenHeight=height / 3)
                observed = {'density': 3, 'nativeWitness': {'display': {'schemaVersion': 1, 'displayId': 0,
                    'rotation': actual, 'orientation': orientation, 'boundsPhysical': [0, 0, width, height]}}}
                item = runner.Runner.__new__(runner.Runner)
                calls = []
                item.observe_native_geometry = lambda value: calls.append(('native', value)) or observed
                item.adb = lambda *args: calls.append(('adb', args)) or ''
                item.wait_page = lambda *args, **kwargs: calls.append(('wait', args, kwargs)) or 'sentinel'
                self.assertEqual(item.rotate(requested, 'home', before), 'sentinel')
                self.assertEqual([x[0] for x in calls], ['native', 'adb', 'wait'])
                self.assertIs(calls[0][1], before)
                self.assertEqual(calls[1][1], ('shell', 'settings', 'put', 'system', 'user_rotation', str(requested)))
                expected = orientation if (requested - actual) % 2 == 0 else ('landscape' if portrait else 'portrait')
                self.assertEqual(calls[2][1], ('home', expected))
                self.assertEqual(calls[2][2]['display_rotation'], requested)
                self.assertIs(calls[2][2]['after'], before if actual != requested else None)

    def test_wait_requires_actual_requested_rotation_within_original_fifteen_second_budget(self):
        result = fixture()
        state = result['snapshot']['state']
        geometry = {'window': state['acceptedLayout']['windowMetrics'],
                    'capsule': state['acceptedLayout']['chrome']['menuButtonRect']}
        result['snapshot']['pages'][-1]['data'].update(fixtureVersion=1,
            events=[json.dumps({'event': 'onLoad', 'sequence': 1, 'geometry': 0})],
            geometries=[json.dumps(geometry)])
        for requested in (0, 2):
            item = runner.Runner.__new__(runner.Runner)
            item.args = SimpleNamespace(device_id='owned-device')
            item.last_page = None
            item.layout_observations = {}
            now = [100.0]
            def inspection():
                now[0] += .02
                return copy.deepcopy(result)
            observed = {'nativeWitness': {'display': {'rotation': 0}}}
            def observe(value):
                value['nativeObservation'] = observed
                return observed
            item.api = lambda path: {'devices': [{'id': 'owned-device', 'connected': True}]}
            item.inspection, item.observe_native_geometry = inspection, observe
            item.adb = lambda *args: self.fail('Waiting must not mutate/request another rotation')
            def sleep(seconds):
                now[0] += seconds
            clock = SimpleNamespace(monotonic=lambda: now[0], sleep=sleep)
            with self.subTest(requested=requested), mock.patch.object(runner, 'time', clock):
                if requested == 0:
                    self.assertEqual(item.wait_page('home', 'portrait', display_rotation=0)['snapshot']['state']['frameId'], 7)
                    self.assertLess(now[0], 101)
                else:
                    with self.assertRaisesRegex(RuntimeError, 'has not reached the requested'):
                        item.wait_page('home', 'portrait', display_rotation=2)
                    self.assertGreaterEqual(now[0], 115)
                    self.assertLess(now[0], 115.2)

    def test_full_ten_cycles_keep_actual_direction_through_custom_and_normal_navigation(self):
        # Both natural directions and a display/posture switch run the full
        # canonical loop. Geometry, freshness, tap and back-lifecycle assertions
        # execute unchanged; no device/service call is made by this double.
        for natural_portrait, postures in ((True, ()), (False, ()), (False, (1, 0))):
            with self.subTest(natural_portrait=natural_portrait, postures=postures):
                h = CycleBoundaryHarness(self, natural_portrait, postures)
                with mock.patch.object(runner.time, 'sleep', lambda _: None):
                    result = h.item.run_cycles()
                self.assertEqual(runner.Runner.current(result)['data']['count'], 10)
                self.assertEqual(len(h.item.report['backLifecycle']), 20)
                self.assertEqual(len(h.captures), 31)
                navigations = [x for x in h.waits if x['rotation'] == 1 and x['route'] in ('home', 'detail')]
                self.assertEqual(len(navigations), 30)
                self.assertTrue(all(x['fresh'] and x['expected'] == x['actual'] for x in navigations))
                for name, frame in h.captures:
                    if '-rotation' in name:
                        actual = runner.native_state(frame)['acceptedLayout']['windowMetrics']['deviceOrientation']
                        self.assertTrue(name.endswith('-' + actual), name)
                        requested = 1 if '-rotation1-' in name else 0
                        self.assertEqual(runner.completed_rotation_orientation(frame, requested), actual)

    def test_completed_rotation_direction_requires_matching_native_and_accepted_evidence(self):
        h = CycleBoundaryHarness(self, False, ())
        result = h.snapshot()
        self.assertEqual(runner.completed_rotation_orientation(result, 0), 'landscape')
        wrong = copy.deepcopy(result)
        wrong['snapshot']['state']['acceptedLayout']['windowMetrics']['deviceOrientation'] = 'portrait'
        with self.assertRaisesRegex(RuntimeError, 'orientations disagree'):
            runner.completed_rotation_orientation(wrong, 0)
        wrong = copy.deepcopy(result)
        del wrong['nativeObservation']
        with self.assertRaisesRegex(RuntimeError, 'actual native observation'):
            runner.completed_rotation_orientation(wrong, 0)
        wrong = copy.deepcopy(result)
        wrong['nativeObservation']['nativeWitness'] = None
        with self.assertRaisesRegex(RuntimeError, 'actual native witness'):
            runner.completed_rotation_orientation(wrong, 0)
        with self.assertRaisesRegex(RuntimeError, 'has not reached'):
            runner.completed_rotation_orientation(result, 1)

    def test_ambiguous_witness_stops_before_any_rotation_command(self):
        before = fixture()
        item = runner.Runner.__new__(runner.Runner)
        item.observe_native_geometry = lambda value: {'density': 3, 'nativeWitness': {'display': {}}}
        item.adb = lambda *args: self.fail('Invalid actual display must not send rotation command')
        item.wait_page = lambda *args, **kwargs: self.fail('Invalid actual display must not wait speculatively')
        with self.assertRaisesRegex(RuntimeError, 'Actual Android display'):
            item.rotate(0, 'home', before)


class PostureBoundaryHarness:
    """Deterministic actual/native/runtime channels; never starts a device or service."""
    def __init__(self, window_contract='changing'):
        self.now, self.calls, self.submissions = 100., [], 0
        self.contract = {'schemaVersion': 2, 'controlDomain': 'emulator-hinge-control',
            'target': {'operation': 'fold', 'angle': {'sensor': 'hinge-angle0', 'unit': 'degrees', 'value': '15.5'}},
            'expectedCommittedState': {'identifier': 7, 'name': 'CLOSED'},
            'expectedBaseState': {'identifier': 7, 'name': 'CLOSED'},
            'windowContract': window_contract, 'mappingSha256': 'a' * 64}
        self.before = self.runtime()
        self.current = self.runtime(width=360, observation=7, revision=10, before=self.before) if window_contract == 'changing' else copy.deepcopy(self.before)
        self.baseline = self.measurement(self.before)
        self.measured = self.measurement(self.current)
        self.actual = self.readback(7, 'CLOSED', '15.5')
        self.baseline_actual = self.readback(3, 'OPENED', '165')

    @staticmethod
    def readback(identifier, name, degrees):
        line = ("Committed state: DeviceState{identifier="+str(identifier)+", name='"+name
                +"', app_accessible=true, cancel_when_requester_not_on_top=false}\n")
        return {'committedState': line, 'baseState': line,
                'physicalAngle': {'sensor': 'hinge-angle0', 'unit': 'degrees', 'value': degrees},
                'overrideActive': False, 'pendingActive': False}

    @staticmethod
    def runtime(width=400, observation=6, revision=9, before=None):
        result = copy.deepcopy(before) if before is not None else fixture()
        state = result['snapshot']['state']
        layout, page = state['acceptedLayout'], result['snapshot']['pages'][-1]
        metrics, chrome = layout['windowMetrics'], layout['chrome']
        metrics.update(windowWidth=width, screenWidth=width)
        metrics['safeArea'].update(right=width, width=width)
        chrome['contentRect'].update(width=width)
        chrome['menuButtonRect'].update(left=width-96, right=width-8)
        layout.update(observationId=str(observation), layoutRevision=str(revision))
        state['viewport'] = state['observedViewport'] = {'width': width, 'height': 700}
        geometry = json.dumps({'window': metrics, 'capsule': chrome['menuButtonRect']}, sort_keys=True)
        if before is None:
            page['data'].update(fixtureVersion=1, events=[json.dumps({'sequence': 1, 'event': 'onLoad', 'geometry': 0})],
                geometries=[geometry], journal={'schemaVersion': 1, 'events': [], 'geometries': []})
        elif metrics != before['snapshot']['state']['acceptedLayout']['windowMetrics']:
            index = len(page['data']['geometries'])
            page['data']['geometries'].append(geometry)
            page['data']['events'].append(json.dumps({'sequence': 2, 'event': 'onResize', 'geometry': index}))
            page['data']['journal'] = {'schemaVersion': 1, 'geometries': [geometry],
                'events': [json.dumps([2, 'home', 1, 'onResize', 0, {'size': {'size': {'windowWidth': width, 'windowHeight': 700}}}])]}
        return result

    @staticmethod
    def measurement(result):
        state = result['snapshot']['state']
        layout, width = state['acceptedLayout'], state['acceptedLayout']['windowMetrics']['windowWidth']
        return {'surfacePhysical': [0, 216, width*3, 2316],
                'capsulePhysical': [(width-96)*3, 78, (width-8)*3, 210],
                'displaySafeAreaPhysical': [0, 72, width*3, 2478], 'density': 3,
                'hostObservation': {'ownerId': '17', 'surfaceGeneration': '4', 'observationId': layout['observationId']},
                'nativeWitness': {'display': {'schemaVersion': 1, 'displayId': 0, 'rotation': 0,
                    'orientation': 'portrait', 'boundsPhysical': [0, 0, width*3, 2550]}}}

    def operation(self, name, remaining, value):
        self.calls.append((name, remaining()))
        self.now += .01
        return copy.deepcopy(value)

    def submit(self, remaining):
        self.submissions += 1
        return self.operation('submit', remaining, {'exitCode': 0, 'controlDomain': self.contract['controlDomain'],
            'target': self.contract['target'], 'mappingSha256': self.contract['mappingSha256']})

    def sleep(self, seconds):
        self.now += seconds

    def run(self, **overrides):
        adapters = {'submit': self.submit,
            'read_actual': lambda remaining: self.operation('actual', remaining, self.actual),
            'measure_native': lambda remaining: self.operation('native', remaining, self.measured),
            'inspect_runtime': lambda remaining: self.operation('runtime', remaining, self.current),
            'monotonic': lambda: self.now, 'sleep': self.sleep}
        adapters.update(overrides)
        return runner.await_posture_transition(self.contract, self.before, self.baseline, self.baseline_actual, **adapters)


class ActualPostureCoordination(unittest.TestCase):
    def test_physical_target_native_change_and_presented_layout_share_one_budget(self):
        h = PostureBoundaryHarness()
        result = h.run()
        self.assertEqual(h.submissions, 1)
        evidence = result['postureEvidence']
        self.assertTrue(evidence['nativeWindowChanged'])
        self.assertEqual(evidence['validatedNewCallbacks'], 1)
        self.assertEqual(evidence['stableSamples'], 2)
        self.assertEqual(evidence['actualIdentity'][:2], [7, 'CLOSED'])
        self.assertEqual(evidence['actualIdentity'][2]._asdict(), {'sensor': 'hinge-angle0', 'unit': 'degrees', 'value': '15.5'})
        self.assertEqual(evidence['actualIdentity'][3:], [7, 'CLOSED', False, False])
        self.assertLess(h.now, 101)
        budgets = [value for _, value in h.calls]
        self.assertTrue(all(a > b > 0 for a, b in zip(budgets, budgets[1:])))

    def test_same_window_physical_continuity_is_explicit_and_not_a_layout_change(self):
        h = PostureBoundaryHarness('continuity')
        evidence = h.run()['postureEvidence']
        self.assertFalse(evidence['nativeWindowChanged'])
        self.assertEqual(evidence['beforeIdentity'], evidence['afterIdentity'])
        self.assertEqual(evidence['validatedNewCallbacks'], 0)
        self.assertEqual(evidence['windowContract'], 'continuity')

    def test_same_window_new_native_observation_must_be_accepted_with_new_layout(self):
        for accepted in (False, True):
            with self.subTest(accepted=accepted):
                h = PostureBoundaryHarness('continuity')
                h.measured['hostObservation']['observationId'] = '7'
                if accepted:
                    h.current['snapshot']['state']['acceptedLayout'].update(observationId='7', layoutRevision='10')
                    result = h.run()
                    self.assertEqual(result['postureEvidence']['afterIdentity'][5:7], [7, 10])
                else:
                    with self.assertRaisesRegex(runner.PostureDeadlineError, 'does not exactly match'):
                        h.run()
                    self.assertEqual(h.submissions, 1)
                    self.assertLessEqual(h.now, 115.02)

    def test_independent_current_observation_cannot_match_a_different_newer_accepted_id(self):
        # Counterexample independently found in the preserved first draft:
        # native current 6 was incorrectly accepted against runtime 8/11.
        h = PostureBoundaryHarness('continuity')
        h.current['snapshot']['state']['acceptedLayout'].update(observationId='8', layoutRevision='11')
        with self.assertRaisesRegex(runner.PostureDeadlineError, 'does not exactly match'):
            h.run()
        self.assertEqual(h.submissions, 1)

    def test_app17_without_independent_host_id_has_explicit_limited_evidence(self):
        for window_contract in ('changing', 'continuity'):
            with self.subTest(window_contract=window_contract):
                h = PostureBoundaryHarness(window_contract)
                del h.baseline['hostObservation']
                del h.measured['hostObservation']
                evidence = h.run()['postureEvidence']
                self.assertFalse(evidence['independentHostObservationAvailable'])
                self.assertFalse(evidence['sameSizeHostObservationAcknowledgementProven'])
                self.assertEqual(evidence['nativeWindowChanged'], window_contract == 'changing')

    def test_missing_independent_id_still_requires_fresh_accepted_same_size_transactions(self):
        for revision in ('9', '11'):
            with self.subTest(revision=revision):
                h = PostureBoundaryHarness('continuity')
                del h.baseline['hostObservation']
                del h.measured['hostObservation']
                h.current['snapshot']['state']['acceptedLayout'].update(observationId='8', layoutRevision=revision)
                if revision == '9':
                    with self.assertRaisesRegex(runner.PostureDeadlineError, 'stale surface observation/layout'):
                        h.run()
                else:
                    evidence = h.run()['postureEvidence']
                    self.assertFalse(evidence['sameSizeHostObservationAcknowledgementProven'])
                    self.assertFalse(evidence['nativeWindowChanged'])

    def test_independent_host_id_channel_cannot_be_silently_dropped_or_invented(self):
        for removed in ('baseline', 'current'):
            with self.subTest(removed=removed):
                h = PostureBoundaryHarness()
                del (h.baseline if removed == 'baseline' else h.measured)['hostObservation']
                with self.assertRaisesRegex(RuntimeError, 'channel changed'):
                    h.run()
                self.assertEqual(h.submissions, 1)

    def test_pending_same_size_host_layout_cannot_become_continuity_success(self):
        h = PostureBoundaryHarness('continuity')
        h.measured['hostObservation']['observationId'] = '7'
        h.current['snapshot']['state']['pendingHostLayout'] = {'observationId': '7'}
        with self.assertRaisesRegex(runner.PostureDeadlineError, 'not yet accepted'):
            h.run()
        self.assertGreaterEqual(sum(name == 'native' for name, _ in h.calls), 2)

    def test_same_window_new_observation_cannot_reuse_old_layout_revision(self):
        h = PostureBoundaryHarness('continuity')
        h.measured['hostObservation']['observationId'] = '7'
        h.current['snapshot']['state']['acceptedLayout']['observationId'] = '7'
        with self.assertRaisesRegex(runner.PostureDeadlineError, 'stale surface observation/layout'):
            h.run()

    def test_independent_safe_area_difference_cannot_hide_behind_matching_content(self):
        h = PostureBoundaryHarness()
        h.current = copy.deepcopy(h.before)
        h.current['snapshot']['state']['acceptedLayout'].update(observationId='7', layoutRevision='10')
        h.measured = h.measurement(h.current)
        h.measured['displaySafeAreaPhysical'][1] += 3
        with self.assertRaisesRegex(runner.PostureDeadlineError, 'native safeArea.top'):
            h.run()

    def test_unaccepted_baseline_observation_or_already_applied_target_refuses_submission(self):
        for reason in ('observation', 'same-target'):
            with self.subTest(reason=reason):
                h = PostureBoundaryHarness()
                if reason == 'observation':
                    h.baseline['hostObservation']['observationId'] = '7'
                else:
                    h.baseline_actual = copy.deepcopy(h.actual)
                with self.assertRaisesRegex(RuntimeError, 'Baseline host observation|already'):
                    h.run()
                self.assertEqual(h.submissions, 0)

    def test_actual_state_and_native_are_observed_before_stale_runtime_freshness(self):
        h = PostureBoundaryHarness()
        h.current = copy.deepcopy(h.before)
        h.measured['hostObservation']['observationId'] = '6'
        freshness_calls = []
        original = runner.require_fresh_layout
        def freshness(before, after):
            self.assertIn('native', [name for name, _ in h.calls])
            freshness_calls.append(True)
            return original(before, after)
        with mock.patch.object(runner, 'require_fresh_layout', freshness):
            with self.assertRaises(runner.PostureDeadlineError):
                h.run()
        self.assertEqual(h.submissions, 1)
        self.assertTrue(freshness_calls)
        self.assertLessEqual(h.now, 115.02)

    def test_successful_submission_without_actual_target_never_passes_or_retries(self):
        h = PostureBoundaryHarness()
        h.actual['committedState'] = h.actual['committedState'].replace('identifier=7', 'identifier=3')
        with self.assertRaisesRegex(runner.PostureDeadlineError, 'has not converged'):
            h.run()
        self.assertEqual(h.submissions, 1)
        self.assertIn('native', [name for name, _ in h.calls])
        self.assertGreaterEqual(h.now, 115)
        self.assertLessEqual(h.now, 115.02)

    def test_failed_or_wrong_domain_submission_stops_before_actual_readback(self):
        for changed in ({'exitCode': 1}, {'controlDomain': 'android-device-state-override'},
                        {'target': {'identifier': 7}}, {'mappingSha256': 'b' * 64}):
            with self.subTest(changed=changed):
                h = PostureBoundaryHarness()
                receipt = {'exitCode': 0, 'controlDomain': h.contract['controlDomain'],
                    'target': h.contract['target'], 'mappingSha256': h.contract['mappingSha256']}
                with self.assertRaisesRegex(RuntimeError, 'submission receipt failed'):
                    h.run(submit=lambda remaining: h.operation('submit', remaining, {**receipt, **changed}))
                self.assertEqual([name for name, _ in h.calls], ['submit'])

    def test_declared_changing_case_cannot_downgrade_when_actual_window_does_not_change(self):
        h = PostureBoundaryHarness()
        h.measured = copy.deepcopy(h.baseline)
        with self.assertRaisesRegex(runner.PostureDeadlineError, 'Required independent native window change'):
            h.run()
        self.assertEqual(h.contract['windowContract'], 'changing')
        self.assertEqual(h.submissions, 1)

    def test_declared_continuity_case_cannot_accept_unexpected_native_window_change(self):
        h = PostureBoundaryHarness('continuity')
        h.measured['displaySafeAreaPhysical'][1] += 1
        with self.assertRaisesRegex(RuntimeError, 'same-window posture contract'):
            h.run()
        self.assertLess(h.now, 101)
        self.assertEqual(h.submissions, 1)

    def test_slow_submission_and_compound_native_capture_share_original_deadline(self):
        for phase in ('submit', 'native'):
            with self.subTest(phase=phase):
                h = PostureBoundaryHarness()
                def slow(remaining):
                    h.calls.append((phase, remaining()))
                    h.now += 15
                    return copy.deepcopy(h.measured)
                with self.assertRaises(runner.PostureDeadlineError):
                    h.run(**({'submit': slow} if phase == 'submit' else {'measure_native': slow}))
                self.assertFalse(any(name == 'actual' for name, _ in h.calls) if phase == 'submit' else False)
                self.assertLessEqual(h.now, 115.04)

    def test_actual_state_change_during_native_capture_cannot_count_stable_sample(self):
        h = PostureBoundaryHarness()
        reads = [0]
        def actual(remaining):
            reads[0] += 1
            value = copy.deepcopy(h.actual)
            if reads[0] % 2 == 0:
                value['physicalAngle']['value'] = '165'
            return h.operation('actual', remaining, value)
        with self.assertRaisesRegex(runner.PostureDeadlineError, 'has not converged'):
            h.run(read_actual=actual)
        self.assertEqual(h.submissions, 1)

    def test_execution_fault_and_wrong_owner_stop_without_reauthorizing_input(self):
        for change in ('fault', 'owner'):
            with self.subTest(change=change):
                h = PostureBoundaryHarness()
                if change == 'fault':
                    h.current['snapshot']['state']['executionHealth']['requiresRestart'] = True
                else:
                    h.measured['hostObservation']['ownerId'] = '18'
                with self.assertRaisesRegex(RuntimeError, 'execution fault|changed owner'):
                    h.run()
                self.assertLess(h.now, 101)
                self.assertEqual(h.submissions, 1)

    def test_native_measurement_is_collected_before_any_runtime_validation(self):
        with tempfile.TemporaryDirectory(prefix='p0-native-measurement-pure-') as directory:
            item = runner.Runner.__new__(runner.Runner)
            item.out, item.native_index, item.native_binding = Path(directory), 0, {'nativeClass': 'pure'}
            item.ui = lambda: ('', runner.ET.fromstring('<hierarchy>'
                '<node enabled="true" content-desc="更多" bounds="[912,78][1044,210]"/>'
                '<node enabled="true" content-desc="关闭小程序" bounds="[1044,78][1176,210]"/>'
                '</hierarchy>'))
            def adb(*args, **kwargs):
                if args == ('shell', 'wm', 'density'):
                    return 'Physical density: 480\n'
                return b'pure-binary' if kwargs.get('binary') else 'pure-native'
            item.adb = adb
            with mock.patch.object(runner, 'independent_bounds', return_value=((0, 216, 1200, 2316), {'display': {}})), \
                    mock.patch.object(runner, 'validate_native_geometry', side_effect=AssertionError('Premature guest comparison')):
                measured = item.measure_native_geometry()
            self.assertEqual(measured['surfacePhysical'], [0, 216, 1200, 2316])
            self.assertEqual(measured['capsulePhysical'], [912, 78, 1176, 210])
            self.assertEqual(measured['density'], 3)
            self.assertNotIn('hostObservation', measured)
            self.assertNotIn('displaySafeAreaPhysical', measured)
            self.assertEqual(len(measured['nativeWitness']['files']), 3)
            safe = {'displaySafeAreaPhysical': [0, 72, 1200, 2478], 'densityDpi': 480}
            with mock.patch.object(runner, 'independent_bounds', return_value=((0, 216, 1200, 2316), {'display': {}})), \
                    mock.patch.object(runner, 'window_safe_area_observation', return_value=safe) as read_safe:
                enriched = item.measure_native_geometry(include_safe_area=True)
            self.assertEqual(read_safe.call_args.args, ('pure-native', 'pure-native', 'pure-native', runner.PACKAGE))
            self.assertEqual(enriched['displaySafeAreaPhysical'], safe['displaySafeAreaPhysical'])
            self.assertEqual(enriched['nativeWitness']['safeArea'], safe)
            self.assertEqual(len(enriched['nativeWitness']['files']), 5)
            self.assertNotIn('hostObservation', enriched)

    def test_a_to_b_to_a_needs_actual_changed_window_and_new_identity_for_both_legs(self):
        h = PostureBoundaryHarness()
        first = h.run()
        h.before, h.baseline = first['result'], first['nativeMeasurement']
        h.baseline_actual = copy.deepcopy(h.actual)
        h.actual = h.readback(3, 'OPENED', '165')
        h.contract.update(target={'operation': 'unfold', 'angle': h.actual['physicalAngle']},
                          expectedCommittedState={'identifier': 3, 'name': 'OPENED'},
                          expectedBaseState={'identifier': 3, 'name': 'OPENED'})
        h.current = self.return_to_original_runtime(h.before)
        h.measured = h.measurement(h.current)
        second = h.run()
        self.assertTrue(second['postureEvidence']['nativeWindowChanged'])
        self.assertEqual(second['postureEvidence']['afterIdentity'][5:7], [8, 11])
        self.assertEqual(h.submissions, 2)

    @staticmethod
    def return_to_original_runtime(before):
        result = PostureBoundaryHarness.runtime(width=400, observation=8, revision=11, before=before)
        prior = before['snapshot']['pages'][-1]['data']['journal']
        current = result['snapshot']['pages'][-1]['data']['journal']
        latest_geometry = current['geometries'][0]
        current['geometries'] = prior['geometries'] + [latest_geometry]
        current['events'] = prior['events'] + [json.dumps([3, 'home', 1, 'onResize', len(prior['geometries']),
            {'size': {'size': {'windowWidth': 400, 'windowHeight': 700}}}])]
        return result


class PhysicalPostureAdapters(unittest.TestCase):
    def test_observed_edges_derive_changed_or_continuity_without_target_state_guesses(self):
        for changed in (False, True):
            with self.subTest(changed=changed):
                h = PostureBoundaryHarness('changing' if changed else 'continuity')
                h.contract['windowContract'] = 'observe'
                outcome = h.run()['postureEvidence']
                self.assertEqual(outcome['observedWindowEffect'], 'changing' if changed else 'continuity')
                self.assertEqual(outcome['layoutChangingFoldRound'], changed)
                self.assertEqual(outcome['validatedNewCallbacks'], int(changed))

    def test_observed_a_to_b_to_a_never_downgrades_captured_change_to_continuity(self):
        h = PostureBoundaryHarness()
        h.contract['windowContract'] = 'observe'
        intermediate = copy.deepcopy(h.current)
        h.current = ActualPostureCoordination.return_to_original_runtime(intermediate)
        final = h.measurement(h.current)
        samples = [0]
        def measure(remaining):
            samples[0] += 1
            return h.operation('native', remaining, h.measured if samples[0] == 1 else final)
        inspections = [0]
        def inspect(remaining):
            inspections[0] += 1
            return h.operation('runtime', remaining, intermediate if inspections[0] <= 2 else h.current)
        outcome = h.run(measure_native=measure, inspect_runtime=inspect)['postureEvidence']
        self.assertTrue(outcome['nativeWindowChanged'])
        self.assertFalse(outcome['finalNativeWindowChanged'])
        self.assertTrue(outcome['layoutChangingFoldRound'])
        self.assertEqual(outcome['validatedNewCallbacks'], 2)

    def test_an_existing_shorter_deadline_is_never_reset_by_the_wait_boundary(self):
        h = PostureBoundaryHarness()
        h.actual = h.baseline_actual
        with self.assertRaises(runner.PostureDeadlineError):
            h.run(transition_deadline=104.)
        self.assertLessEqual(h.now, 104.02)
        self.assertEqual(h.submissions, 1)

    def adapter(self, h, from_profiles=None):
        item = runner.Runner.__new__(runner.Runner)
        item.physical_mapping = SimpleNamespace(steps=(runner.posture_contract(h.contract),), from_profiles=(from_profiles,))
        item.layout_observations, item.report = {}, {}
        item.assert_ = lambda condition, label, **details: self.assertTrue(condition, label)
        item.save = lambda: None
        item.read_posture_actual = lambda remaining: h.operation('actual', remaining,
            h.actual if h.submissions else h.baseline_actual)
        def native(remaining, include_safe_area=False):
            self.assertTrue(include_safe_area)
            return h.operation('native', remaining, h.measured if h.submissions else h.baseline)
        item.measure_native_geometry = native
        item.inspection = lambda remaining: h.operation('runtime', remaining, h.current if h.submissions else h.before)
        item.submit_physical_posture = lambda contract, remaining: h.submit(remaining)
        return item

    def test_runner_adapter_measures_baseline_and_forwards_one_budget_to_all_channels(self):
        h = PostureBoundaryHarness(); item = self.adapter(h)
        with mock.patch.object(runner.time, 'monotonic', side_effect=lambda: h.now), \
                mock.patch.object(runner.time, 'sleep', side_effect=h.sleep):
            outcome = item.transition_physical_posture(h.before, 0)
        self.assertEqual(runner.presentation_identity(outcome), runner.presentation_identity(h.current))
        self.assertIn('nativeObservation', outcome)
        self.assertEqual(h.submissions, 1)
        self.assertTrue(item.layout_observations)
        self.assertEqual(item.report['physicalPostureTransitions'][0]['observedWindowEffect'], 'changing')
        budgets = [budget for _, budget in h.calls]
        self.assertTrue(all(a > b > 0 for a, b in zip(budgets, budgets[1:])))
        self.assertLess(next(budget for name, budget in h.calls if name == 'submit'), 15)

    def test_mismatched_strict_from_profile_cannot_submit_a_physical_operation(self):
        h = PostureBoundaryHarness()
        item = self.adapter(h, (runner.posture_contract(h.contract),))
        with mock.patch.object(runner.time, 'monotonic', side_effect=lambda: h.now), \
                self.assertRaisesRegex(RuntimeError, 'from profile'):
            item.transition_physical_posture(h.before, 0)
        self.assertEqual(h.submissions, 0)

    def test_full_cycle_strategy_routes_physical_transitions_without_framework_override(self):
        h = CycleBoundaryHarness(self, False, ())
        h.item.physical_mapping = object()
        transitions = []
        def transition(before, index):
            transitions.append(index)
            return before
        h.item.transition_physical_posture = transition
        with mock.patch.object(runner.time, 'sleep', return_value=None):
            h.item.run_cycles()
        self.assertEqual(transitions, list(range(10)))
        self.assertEqual(len(h.captures), 31)

    def test_timeout_stops_the_owned_guard_process_group_not_just_the_parent(self):
        item = runner.Runner.__new__(runner.Runner)
        item.args = SimpleNamespace(adb='owned-guard', serial='emulator-5558')
        item.report, item.save = {'commands': []}, lambda: None
        process = mock.Mock(pid=12345, returncode=-9)
        process.communicate.side_effect = [runner.subprocess.TimeoutExpired(['owned-guard'], .1), (b'', b'')]
        with mock.patch.object(runner.subprocess, 'Popen', return_value=process) as start, \
                mock.patch.object(runner.os, 'killpg') as kill, self.assertRaises(runner.subprocess.TimeoutExpired):
            item.adb('emu', 'fold', timeout=.1)
        self.assertTrue(start.call_args.kwargs['start_new_session'])
        kill.assert_called_once_with(12345, runner.signal.SIGKILL)
        self.assertEqual(item.report['commands'][0]['status'], 'deadline-expired-owned-process-group-cleanup')
        self.assertEqual(process.communicate.call_args_list, [mock.call(timeout=.1), mock.call(timeout=1)])
        process.wait.assert_called_once_with(timeout=1)
        self.assertFalse(item.report['adbCleanupUncertain'])

    def test_interrupt_uses_bounded_owned_cleanup_and_preserves_the_original_exception(self):
        for drain_error in (None, KeyboardInterrupt('cleanup interrupted')):
            with self.subTest(drain_error=drain_error):
                item = runner.Runner.__new__(runner.Runner)
                item.args = SimpleNamespace(adb='owned-guard', serial='emulator-5558')
                item.report, item.save = {'commands': [], 'cleanup': []}, lambda: None
                original = KeyboardInterrupt('pure interrupt')
                process = mock.Mock(pid=12345, returncode=-9)
                process.communicate.side_effect = [original, drain_error or (b'', b'')]
                with mock.patch.object(runner.subprocess, 'Popen', return_value=process) as start, \
                        mock.patch.object(runner.os, 'killpg') as kill, self.assertRaises(KeyboardInterrupt) as raised:
                    item.adb('emu', 'fold', timeout=.1)
                self.assertIs(raised.exception, original)
                self.assertTrue(start.call_args.kwargs['start_new_session'])
                kill.assert_called_once_with(12345, runner.signal.SIGKILL)
                self.assertEqual(process.communicate.call_args_list, [mock.call(timeout=.1), mock.call(timeout=1)])
                process.wait.assert_called_once_with(timeout=1)
                process.stdout.close.assert_called_once_with()
                process.stderr.close.assert_called_once_with()
                receipt = item.report['cleanup'][0]
                self.assertIs(item.report['commands'][0]['cleanup'], receipt)
                self.assertEqual(receipt['originalException'], 'KeyboardInterrupt')
                self.assertEqual(item.report['commands'][0]['status'], 'interrupted-owned-process-group-cleanup')
                self.assertEqual(receipt['status'], 'unknown' if drain_error else 'closed')
                self.assertEqual(item.report['adbCleanupUncertain'], drain_error is not None)

    def test_real_owned_pipe_without_eof_returns_bounded_unknown_and_preserves_original_timeout(self):
        # Local processes only. A separate, directly owned child keeps a real
        # writer FD open, modelling pipe EOF not following the killed group.
        # We retain both process handles and reap both in finally; no device,
        # shell, ADB server or unrelated process is involved.
        read_fd, write_fd = runner.os.pipe()
        holder = guard = reader = None
        try:
            holder = runner.subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'],
                pass_fds=(write_fd,), stdout=runner.subprocess.DEVNULL, stderr=runner.subprocess.DEVNULL,
                start_new_session=True)
            runner.os.close(write_fd)
            write_fd = None
            guard = runner.subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'],
                stdout=runner.subprocess.DEVNULL, stderr=runner.subprocess.PIPE, start_new_session=True)
            reader = runner.os.fdopen(read_fd, 'rb', buffering=0)
            read_fd = None
            guard.stdout = reader
            item = runner.Runner.__new__(runner.Runner)
            item.args = SimpleNamespace(adb='pure-local-guard', serial='emulator-5558')
            item.report, item.save = {'commands': [], 'cleanup': []}, lambda: None
            started = runner.time.monotonic()
            with mock.patch.object(runner.subprocess, 'Popen', return_value=guard), \
                    self.assertRaises(runner.subprocess.TimeoutExpired) as raised:
                item.adb('emu', 'fold', timeout=.05)
            self.assertEqual(raised.exception.timeout, .05)
            self.assertLess(runner.time.monotonic() - started, 3.5)
            self.assertTrue(item.report['adbCleanupUncertain'])
            receipt = item.report['cleanup'][0]
            self.assertEqual(receipt['status'], 'unknown')
            self.assertFalse(receipt['pipeEofConfirmed'])
            self.assertTrue(receipt['ownedPipesClosed'])
            self.assertTrue(receipt['childReaped'])
            self.assertEqual((receipt['childPid'], receipt['processGroupId']), (guard.pid, guard.pid))
            self.assertIsNone(holder.poll(), 'The runner must not kill a different process group to force EOF')
            self.assertIsNotNone(guard.poll())
        finally:
            for process in (guard, holder):
                if process is not None:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=2)
                    for stream in (process.stdout, process.stderr):
                        if stream is not None:
                            stream.close()
            if read_fd is not None:
                runner.os.close(read_fd)
            if write_fd is not None:
                runner.os.close(write_fd)

    def test_http_body_chunks_refresh_socket_timeout_with_the_original_remaining_budget(self):
        item = runner.Runner.__new__(runner.Runner)
        item.args, item.secret = SimpleNamespace(admin='http://127.0.0.1:1'), 'pure-secret'
        now, timeouts = [0.], []
        response = mock.MagicMock()
        response.fp.raw._sock.settimeout.side_effect = timeouts.append
        response.length, response.isclosed.return_value = None, False
        chunks = iter((b'{"value":', b'1}', b''))
        def read1(count):
            self.assertLessEqual(count, 65536)
            now[0] += .1
            return next(chunks)
        response.read1.side_effect = read1
        response.__enter__.return_value = response
        item.opener = mock.Mock()
        item.opener.open.return_value = response
        self.assertEqual(item.api('/state', remaining=lambda: 1-now[0]), {'value': 1})
        self.assertEqual(timeouts, [1., .9, .8])
        self.assertEqual(item.opener.open.call_args.kwargs['timeout'], 1)

    def test_cli_requires_the_exact_mapping_pair_and_refuses_mixed_control_domains(self):
        args = ['--execute', '--serial', 'emulator-5558', '--avd', 'pure-fold', '--device-id', 'pure-device',
                '--admin', 'http://127.0.0.1:12345', '--out', '/pure/out', '--apk-sha256', 'a'*64,
                '--mapping', '/pure/mapping', '--mapping-sha256', 'b'*64, '--apk', '/pure/apk']
        pair = ['--physical-posture-mapping', '/pure/physical.json', '--physical-posture-mapping-sha256', 'c'*64]
        self.assertEqual(runner.arguments(args+pair).physical_posture_mapping_sha256, 'c'*64)
        for bad in (pair[:2], pair[2:], pair+['--postures', '1,2,3'], pair+['--stage', 'c018-baseline']):
            with self.subTest(args=bad), mock.patch('sys.stderr', io.StringIO()), self.assertRaises(SystemExit):
                runner.arguments(args+bad)


if __name__ == '__main__':
    unittest.main()
