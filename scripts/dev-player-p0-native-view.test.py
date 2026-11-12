import copy
import hashlib
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile

import dev_player_p0_native_view as native

PACKAGE = 'dev.weapp.weapp_container_dev_player'


def node(name, rect, children=()):
    left, top, right, bottom = rect
    result = {'meta:__name__': name, 'misc:visibility': 0, 'layout:left': left, 'layout:top': top,
              'layout:right': right, 'layout:bottom': bottom, 'drawing:clipBounds': '',
              'drawing:translationX': 0., 'drawing:translationY': 0., 'drawing:rotation': 0.,
              'drawing:rotationX': 0., 'drawing:rotationY': 0., 'drawing:scaleX': 1., 'drawing:scaleY': 1.,
              'scrolling:scrollX': 0, 'scrolling:scrollY': 0}
    result.update({'meta:__child__' + str(index): item for index, item in enumerate(children)})
    return result


def archive(root):
    names = ['window:left', 'window:top', '__name__']
    def collect(value):
        for key, child in value.items():
            if key not in names:
                names.append(key)
            if isinstance(child, dict):
                collect(child)
    collect(root)
    ids = {name: index + 1 for index, name in enumerate(names)}
    def short(n):
        return b'S' + struct.pack('>h', n)
    def string(s):
        raw = s.encode()
        return b'R' + struct.pack('>h', len(raw)) + raw
    def encode(value):
        if isinstance(value, dict):
            return b'M' + b''.join(short(ids[key]) + encode(child) for key, child in value.items()) + short(0)
        if isinstance(value, float):
            return b'F' + struct.pack('>f', value)
        if isinstance(value, int):
            return b'I' + struct.pack('>i', value)
        return string(value)
    data = short(ids['window:left']) + encode(0) + short(ids['window:top']) + encode(0) + encode(root)
    data += b'M' + short(ids['__name__']) + string('propertyIndex')
    data += b''.join(short(ids[name]) + string(name) for name in names) + short(0)
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as z:
        z.writestr('123abc ' + PACKAGE + '/' + PACKAGE + '.MainActivity', data)
    return output.getvalue()


def example():
    target = node('mu0', (4, 6, 104, 106))
    root = node('Decor', (0, 0, 480, 800), [node('Wrapper', (10, 20, 400, 700), [target])])
    text = ('  ACTIVITY ' + PACKAGE + '/.MainActivity abc pid=123 displayId=0(type=INTERNAL)\n'
            '      mCurrentConfig={port winConfig={ mBounds=Rect(0, 0 - 480, 800) '
            'mDisplayRotation=ROTATION_0 mWindowingMode=fullscreen mRotation=ROTATION_0}}\n'
            '    View Hierarchy:\n'
            '      Decor{a V.E...... ........ 0,0-480,800}\n'
            '        Wrapper{b V.E...... ........ 10,20-400,700}\n'
            '          mu0{c VFE...... ........ 4,6-104,106}\n    Looper\n')
    return root, text


class NativeWitness(unittest.TestCase):
    def test_nested_parent_offsets_use_only_native_tree(self):
        root, text = example()
        bounds, evidence = native.independent_bounds(text, archive(root), 'TextureView: 100x100\n', PACKAGE, {'nativeClass': 'mu0'})
        self.assertEqual(bounds, (14, 26, 114, 126))
        self.assertEqual(evidence['nodes'], 3)

    def test_nonidentity_transform_clip_hidden_and_ambiguous_are_rejected(self):
        for key, value in (('drawing:scaleX', 2.), ('drawing:rotation', 90.),
                           ('drawing:translationX', 1.), ('drawing:clipBounds', 'Rect(0,0 - 10,10)'),
                           ('scrolling:scrollY', 1), ('misc:visibility', 4)):
            root, _ = example()
            root['meta:__child__0'][key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                native.encoded_native_bounds(archive(root), PACKAGE, 'mu0')
        root, _ = example()
        root['meta:__child__1'] = node('mu0', (0, 0, 10, 10))
        with self.assertRaisesRegex(RuntimeError, 'unique'):
            native.encoded_native_bounds(archive(root), PACKAGE, 'mu0')
        root, _ = example()
        root['meta:__child__0']['meta:__child__0']['layout:right'] = 1000
        with self.assertRaisesRegex(RuntimeError, 'clipping'):
            native.encoded_native_bounds(archive(root), PACKAGE, 'mu0')

    def test_malformed_text_and_binary_and_layer_mismatch_fail(self):
        root, text = example()
        for bad in (text.replace('4,6-104,106', 'x,6-104,106'), text.replace('          mu0', '           mu0'), text + text):
            with self.assertRaises(RuntimeError):
                native.text_native_bounds(bad, PACKAGE, 'mu0')
        for bad in (b'', b'\0', b'MS\0\1I\0\0'):
            with self.assertRaises(RuntimeError):
                native.decode_hierarchy(bad)
        with self.assertRaisesRegex(RuntimeError, 'layer size'):
            native.independent_bounds(text, archive(root), 'TextureView: 100x101\n', PACKAGE, {'nativeClass': 'mu0'})
        with self.assertRaisesRegex(RuntimeError, 'disagree'):
            native.independent_bounds(text.replace('4,6-104,106', '5,6-105,106'), archive(root),
                'TextureView: 100x100\n', PACKAGE, {'nativeClass': 'mu0'})

    def test_mapping_binds_exact_hash_to_actual_dex_r8_marker(self):
        with tempfile.TemporaryDirectory(prefix='mapping-test-') as directory:
            directory = Path(directory)
            map_id = 'a' * 64
            mapping = directory / 'mapping.txt'
            mapping.write_text('# pg_map_id: ' + map_id + '\n# pg_map_hash: SHA-256 ' + map_id +
                               '\ncom.sonofmagic.weapp.container.sdk.WeappContainerView -> mu0:\n')
            marker = ('~~R8' + json.dumps({'pg-map-id': map_id, 'backend': 'dex'})).encode()
            dex = bytearray(117)
            dex[:8] = b'dex\n035\0'
            struct.pack_into('<II', dex, 56, 1, 112)
            struct.pack_into('<I', dex, 112, 116)
            dex[116:] = b'\x01' + marker + b'\0'
            apk = directory / 'player.apk'
            with zipfile.ZipFile(apk, 'w') as package:
                package.writestr('classes.dex', dex)
            mapping_sha = hashlib.sha256(mapping.read_bytes()).hexdigest()
            apk_sha = hashlib.sha256(apk.read_bytes()).hexdigest()
            self.assertEqual(native.mapping_binding(mapping, mapping_sha, apk, apk_sha)['nativeClass'], 'mu0')
            with self.assertRaisesRegex(RuntimeError, 'mapping hash mismatch'):
                native.mapping_binding(mapping, 'b' * 64, apk, apk_sha)
            mapping.write_text(mapping.read_text().replace(map_id, 'b' * 64))
            with self.assertRaisesRegex(RuntimeError, 'marker does not match'):
                native.mapping_binding(mapping, hashlib.sha256(mapping.read_bytes()).hexdigest(), apk, apk_sha)


def activity_configuration(rotation=0, width=1200, height=2400, display_id=0):
    orientation = 'port' if width < height else 'land'
    return ('  ACTIVITY ' + PACKAGE + '/.MainActivity abc pid=123 displayId=' + str(display_id) + '(type=INTERNAL)\n'
            '      mCurrentConfig={' + orientation + ' winConfig={ mBounds=Rect(0, 0 - '
            + str(width) + ', ' + str(height) + ') mDisplayRotation=ROTATION_' + str(rotation * 90)
            + ' mWindowingMode=fullscreen mRotation=ROTATION_' + str(rotation * 90) + '}}\n')


def rotation_basis(rotation=0, width=1200, height=2400, display_id=0):
    display = native.activity_display_observation(activity_configuration(rotation, width, height, display_id), PACKAGE)
    metrics = {'deviceOrientation': display['orientation'], 'screenWidth': width / 2, 'screenHeight': height / 2}
    return display, metrics


class ActualDisplayRotation(unittest.TestCase):
    def test_natural_portrait_and_landscape_all_actual_and_requested_rotations(self):
        for natural_portrait in (True, False):
            for actual in range(4):
                portrait = natural_portrait != bool(actual % 2)
                width, height = (1200, 2400) if portrait else (2400, 1200)
                display, metrics = rotation_basis(actual, width, height)
                for requested in range(4):
                    with self.subTest(natural_portrait=natural_portrait, actual=actual, requested=requested):
                        plan = native.rotation_plan(display, metrics, 2, requested)
                        expected_portrait = natural_portrait != bool(requested % 2)
                        self.assertEqual(plan['expectedOrientation'], 'portrait' if expected_portrait else 'landscape')
                        self.assertEqual(plan['requiresFreshLayout'], actual != requested)
                        self.assertEqual(plan['observedRotation'], actual)

    def test_same_angle_is_noop_but_reverse_rotation_still_needs_fresh_layout(self):
        display, metrics = rotation_basis(0, 2560, 1800)
        noop = native.rotation_plan(display, metrics, 2, 0)
        reverse = native.rotation_plan(display, metrics, 2, 2)
        self.assertFalse(noop['requiresFreshLayout'])
        self.assertTrue(reverse['requiresFreshLayout'])
        self.assertEqual(noop['expectedOrientation'], reverse['expectedOrientation'])
        self.assertEqual(noop['expectedOrientation'], 'landscape')

    def test_fold_posture_or_display_change_uses_fresh_basis_and_rejects_cached_metrics(self):
        inner, inner_metrics = rotation_basis(0, 2208, 1840, 0)
        outer, outer_metrics = rotation_basis(0, 1080, 2092, 1)
        self.assertEqual(native.rotation_plan(inner, inner_metrics, 2, 1)['expectedOrientation'], 'portrait')
        plan = native.rotation_plan(outer, outer_metrics, 2, 1)
        self.assertEqual(plan['expectedOrientation'], 'landscape')
        self.assertEqual(plan['displayId'], 1)
        with self.assertRaisesRegex(RuntimeError, 'orientations disagree'):
            native.rotation_plan(outer, inner_metrics, 2, 1)
        with self.assertRaisesRegex(RuntimeError, 'orientations disagree'):
            native.rotation_plan(inner, outer_metrics, 2, 1)

    def test_current_owned_configuration_ignores_unrelated_and_old_reported_rotations(self):
        current = activity_configuration(1, 2400, 1200)
        prior = '      mLastReportedMergedConfiguration={port mDisplayRotation=ROTATION_0 mRotation=ROTATION_0}\n'
        unrelated = activity_configuration(2).replace(PACKAGE, 'unrelated.example')
        observed = native.activity_display_observation(unrelated + current + prior, PACKAGE)
        self.assertEqual(observed['rotation'], 1)
        self.assertEqual(observed['orientation'], 'landscape')

    def test_missing_duplicate_disagreeing_or_unsupported_observations_fail_explicitly(self):
        good = activity_configuration()
        invalid = [good + good, good.replace('mCurrentConfig', 'mLastConfig'),
                   good.replace('mRotation=ROTATION_0', 'mRotation=ROTATION_90'),
                   good.replace('mDisplayRotation=ROTATION_0', 'mDisplayRotation=ROTATION_45'),
                   good.replace('mWindowingMode=fullscreen', 'mWindowingMode=multi_window'),
                   good.replace('{port ', '{port land '), good.replace('displayId=0', 'unknownDisplay=0'),
                   good.replace('mBounds=Rect(0, 0 - 1200, 2400)', 'mBounds=Rect(0, 0 - 1200, 1200)'),
                   good.replace('{port ', '{land '), good.replace('mBounds=Rect(0, 0 -', 'mBounds=Rect(10, 0 -'),
                   good.replace(' mRotation=ROTATION_0', '')]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                native.activity_display_observation(value, PACKAGE)

    def test_sdk_screen_density_and_orientation_must_match_same_actual_display(self):
        display, metrics = rotation_basis()
        for changed in ({'screenWidth': 500}, {'screenHeight': 1300}, {'deviceOrientation': 'landscape'},
                        {'screenWidth': float('nan')}, {'screenWidth': True}):
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                native.rotation_plan(display, {**metrics, **changed}, 2, 1)
        for density in (0, float('nan'), True, 3):
            with self.subTest(density=density), self.assertRaises(RuntimeError):
                native.rotation_plan(display, metrics, density, 1)
        for requested in (-1, 4, '1', True):
            with self.subTest(requested=requested), self.assertRaises(RuntimeError):
                native.rotation_plan(display, metrics, 2, requested)

    def test_setting_ack_or_same_parity_does_not_prove_actual_target_rotation(self):
        display, _ = rotation_basis(0)
        native.require_observed_rotation(display, 0)
        for requested in (1, 2, 3, '0', True):
            with self.subTest(requested=requested), self.assertRaisesRegex(RuntimeError, 'has not reached'):
                native.require_observed_rotation(display, requested)

    def test_bounds_evidence_keeps_rotation_from_same_native_activity_dump(self):
        root, text = example()
        _, evidence = native.independent_bounds(text, archive(root), 'TextureView: 100x100\n', PACKAGE, {'nativeClass': 'mu0'})
        self.assertEqual(evidence['display']['rotation'], 0)
        self.assertEqual(evidence['display']['orientation'], 'portrait')
        self.assertEqual(evidence['display']['boundsPhysical'], [0, 0, 480, 800])


class ActualPostureBoundary(unittest.TestCase):
    @staticmethod
    def contract():
        return {'schemaVersion': 2, 'controlDomain': 'emulator-hinge-control',
                'target': {'operation': 'fold', 'angle': {'sensor': 'hinge-angle0', 'unit': 'degrees', 'value': '15.5'}},
                'expectedCommittedState': {'identifier': 7, 'name': 'CLOSED'},
                'expectedBaseState': {'identifier': 7, 'name': 'CLOSED'},
                'windowContract': 'changing', 'mappingSha256': 'a' * 64}

    @staticmethod
    def committed(identifier=7, name='CLOSED'):
        return ("Committed state: DeviceState{identifier=" + str(identifier) + ", name='" + name
                + "', app_accessible=true, cancel_when_requester_not_on_top=false}\n")

    @staticmethod
    def measurement():
        return {'surfacePhysical': [0, 144, 1200, 2400], 'capsulePhysical': [912, 32, 1176, 128],
                'displaySafeAreaPhysical': [0, 48, 1200, 2352], 'density': 3,
                'nativeWitness': {'display': {'schemaVersion': 1, 'displayId': 0, 'rotation': 0,
                    'orientation': 'portrait', 'boundsPhysical': [0, 0, 1200, 2400]}}}

    def test_committed_state_requires_unique_actual_bounded_readback(self):
        self.assertEqual(native.committed_device_state(self.committed())['identifier'], 7)
        for raw in ('OK\n', self.committed().replace('Committed state', 'Requested state'),
                    self.committed() + self.committed(), self.committed(256), self.committed(True),
                    self.committed().replace("name='CLOSED'", "name='CLOSED\nOPENED'"),
                    'x' * 65537, {'identifier': 7}, self.committed() + 'request pending\n'):
            with self.subTest(raw=repr(raw)[:100]), self.assertRaises(RuntimeError):
                native.committed_device_state(raw)

    def test_domains_freeze_separate_framework_and_emulator_mapping(self):
        value = self.contract()
        contract = native.posture_contract(value)
        self.assertEqual((contract.target_identifier, contract.committed_identifier), (None, 7))
        self.assertEqual(contract.physical_angle.value, '15.5')
        value['expectedCommittedState']['identifier'] = 1
        self.assertEqual(contract.committed_identifier, 7)
        with self.assertRaises(AttributeError):
            contract.committed_identifier = 1
        override = {**self.contract(), 'controlDomain': 'android-device-state-override',
                    'target': {'identifier': 7}, 'expectedBaseState': None}
        self.assertIs(native.posture_contract(override).control_domain, native.PostureControlDomain.ANDROID_OVERRIDE)
        for bad in ({'controlDomain': 'android-device-state'}, {'target': True},
                    {'schemaVersion': True}, {'target': {'identifier': 7}}, {'expectedBaseState': None},
                    {'windowContract': 'auto'}, {'mappingSha256': ''}, {'expectedCommittedState': {'identifier': 7}}):
            with self.subTest(bad=bad), self.assertRaises(RuntimeError):
                native.posture_contract({**self.contract(), **bad})
        with self.assertRaisesRegex(RuntimeError, 'must not claim'):
            native.posture_contract({**override, 'target': self.contract()['target']})

    def test_successful_control_receipt_or_wrong_domain_never_proves_actual_posture(self):
        contract = native.posture_contract(self.contract())
        readback = {'committedState': self.committed(), 'baseState': self.committed(),
                    'physicalAngle': self.contract()['target']['angle'], 'overrideActive': False, 'pendingActive': False}
        self.assertTrue(native.posture_actual_readback(contract, readback)[0])
        for changed in ({'committedState': self.committed(1)}, {'committedState': self.committed(7, 'OPENED')},
                        {'physicalAngle': {**self.contract()['target']['angle'], 'value': '165'}},
                        {'baseState': self.committed(3, 'OPENED')}, {'overrideActive': True}, {'pendingActive': True}):
            self.assertFalse(native.posture_actual_readback(contract, {**readback, **changed})[0])
        for bad in ({'exitCode': 0, 'stdout': 'OK'}, {**readback, 'physicalAngle': None},
                    {**readback, 'physicalAngle': {'domain': 'android-device-state', 'identifier': 1}}):
            with self.subTest(bad=bad), self.assertRaises(RuntimeError):
                native.posture_actual_readback(contract, bad)

    def test_hinge_angles_are_finite_degrees_not_enum_identifiers(self):
        for number in ('0', '15', '90', '165', '180', '37.125'):
            actual = native.hinge_angle_readback('hinge-angle0 = '+number+'\r\nOK\r\n', 'hinge-angle0')
            self.assertEqual(actual.unit, 'degrees')
            self.assertEqual(actual.sensor, 'hinge-angle0')
        for value in ('NaN', 'Infinity', 'inf', True, '1'*65):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                native.hinge_angle({'sensor': 'hinge-angle0', 'unit': 'degrees', 'value': value})
        for raw in ('OK\n', 'hinge-angle0 = 90\n', 'hinge-angle1 = 90\nOK\n',
                    'hinge-angle0 = 90\nOK\nhinge-angle0 = 15\nOK\n'):
            with self.subTest(raw=raw), self.assertRaises(RuntimeError):
                native.hinge_angle_readback(raw, 'hinge-angle0')

    def test_android_snapshot_preserves_base_override_pending_and_rejects_ambiguity(self):
        state = self.committed(3, 'OPENED').strip().removeprefix('Committed state: ')
        raw = ('DEVICE STATE MANAGER\n  mCommittedState=Optional['+state+']\n'
               '  mBaseState=Optional['+state+']\n  mOverrideState=Optional.empty\n'
               '  mPendingState=Optional.empty\n\nOverride Request active: false\n')
        actual = native.android_state_readback(raw)
        self.assertFalse(actual['overrideActive'])
        self.assertFalse(actual['pendingActive'])
        self.assertEqual(native.committed_device_state(actual['baseState'])['identifier'], 3)
        for bad in (raw.replace('mBaseState=', 'mBaseState=unknown\n  mBaseState='),
                    raw.replace('Override Request active: false', 'Override Request active: true'),
                    raw.replace('mPendingState=Optional.empty', 'mPendingState=unknown')):
            with self.subTest(raw=bad[:80]), self.assertRaises(RuntimeError):
                native.android_state_readback(bad)

    @staticmethod
    def mapping():
        def profile(angle, identifier, name):
            return {'angleDegrees': angle, 'committedState': {'identifier': identifier, 'name': name},
                    'baseState': {'identifier': identifier, 'name': name}}
        initial = profile('180', 3, 'OPENED')
        states = [profile('15', 1, 'CLOSED'), profile('90', 2, 'HALF_OPENED'), profile('165', 3, 'OPENED')]
        return {'schemaVersion': 1, 'avd': 'pure-fold', 'sensor': 'hinge-angle0', 'evidenceSha256': 'e'*64,
                'initial': initial, 'requiredCommittedStates': [item['committedState'] for item in states],
                'steps': [{**item, 'operation': operation, 'windowContract': 'observe', 'from': None}
                          for item, operation in zip(states, ('fold', 'hinge-angle-set', 'unfold'))],
                'restore': {**initial, 'operation': 'sensor-restore', 'windowContract': 'observe'}}

    def test_explicit_hashed_avd_mapping_preserves_all_three_android_states(self):
        value = self.mapping(); raw = json.dumps(value).encode()
        mapped = native.physical_posture_mapping(raw, hashlib.sha256(raw).hexdigest(), 'pure-fold')
        self.assertEqual(mapped.required_states, ((1, 'CLOSED'), (2, 'HALF_OPENED'), (3, 'OPENED')))
        self.assertEqual([item.physical_angle.value for item in mapped.steps], ['15', '90', '165'])
        self.assertEqual(mapped.restore.physical_angle.value, '180')
        self.assertEqual(native.posture_contract(native.posture_contract_json(mapped.steps[1])), mapped.steps[1])
        # Separate schema fixture for the root-observed Pixel mapping. Neither
        # its degrees nor Android IDs are inferred from the Generic fixture.
        pixel = copy.deepcopy(value)
        pixel['avd'] = 'pure-pixel-fold'
        for profile in (pixel['initial'], pixel['restore']):
            profile['committedState']['identifier'] = profile['baseState']['identifier'] = 2
        for step, degrees, identifier, name in zip(pixel['steps'], ('0', '90', '180'),
                (0, 1, 2), ('CLOSED', 'HALF_OPENED', 'OPENED')):
            step['angleDegrees'] = degrees
            step['committedState'] = {'identifier': identifier, 'name': name}
            step['baseState'] = dict(step['committedState'])
        pixel['requiredCommittedStates'] = [step['committedState'] for step in pixel['steps']]
        encoded_pixel = json.dumps(pixel).encode()
        parsed_pixel = native.physical_posture_mapping(encoded_pixel, hashlib.sha256(encoded_pixel).hexdigest(), 'pure-pixel-fold')
        self.assertEqual([step.physical_angle.value for step in parsed_pixel.steps], ['0', '90', '180'])
        self.assertEqual(parsed_pixel.required_states, ((0, 'CLOSED'), (1, 'HALF_OPENED'), (2, 'OPENED')))
        for sha, avd in [('f'*64, 'pure-fold'), (hashlib.sha256(raw).hexdigest(), 'other-avd')]:
            with self.assertRaises(RuntimeError):
                native.physical_posture_mapping(raw, sha, avd)
        for mutation in ('drop-half', 'arbitrary-command', 'arbitrary-key', 'missing-edge', 'restore-changed', 'set-outside-range'):
            bad = copy.deepcopy(value)
            if mutation == 'drop-half': bad['steps'].pop(1)
            elif mutation == 'arbitrary-command': bad['steps'][0]['operation'] = 'shell'
            elif mutation == 'arbitrary-key': bad['steps'][0]['argv'] = ['shell', 'anything']
            elif mutation == 'missing-edge': bad['steps'][0]['windowContract'] = 'changing'
            elif mutation == 'restore-changed': bad['restore']['angleDegrees'] = '90'
            else: bad['steps'][1]['angleDegrees'] = '181'
            encoded = json.dumps(bad).encode()
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeError):
                native.physical_posture_mapping(encoded, hashlib.sha256(encoded).hexdigest(), 'pure-fold')

    def test_strict_mapping_edges_bind_an_explicit_actual_from_profile(self):
        value = self.mapping()
        value['steps'][0].update(windowContract='changing', **{'from': [value['initial']]})
        raw = json.dumps(value).encode()
        mapped = native.physical_posture_mapping(raw, hashlib.sha256(raw).hexdigest(), 'pure-fold')
        self.assertEqual(mapped.from_profiles[0][0].physical_angle, mapped.initial.physical_angle)
        duplicate = raw.replace(b'"schemaVersion": 1', b'"schemaVersion": 1, "schemaVersion": 1')
        with self.assertRaisesRegex(RuntimeError, 'Duplicate'):
            native.physical_posture_mapping(duplicate, hashlib.sha256(duplicate).hexdigest(), 'pure-fold')

    def test_native_fingerprint_includes_all_geometry_not_sample_names_or_frame_counters(self):
        measured = self.measurement()
        baseline = native.native_window_fingerprint(measured)
        decorated = {**measured, 'frameId': 99, 'nativeFile': 'fresh-capture.txt'}
        self.assertEqual(baseline, native.native_window_fingerprint(decorated))
        for key, changed in [('density', 2), ('surfacePhysical', [0, 145, 1200, 2400]),
                             ('capsulePhysical', [911, 32, 1176, 128]),
                             ('displaySafeAreaPhysical', [0, 49, 1200, 2352])]:
            self.assertNotEqual(baseline, native.native_window_fingerprint({**measured, key: changed}))
        for key, value in [('displayId', 1), ('rotation', 2)]:
            other = copy.deepcopy(measured)
            other['nativeWitness']['display'][key] = value
            self.assertNotEqual(baseline, native.native_window_fingerprint(other))

    def test_missing_safe_area_invalid_native_geometry_and_guest_only_measurements_fail(self):
        for key in ('density', 'surfacePhysical', 'capsulePhysical', 'displaySafeAreaPhysical', 'nativeWitness'):
            bad = self.measurement()
            del bad[key]
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                native.native_window_fingerprint(bad)
        for key, value in [('density', True), ('density', float('nan')), ('surfacePhysical', [0, 0, 2400, 2400]),
                           ('displaySafeAreaPhysical', [0, 0, 1200, 0])]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                native.native_window_fingerprint({**self.measurement(), key: value})


def native_inset_dumps(width=1200, height=2400, rotation=0, nav_side='BOTTOM'):
    token = 'Window{abc u0 ' + PACKAGE + '/' + PACKAGE + '.MainActivity}'
    if nav_side == 'BOTTOM':
        nav = '[0,' + str(height-96) + '][' + str(width) + ',' + str(height) + ']'
    elif nav_side == 'RIGHT':
        nav = '[' + str(width-96) + ',0][' + str(width) + ',' + str(height) + ']'
    elif nav_side == 'LEFT':
        nav = '[0,0][96,' + str(height) + ']'
    else:
        nav = '[0,0][' + str(width) + ',96]'
    frame = '[0,0][' + str(width) + ',' + str(height) + ']'
    display = ('  Display: mDisplayId=0 (organized)\n'
        '    init=' + str(width) + 'x' + str(height) + ' 480dpi metadata cur=' + str(width) + 'x' + str(height) + '\n'
        '    deferred=false mLayoutNeeded=false\n'
        '  mCurrentFocus=' + token + '\n'
        '  mFocusedApp=ActivityRecord{def u0 ' + PACKAGE + '/.MainActivity t1}\n'
        '  DisplayFrames w=' + str(width) + ' h=' + str(height) + ' r=' + str(rotation) + '\n'
        '  WindowInsetsStateController\n'
        '    InsetsState\n'
        '      mDisplayFrame=Rect(0, 0 - ' + str(width) + ', ' + str(height) + ')\n'
        '      mDisplayCutout=DisplayCutout{insets=Rect(0, 0 - 0, 0) waterfall=Insets{left=0, top=0, right=0, bottom=0}}\n'
        '        InsetsSource id=1 type=statusBars frame=[0,0][' + str(width) + ',72] visible=true flags= sideHint=TOP boundingRects=null\n'
        '        InsetsSource id=2 type=navigationBars frame=' + nav + ' visible=true flags= sideHint=' + nav_side + ' boundingRects=null\n'
        '    Control map:\n'
        '      native-control-data-not-a-frame\n'
        '  NextDisplayController\n')
    windows = ('  Window #0 ' + token + ':\n'
        '    mDisplayId=0 other-metadata\n'
        '    mViewVisibility=0x0 mHaveFrame=true\n'
        '    Frames: parent=' + frame + ' display=' + frame + ' frame=' + frame + ' last=' + frame + ' insetsChanged=false\n'
        '    isOnScreen=true\n'
        '    isVisible=true\n'
        '  Window #1 Window{fff u0 unrelated.example/.Home}:\n'
        '    mDisplayId=1\n'
        '    isOnScreen=false\n')
    activity = activity_configuration(rotation, width, height)
    return display, windows, activity


class IndependentNativeSafeArea(unittest.TestCase):
    def observe(self, displays=None, windows=None, activity=None):
        defaults = native_inset_dumps()
        return native.window_safe_area_observation(displays if displays is not None else defaults[0],
            windows if windows is not None else defaults[1], activity if activity is not None else defaults[2], PACKAGE)

    def test_focused_owned_display_and_visible_system_bars_define_physical_safe_area(self):
        result = self.observe()
        self.assertEqual(result['displaySafeAreaPhysical'], [0, 72, 1200, 2304])
        self.assertEqual(result['densityDpi'], 480)
        self.assertEqual(result['boundsPhysical'], [0, 0, 1200, 2400])
        self.assertEqual(len(result['visibleSystemBars']), 2)

    def test_landscape_and_system_bars_on_every_display_edge(self):
        for side, safe in [('BOTTOM', [0, 72, 2400, 1104]), ('RIGHT', [0, 72, 2304, 1200]),
                           ('LEFT', [96, 72, 2400, 1200]), ('TOP', [0, 96, 2400, 1200])]:
            with self.subTest(side=side):
                raw = native_inset_dumps(2400, 1200, 1, side)
                result = native.window_safe_area_observation(*raw, PACKAGE)
                self.assertEqual(result['displaySafeAreaPhysical'], safe)
                self.assertEqual(result['rotation'], 1)

    def test_hidden_bars_cutout_and_waterfall_are_distinct_from_visible_bars(self):
        displays, windows, activity = native_inset_dumps()
        hidden = displays.replace('visible=true', 'visible=false')
        self.assertEqual(self.observe(displays=hidden)['displaySafeAreaPhysical'], [0, 0, 1200, 2400])
        cutout = hidden.replace('insets=Rect(0, 0 - 0, 0)', 'insets=Rect(20, 30 - 40, 50)')
        cutout = cutout.replace('waterfall=Insets{left=0, top=0, right=0, bottom=0}',
                                'waterfall=Insets{left=8, top=60, right=9, bottom=7}')
        self.assertEqual(self.observe(displays=cutout)['displaySafeAreaPhysical'], [20, 60, 1160, 2350])

    def test_gesture_and_ime_frames_do_not_become_display_safe_area(self):
        displays, _, _ = native_inset_dumps()
        extra = ('        InsetsSource id=3 type=systemGestures frame=[0,0][100,2400] visible=true flags= sideHint=LEFT boundingRects=null\n'
                 '        InsetsSource id=4 type=ime frame=[0,1400][1200,2400] visible=true flags= sideHint=BOTTOM boundingRects=null\n')
        self.assertEqual(self.observe(displays=displays.replace('    Control map:', extra+'    Control map:'))[
            'displaySafeAreaPhysical'], [0, 72, 1200, 2304])

    def test_unrelated_home_activity_and_foreign_display_do_not_supply_owned_insets(self):
        displays, windows, activity = native_inset_dumps()
        foreign_activity = activity_configuration(1, 2400, 1200, 1).replace(PACKAGE, 'unrelated.example')
        foreign_display = displays.replace('mDisplayId=0', 'mDisplayId=1').replace(PACKAGE, 'unrelated.example')
        result = native.window_safe_area_observation(foreign_display+displays, windows, foreign_activity+activity, PACKAGE)
        self.assertEqual(result['displayId'], 0)
        self.assertEqual(result['displaySafeAreaPhysical'], [0, 72, 1200, 2304])

    def test_lost_focus_duplicate_or_hidden_owned_window_refuses_native_authority(self):
        displays, windows, _ = native_inset_dumps()
        for bad_displays, bad_windows in [
                (displays.replace('mCurrentFocus=Window{abc', 'mCurrentFocus=Window{bad'), windows),
                (displays.replace('mFocusedApp=ActivityRecord{def u0 '+PACKAGE, 'mFocusedApp=ActivityRecord{def u0 foreign.example'), windows),
                (displays, windows+windows), (displays, windows.replace('isVisible=true', 'isVisible=false')),
                (displays, windows.replace('mViewVisibility=0x0', 'mViewVisibility=0x8')),
                (displays, windows.replace('frame=[0,0][1200,2400]', 'frame=[0,72][1200,2400]'))]:
            with self.subTest(windows=bad_windows[:50]), self.assertRaises(RuntimeError):
                self.observe(displays=bad_displays, windows=bad_windows)

    def test_contradictory_or_malformed_named_rows_cannot_hide_behind_a_valid_row(self):
        displays, windows, _ = native_inset_dumps()
        # Count the raw native key before validating its value. These second
        # rows must not disappear just because they do not match a good value.
        owned_extras = ['    isVisible=false\n', '    isOnScreen=false\n',
                        '    mViewVisibility=0x8 mHaveFrame=true\n',
                        '    mDisplayId=unknown\n', '    Frames: malformed\n']
        display_extras = ['  mFocusedApp=ActivityRecord{bad u0 foreign.example/.Home t9}\n',
                          '  mCurrentFocus=null\n', '    DisplayFrames malformed\n',
                          '    deferred=unknown mLayoutNeeded=false\n', '    init=unknown\n',
                          '    WindowInsetsStateController unknown\n', '    mLayoutNeeded=true\n']
        inset_extras = ['    InsetsState unknown\n', '      mDisplayFrame=unknown\n',
                        '      mDisplayCutout=unknown\n']
        for extra in owned_extras:
            with self.subTest(owned=extra), self.assertRaises(RuntimeError):
                self.observe(windows=windows.replace('  Window #1', extra+'  Window #1'))
        for extra in display_extras:
            with self.subTest(display=extra), self.assertRaises(RuntimeError):
                self.observe(displays=displays.replace('  WindowInsetsStateController\n',
                                                       extra+'  WindowInsetsStateController\n'))
        for extra in inset_extras:
            with self.subTest(insets=extra), self.assertRaises(RuntimeError):
                self.observe(displays=displays.replace('    Control map:\n', extra+'    Control map:\n'))

    def test_duplicate_positive_rows_and_repeated_inline_fields_also_fail_closed(self):
        displays, windows, _ = native_inset_dumps()
        bad_windows = [windows.replace('    isVisible=true\n', '    isVisible=true\n    isVisible=true\n'),
                       windows.replace('mViewVisibility=0x0 ', 'mViewVisibility=0x0 mViewVisibility=0x8 '),
                       windows.replace('insetsChanged=false', 'insetsChanged=true insetsChanged=false'),
                       windows.replace('mDisplayId=0 ', 'mDisplayId=0.unknown '),
                       windows.replace('mViewVisibility=0x0 ', 'mViewVisibility=0x0.unknown '),
                       windows+'  Window #2 unsupported\n']
        bad_displays = [displays.replace('cur=1200x2400', 'cur=1200x2400 cur=unknown'),
                        displays.replace('mFocusedApp=ActivityRecord{def u0 '+PACKAGE,
                                         'mFocusedApp=ActivityRecord{def u0 foreign.example/.Home t9 '+PACKAGE),
                        displays.replace('waterfall=Insets', 'waterfall=unknown waterfall=Insets'),
                        displays+'  Display: mDisplayId=unknown\n',
                        displays+'  Display: mDisplayId=0unknown\n']
        for bad in bad_windows:
            with self.subTest(window=bad[:50]), self.assertRaises(RuntimeError):
                self.observe(windows=bad)
        for bad in bad_displays:
            with self.subTest(display=bad[:50]), self.assertRaises(RuntimeError):
                self.observe(displays=bad)

    def test_all_inset_source_rows_and_each_known_field_are_validated(self):
        displays, _, _ = native_inset_dumps()
        anchor = '    Control map:\n'
        self.assertEqual(displays.count(anchor), 1)
        for extra in ('        InsetsSource=unknown\n', '        InsetsSource\n',
                      '        InsetsSource: unknown\n'):
            with self.subTest(source=extra), self.assertRaises(RuntimeError):
                self.observe(displays=displays.replace(anchor, extra+anchor))
        for key, value in [('id', 'f'), ('type', 'navigationBars'), ('frame', '[0,0][1,1]'),
                           ('visible', 'false'), ('flags', ''), ('sideHint', 'BOTTOM'),
                           ('boundingRects', 'null')]:
            bad = displays.replace('visible=true flags=', 'visible=true flags='+key+'='+value+' ', 1)
            self.assertNotEqual(bad, displays)
            with self.subTest(field=key), self.assertRaises(RuntimeError):
                self.observe(displays=bad)

    def test_inset_source_flags_and_bounding_rect_tail_have_a_bounded_grammar(self):
        displays, _, _ = native_inset_dumps()
        flags = displays.replace('flags= sideHint=', 'flags=SUPPRESS_SCRIM|ANIMATE_RESIZING sideHint=')
        self.assertEqual(self.observe(displays=flags)['displaySafeAreaPhysical'], [0, 72, 1200, 2304])
        for bad in [displays.replace('flags= sideHint=', 'flags=unknown sideHint='),
                    displays.replace('flags= sideHint=', 'flags=SUPPRESS_SCRIM| sideHint='),
                    displays.replace('flags= sideHint=', 'flags=SUPPRESS_SCRIM extra=true sideHint='),
                    displays.replace('boundingRects=null', 'boundingRects=[]'),
                    displays.replace('boundingRects=null', 'boundingRects=unknown'),
                    displays.replace('boundingRects=null', 'boundingRects=null extra=true')]:
            with self.subTest(source=bad[:50]), self.assertRaises(RuntimeError):
                self.observe(displays=bad)

    def test_owned_activity_configuration_is_unique_before_inherited_parsing(self):
        _, _, activity = native_inset_dumps()
        anchor = '    mCurrentConfig='
        self.assertEqual(activity.count(anchor), 1)
        malformed = [activity.replace(anchor, '    mCurrentConfig=null\n'+anchor)]
        for key in ('mBounds', 'mDisplayRotation', 'mRotation', 'mWindowingMode'):
            self.assertEqual(activity.count(key+'='), 1)
            malformed.append(activity.replace(key+'=', key+'=unknown '+key+'='))
        self.assertEqual(activity.count('displayId=0'), 1)
        malformed.append(activity.replace('displayId=0', 'displayId=unknown displayId=0'))
        for bad in malformed:
            self.assertNotEqual(bad, activity)
            with self.subTest(activity=bad[:80]), self.assertRaises(RuntimeError):
                self.observe(activity=bad)

    def test_missing_duplicate_stale_or_unsupported_display_insets_fail_closed(self):
        displays, _, _ = native_inset_dumps()
        for bad in [displays+displays, displays.replace('mDisplayId=0', 'mDisplayId=2'),
                    displays.replace('DisplayFrames w=1200', 'DisplayFrames w=1199'),
                    displays.replace('h=2400 r=0', 'h=2400 r=1'),
                    displays.replace('      mDisplayFrame=Rect(0, 0 - 1200, 2400)', ''),
                    displays.replace('    InsetsState', '    InsetsState\n    InsetsState'),
                    displays.replace('mDisplayCutout=', 'missingCutout='),
                    displays.replace('WindowInsetsStateController', 'UnknownInsetsController'),
                    displays.replace('mLayoutNeeded=false', 'mLayoutNeeded=true')]:
            with self.subTest(raw=bad[:50]), self.assertRaises(RuntimeError):
                self.observe(displays=bad)

    def test_partial_unknown_duplicate_and_out_of_display_sources_fail_closed(self):
        displays, _, _ = native_inset_dumps()
        for bad in [displays.replace('type=statusBars frame=[0,0][1200,72]', 'type=statusBars frame=[10,0][1200,72]'),
                    displays.replace('type=statusBars', 'type=unknownOverlay'),
                    displays.replace('id=2 type=navigationBars', 'id=1 type=navigationBars'),
                    displays.replace('[1200,72] visible=true', '[1201,72] visible=true'),
                    displays.replace('sideHint=TOP', 'sideHint=NONE')]:
            with self.subTest(raw=bad[:50]), self.assertRaises(RuntimeError):
                self.observe(displays=bad)


if __name__ == '__main__':
    unittest.main()
