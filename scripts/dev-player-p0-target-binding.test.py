#!/usr/bin/env python3
"""No-device regressions for immutable fixture selector measurement ownership."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(path))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

driver = load('target_binding_driver', 'dev-player-p0-android.py')
base = load('target_binding_fixture', 'dev-player-p0-android.test.py')


def fixture():
    result = base.fixture()
    layout = result['snapshot']['state']['acceptedLayout']
    geometry = {'window': copy.deepcopy(layout['windowMetrics']),
                'capsule': copy.deepcopy(layout['chrome']['menuButtonRect'])}
    data = result['snapshot']['pages'][-1]['data']
    data.update(fixtureVersion=1, kind='home', instance=5, runMarker='fresh-run',
                targets=[{'id': 'p0-' + name, 'left': 12, 'top': 58, 'width': 150, 'height': 32}
                         for name in ('increment', 'save', 'custom', 'normal', 'back', 'tab', 'scroll', 'fault')],
                targetError=None, geometries=[json.dumps(geometry)],
                events=[json.dumps({'sequence': 3, 'event': 'onShow', 'geometry': 0, 'detail': None})])
    data['targetGeometry'] = {'schemaVersion': 1, 'kind': 'home', 'instance': 5,
        'runMarker': 'fresh-run', 'measurementSequence': 2, 'lifecycleSequence': 3,
        'geometry': geometry, 'layoutProfile': 'p0-fixed-controls-v1',
        'layoutInputs': {'kind': 'home', 'windowWidth': 400, 'windowHeight': 700},
        'targetCount': 8}
    return result


class TargetBinding(unittest.TestCase):
    def test_valid_binding_is_bound_through_typed_page_data_and_native_owner(self):
        result = fixture()
        self.assertEqual(driver.require_target_geometry(result)['measurementSequence'], 2)

    def test_timer_only_frame_changes_do_not_invalidate_fixed_control_geometry(self):
        result = fixture()
        result['snapshot']['state'].update(frameId=100, frameRevision=101)
        result['snapshot']['pages'][-1]['data']['ticks'] = 42
        driver.require_target_geometry(result)

    def test_valid_bound_target_still_uses_the_independently_measured_native_origin(self):
        result = fixture()
        runner = driver.Runner.__new__(driver.Runner)
        runner.observe_native_geometry = lambda value: {'surfacePhysical': [0, 216, 1200, 2316], 'density': 3}
        self.assertEqual(runner.target(result, 'p0-increment'), (261, 438))

    def test_stale_portrait_target_geometry_is_rejected_before_any_input(self):
        result = fixture()
        data = result['snapshot']['pages'][-1]['data']
        data['targetGeometry']['geometry']['window']['windowWidth'] = 320
        with self.assertRaises(RuntimeError):
            driver.require_target_geometry(result)
        runner = driver.Runner.__new__(driver.Runner)
        runner.observe_native_geometry = lambda value: self.fail('stale target must fail before native measurement or tap')
        with self.assertRaises(RuntimeError):
            runner.target(result, 'p0-increment')

    def test_foreign_instance_kind_run_or_lifecycle_measurement_is_rejected(self):
        for key, value in [('instance', 6), ('kind', 'custom'), ('runMarker', 'old-run'),
                           ('lifecycleSequence', 2), ('measurementSequence', 0), ('targetCount', 2),
                           ('layoutProfile', 'unbound-layout')]:
            result = fixture()
            result['snapshot']['pages'][-1]['data']['targetGeometry'][key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                driver.require_target_geometry(result)

    def test_missing_binding_query_error_or_foreign_sdk_page_never_authorizes_targets(self):
        for mode in ['missing', 'error', 'foreign-page', 'foreign-owner', 'pending-layout']:
            result = fixture()
            data = result['snapshot']['pages'][-1]['data']
            if mode == 'missing': data['targetGeometry'] = None
            elif mode == 'error': data['targetError'] = {'code': 'ERR_RENDER'}
            elif mode == 'foreign-page': result['snapshot']['state']['page']['id'] = 2
            elif mode == 'foreign-owner': result['snapshot']['state']['hostSurface']['ownerId'] = '18'
            else: result['snapshot']['state']['pendingHostLayout'] = {'observationId': '7'}
            with self.subTest(mode=mode), self.assertRaises(RuntimeError):
                driver.require_target_geometry(result)

    def test_all_window_capsule_and_layout_input_fields_are_verified(self):
        for mode in ['capsule', 'safeArea', 'layoutWidth', 'latest-lifecycle', 'missing-window-field']:
            result = fixture()
            data = result['snapshot']['pages'][-1]['data']
            binding = data['targetGeometry']
            if mode == 'capsule': binding['geometry']['capsule']['left'] += 1
            elif mode == 'safeArea': binding['geometry']['window']['safeArea']['top'] += 1
            elif mode == 'layoutWidth': binding['layoutInputs']['windowWidth'] = 320
            elif mode == 'latest-lifecycle': data['events'].append(json.dumps({'sequence': 4, 'event': 'onResize', 'geometry': 0}))
            else: del binding['geometry']['window']['screenTop']
            with self.subTest(mode=mode), self.assertRaises(RuntimeError):
                driver.require_target_geometry(result)


if __name__ == '__main__':
    unittest.main()
