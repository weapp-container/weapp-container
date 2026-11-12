#!/usr/bin/env python3
"""Bounded P0 interaction runner for one explicitly owned, already-running AVD.

No server/emulator lifecycle or installation is performed. --describe is fully
passive; --execute requires exact ownership and installed APK identity inputs.
"""
import argparse
import hashlib
import ipaddress
import json
import math
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dev_player_p0_native_view import (mapping_binding, independent_bounds, native_class_count,
                                     rotation_plan, require_observed_rotation, posture_contract,
                                     posture_actual_readback, native_window_fingerprint,
                                     posture_target, posture_contract_json, physical_posture_mapping, android_state_readback,
                                     hinge_angle_readback, PostureWindowContract, window_safe_area_observation)
from datetime import datetime, timezone
from pathlib import Path

PACKAGE = 'dev.weapp.weapp_container_dev_player'
ROUTES = {name: 'pages/' + name + '/index' for name in ('home', 'custom', 'detail', 'settings', 'scroll')}
PLAN = {
    'schemaVersion': 1, 'fixtureContract': 'p0-fixed-controls-v1',
    'runtimeIdentity': 'external reviewed Player build receipt and APK/native provenance required',
    'fixture': 'examples/apps/player-correctness-app', 'defaultCycles': 10,
    'preconditions': ['explicit owned emulator serial and matching AVD', 'exact installed APK SHA-256',
                      'already-paired device ID', 'local dashboard for this fixture', 'fresh output directory'],
    'cases': ['first onLoad geometry', 'ten portrait/landscape + normal/custom cycles',
              'tap + callback order', 'tab/storage', 'scroll', 'tools preserve timers/state',
              'close/reopen resets page memory, preserves storage', 'isolated View interruption'],
    'notClaimed': ['physical devices', 'hardware GPU', 'GPU leak freedom', 'C018 candidate rejection', 'performance thresholds', 'WeChat parity'],
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def decimal(value):
    require(isinstance(value, str) and re.fullmatch(r'[1-9][0-9]{0,19}', value) is not None and
            int(value) <= 18446744073709551615, 'Invalid lossless SDK identity')
    return int(value)


def native_state(result):
    state = result.get('snapshot', {}).get('state')
    require(isinstance(state, dict) and state.get('schemaVersion') == 1,
            'Typed native SDK state is required; server phase is not a presentation receipt')
    return state


def completed_rotation_orientation(result, requested):
    """Read direction from the completed accepted/native rotation, not its index."""
    presentation_identity(result)
    observed = result.get('nativeObservation')
    require(isinstance(observed, dict), 'Completed rotation lacks an actual native observation')
    witness = observed.get('nativeWitness')
    require(isinstance(witness, dict), 'Completed rotation lacks an actual native witness')
    display = witness.get('display')
    require_observed_rotation(display, requested)
    plan = rotation_plan(display, native_state(result)['acceptedLayout']['windowMetrics'],
                         observed.get('density'), requested)
    return plan['expectedOrientation']


def close_enough(actual, expected, tolerance, label):
    require(isinstance(actual, (int, float)) and not isinstance(actual, bool) and math.isfinite(actual) and
            isinstance(expected, (int, float)) and not isinstance(expected, bool) and math.isfinite(expected) and
            abs(actual - expected) <= tolerance, 'Independent geometry mismatch: ' + label)


def presentation_identity(result, require_presented=True):
    state = native_state(result)
    require(all(key in state for key in ('pendingNavigation', 'pendingHostLayout', 'chromeGeometryReady',
            'acceptedLayout', 'hostSurface', 'acceptedPackIdentity', 'page', 'ownerId', 'sessionId')),
            'Incomplete typed SDK presentation state')
    layout, surface, pack, page = (state.get(key) for key in ('acceptedLayout', 'hostSurface', 'acceptedPackIdentity', 'page'))
    require(all(isinstance(value, dict) for value in (layout, surface, pack, page)), 'Missing accepted SDK ownership')
    chrome = layout.get('chrome', {})
    session = state.get('sessionId')
    require(isinstance(session, str) and bool(session) and pack.get('sessionId') == session and
            chrome.get('sessionId') == session, 'Accepted pack/layout/session identity mismatch')
    publication = result.get('snapshot', {}).get('acceptedPack')
    require(isinstance(publication, dict) and publication.get('root') == pack.get('root') and
            publication.get('projectId') == result.get('projectId') and publication.get('runId') == result.get('runId'),
            'Guest pages/state lack exact accepted publication provenance')
    decimal(publication.get('generation'))
    require(state.get('ownerId') == surface.get('ownerId') == layout.get('ownerId'), 'Surface/layout owner mismatch')
    require(surface.get('surfaceGeneration') == layout.get('surfaceGeneration'), 'Surface generation mismatch')
    require(chrome.get('pageId') == page.get('id') and page.get('id') is not None, 'Accepted layout page mismatch')
    pages = result.get('snapshot', {}).get('pages', [])
    require(bool(pages) and pages[-1].get('id') == page['id'] and pages[-1].get('route') == page.get('route'),
            'Guest page batch is not the accepted destination page')
    require(state.get('pendingNavigation') is None and state.get('pendingHostLayout') is None and
            state.get('chromeGeometryReady') is True, 'SDK layout transaction is not accepted')
    if require_presented:
        health = state.get('executionHealth', {})
        require(state.get('status') == 'ready' and state.get('inputEnabled') is True and
                state.get('presentationEnabled') is True and state.get('foreground') is True and
                state.get('previewOccluded') is False, 'Current accepted frame is not interactively presented')
        require(health.get('requiresRestart') is False and all(health.get(key) is None for key in
                ('appServiceFault', 'viewFault', 'navigationFault')), 'Presented frame has an execution fault')
        require(state.get('frameId') is not None and isinstance(state.get('frameRevision'), int), 'Missing presented frame identity')
    return (session, pack.get('root'), decimal(pack.get('acceptedPackRevision')), decimal(state.get('ownerId')),
            decimal(surface.get('surfaceGeneration')), decimal(layout.get('observationId')),
            decimal(layout.get('layoutRevision')), page['id'])


def require_fresh_layout(before, after):
    old, new = presentation_identity(before), presentation_identity(after)
    require(new[:4] == old[:4], 'Layout transition unexpectedly changed accepted session/pack/owner')
    require(new[4] >= old[4] and new[5] > old[5] and new[6] > old[6],
            'A-to-B-to-A transition reused a stale surface observation/layout revision')


class PostureDeadlineError(RuntimeError):
    """The single transition budget expired; submission is never repeated."""


def await_posture_transition(contract_json, before, baseline_native, baseline_actual, *, submit, read_actual,
                             measure_native, inspect_runtime,
                             monotonic=None, sleep=None, transition_deadline=None):
    """Coordinate a predeclared posture without owning a physical control mapping.

    Every injected I/O operation receives the same remaining-budget callable;
    compound adapters must apply it to each command rather than reset a timeout.
    The caller supplies a root-verified control adapter; this function does not
    guess console commands, override state or retry a submission. Native samples
    are acquired before runtime freshness is tested, including when the runtime
    still reports the baseline layout. CLI adapters admit a hashed mapping and
    share the budget with baseline measurement; they never infer control IDs.

    App17 does not expose an independent current host-observation ID. That
    channel is optional and never synthesized from acceptedLayout. Without it,
    native geometry changes still require fresh accepted layout, but same-size
    host-observation acknowledgement is not claimed as device-level evidence.
    A supplied independent channel must match exactly and cannot disappear.
    """
    monotonic, sleep = monotonic or time.monotonic, sleep or time.sleep
    contract = posture_contract(contract_json)
    baseline_identity = presentation_identity(before)
    baseline_window = native_window_fingerprint(baseline_native)
    baseline_converged, baseline_actual_identity = posture_actual_readback(contract, baseline_actual)
    require(not baseline_converged,
            'Posture transition target is already the actual baseline state')
    if contract.physical_angle is not None:
        require(baseline_actual_identity[2] != contract.physical_angle,
                'Physical posture target is already applied at the baseline')
    Runner.validate_native_measurement(before, baseline_native)

    def host_identity(measured):
        if 'hostObservation' not in measured:
            return None
        observation = measured.get('hostObservation')
        require(type(observation) is dict and set(observation) == {'ownerId', 'surfaceGeneration', 'observationId'},
                'Independent current host observation identity is required')
        return tuple(decimal(observation[key]) for key in ('ownerId', 'surfaceGeneration', 'observationId'))

    baseline_host = host_identity(baseline_native)
    if baseline_host is not None:
        require(baseline_host[0] == baseline_identity[3] and baseline_host[1] == baseline_identity[4]
                and baseline_host[2] == baseline_identity[5], 'Baseline host observation is not accepted')
    started = monotonic()
    deadline = started + 15 if transition_deadline is None else transition_deadline
    require(type(deadline) in (int, float) and math.isfinite(deadline) and started < deadline <= started + 15,
            'Physical transition cannot reset or extend its original fifteen second budget')
    phase, last_reason, previous_sample = 'submit', None, None
    host_high_water = baseline_host[1:] if baseline_host is not None else None
    observed_layouts = {baseline_identity: native_state(before)['acceptedLayout']}
    native_change_observed = False

    def remaining():
        value = deadline - monotonic()
        if value <= 0:
            raise PostureDeadlineError('Posture transition exceeded its original fifteen second deadline: '
                                      + phase + ': ' + str(last_reason))
        return value

    def invoke(operation):
        remaining()
        value = operation(remaining)
        remaining()
        return value

    receipt = invoke(submit)
    require(type(receipt) is dict and set(receipt) == {'controlDomain', 'target', 'mappingSha256', 'exitCode'}
            and receipt.get('controlDomain') == contract.control_domain.value
            and receipt.get('target') == posture_target(contract)
            and receipt.get('mappingSha256') == contract.mapping_sha256
            and type(receipt.get('exitCode')) is int and receipt['exitCode'] == 0,
            'Posture submission receipt failed or changed declared control domain/target/mapping')
    while True:
        phase = 'actual-readback-and-native-window'
        actual = invoke(read_actual)
        converged, actual_identity = posture_actual_readback(contract, actual)
        pre = invoke(inspect_runtime)
        measured = invoke(measure_native)
        fingerprint = native_window_fingerprint(measured)
        native_change_observed = native_change_observed or fingerprint != baseline_window
        observed_host = host_identity(measured)
        require((observed_host is None) == (baseline_host is None),
                'Independent host observation channel changed during the declared transition')
        if observed_host is not None:
            require(observed_host[0] == baseline_identity[3]
                    and observed_host[1] >= host_high_water[0]
                    and (observed_host[1] > host_high_water[0] or observed_host[2] >= host_high_water[1]),
                    'Independent current host observation regressed or changed owner')
            host_high_water = observed_host[1:]
        post = invoke(inspect_runtime)
        confirmed_actual = invoke(read_actual)
        confirmed, confirmed_identity = posture_actual_readback(contract, confirmed_actual)
        remaining()
        # Record accepted transactions before checking freshness. An old runtime
        # observation must never prevent collection of the independent witness.
        runtime_ready = True
        for result in (pre, post):
            state = native_state(result)
            health = state.get('executionHealth', {})
            require(health.get('requiresRestart') is False and all(health.get(key) is None for key in
                    ('appServiceFault', 'viewFault', 'navigationFault')),
                    'Posture transition encountered an execution fault')
            try:
                identity = presentation_identity(result)
            except RuntimeError as error:
                runtime_ready = False
                last_reason = str(error)
                continue
            require(identity[:4] == baseline_identity[:4] and identity[7] == baseline_identity[7],
                    'Posture transition unexpectedly changed accepted session/pack/owner/page')
            require(all(identity[index] >= baseline_identity[index] for index in (4, 5, 6)),
                    'Posture transition regressed accepted surface/observation/layout')
            observed_layouts[identity] = native_state(result)['acceptedLayout']
        stable = converged and confirmed and actual_identity == confirmed_identity
        sample = (confirmed_identity, fingerprint)
        if not stable:
            last_reason = 'Actual physical/Android posture has not converged to the declared target'
            previous_sample = None
        elif contract.window_contract is PostureWindowContract.CHANGING and not native_change_observed:
            last_reason = 'Required independent native window change has not occurred'
            previous_sample = None
        else:
            require(contract.window_contract is not PostureWindowContract.CONTINUITY or not native_change_observed,
                    'Predeclared same-window posture contract observed a native window change')
            phase = 'accepted-runtime-layout'
            try:
                require(runtime_ready, 'Current host observation is not yet accepted and presented')
                pre_identity, post_identity = presentation_identity(pre), presentation_identity(post)
                require(pre_identity == post_identity,
                        'Layout changed while independently measuring native posture geometry')
                if observed_host is not None:
                    require(post_identity[4] == observed_host[1] and post_identity[5] == observed_host[2],
                            'Current native host observation does not exactly match the accepted observation')
                if (native_change_observed
                        or post_identity[4:7] != baseline_identity[4:7]):
                    require_fresh_layout(before, post)
                Runner.validate_native_measurement(post, measured)
                _, geometry = Runner.observations(Runner.current(post))
                require_guest_geometry(post, geometry)
                layouts = [layout for identity, layout in observed_layouts.items()
                           if identity[6] > baseline_identity[6]]
                callbacks = require_resize_journal(before, post, layouts)
            except RuntimeError as error:
                last_reason = str(error)
                previous_sample = None
            else:
                if sample == previous_sample:
                    elapsed = 15 - remaining()
                    return {'result': post, 'nativeMeasurement': measured,
                            'layoutTransactions': list(observed_layouts.items()),
                            'postureEvidence': {'schemaVersion': 1,
                                'controlDomain': contract.control_domain.value,
                                'mappingSha256': contract.mapping_sha256,
                                'windowContract': contract.window_contract.value,
                                'observedWindowEffect': 'changing' if native_change_observed else 'continuity',
                                'independentHostObservationAvailable': observed_host is not None,
                                'sameSizeHostObservationAcknowledgementProven': (
                                    not native_change_observed
                                    and observed_host is not None and observed_host[2] > baseline_identity[5]),
                                'beforeActualIdentity': list(baseline_actual_identity),
                                'actualIdentity': list(confirmed_identity),
                                'beforeIdentity': list(baseline_identity), 'afterIdentity': list(post_identity),
                                'nativeWindowChanged': native_change_observed,
                                'finalNativeWindowChanged': fingerprint != baseline_window,
                                'layoutChangingFoldRound': native_change_observed,
                                'validatedNewCallbacks': callbacks, 'stableSamples': 2,
                                'elapsedSeconds': elapsed, 'deadlineSeconds': 15}}
                previous_sample = sample
                last_reason = 'Waiting for a second stable actual/native sample'
        sleep(min(.15, remaining()))


def require_guest_geometry(result, geometry):
    layout = native_state(result)['acceptedLayout']
    window, capsule = geometry.get('window', {}), geometry.get('capsule', {})
    for key, expected in layout['windowMetrics'].items():
        actual = window.get(key)
        if isinstance(expected, dict):
            require(isinstance(actual, dict), 'Guest window metric missing: ' + key)
            for child, value in expected.items():
                close_enough(actual.get(child), value, 1e-6, key + '.' + child)
        elif isinstance(expected, str):
            require(actual == expected, 'Guest window metric mismatch: ' + key)
        elif expected is None:
            require(actual is None, 'Guest optional window metric mismatch: ' + key)
        else:
            close_enough(actual, expected, 1e-6, 'window.' + key)
    for key, expected in layout['chrome']['menuButtonRect'].items():
        close_enough(capsule.get(key), expected, 1e-6, 'capsule.' + key)


def require_target_geometry(result):
    """Bind cached fixture rectangles to this page's measured native layout.

    The inspector's accepted owner/session/page provenance binds page data;
    fixture instance, run marker and lifecycle sequence bind the measurement.
    No private guest API or ever-changing frame counter is used as a fence.
    """
    presentation_identity(result)
    page = result['snapshot']['pages'][-1]
    data = page.get('data', {})
    binding = data.get('targetGeometry')
    require(data.get('fixtureVersion') == 1 and data.get('targetError') is None,
            'Fixture target measurement has an explicit error or unsupported version')
    require(isinstance(binding, dict) and binding.get('schemaVersion') == 1 and
            binding.get('layoutProfile') == 'p0-fixed-controls-v1',
            'Fixture targets lack a supported measured geometry binding')
    kind, instance, run = data.get('kind'), data.get('instance'), data.get('runMarker')
    require(kind in ROUTES and page['route'] == ROUTES[kind] and
            isinstance(instance, int) and not isinstance(instance, bool) and instance > 0 and
            isinstance(run, str) and bool(run) and
            isinstance(binding.get('instance'), int) and not isinstance(binding.get('instance'), bool) and
            binding.get('kind') == kind and binding.get('instance') == instance and binding.get('runMarker') == run,
            'Fixture target measurement belongs to a foreign page instance/run')
    sequence = binding.get('measurementSequence')
    require(isinstance(sequence, int) and not isinstance(sequence, bool) and sequence > 0,
            'Fixture target measurement sequence is invalid')
    try:
        events = [json.loads(value) for value in data['events']]
        lifecycle = max(event['sequence'] for event in events
                        if event['event'] in ('onShow', 'onReady', 'onResize'))
        latest_geometry = json.loads(data['geometries'][events[-1]['geometry']])
    except (KeyError, TypeError, ValueError, IndexError):
        raise RuntimeError('Fixture targets lack a complete lifecycle geometry journal') from None
    require(isinstance(binding.get('lifecycleSequence'), int) and not isinstance(binding.get('lifecycleSequence'), bool) and
            binding['lifecycleSequence'] == lifecycle,
            'Fixture target measurement predates the current show/resize lifecycle')
    geometry = binding.get('geometry')
    require(isinstance(geometry, dict) and set(geometry) == {'window', 'capsule'} and geometry == latest_geometry,
            'Fixture target measurement does not match the current complete geometry')
    require_guest_geometry(result, geometry)
    window = native_state(result)['acceptedLayout']['windowMetrics']
    require(binding.get('layoutInputs') == {'kind': kind, 'windowWidth': window['windowWidth'],
                                          'windowHeight': window['windowHeight']},
            'Fixture target layout inputs do not match accepted native window metrics')
    targets = data.get('targets')
    expected = ['p0-' + name for name in ('increment', 'save', 'custom', 'normal', 'back', 'tab', 'scroll', 'fault')]
    if kind == 'scroll':
        expected.append('p0-scroll-region')
    require(isinstance(targets, list) and len(targets) == binding.get('targetCount') and
            all(isinstance(target, dict) for target in targets) and
            [target.get('id') for target in targets] == expected,
            'Fixture target rectangle set does not match the fixed controls layout')
    require(all(all(isinstance(target.get(key), (int, float)) and not isinstance(target.get(key), bool) and
                        math.isfinite(target[key]) for key in ('left', 'top', 'width', 'height')) and
                target['width'] > 0 and target['height'] > 0 for target in targets),
            'Fixture target rectangles must be finite and nonempty')
    return binding


def require_resize_journal(before, after, observed_layouts):
    """Validate callback-time values, including samples preceding final settle.

    A final good layout cannot excuse an earlier mixed window/capsule batch.
    Unobserved intermediate transactions remain missing evidence, never inferred.
    """
    if native_state(before).get('sessionId') != native_state(after).get('sessionId'):
        return 0
    prior = before['snapshot']['pages'][-1]['data'].get('journal')
    current = after['snapshot']['pages'][-1]['data'].get('journal')
    require(isinstance(prior, dict) and isinstance(current, dict), 'Complete cross-page callback journal is required')
    old_events = [json.loads(value) for value in prior['events']]
    events = [json.loads(value) for value in current['events']]
    old_sequence = old_events[-1][0] if old_events else 0
    require(all(any(value == later for later in events) for value in old_events), 'Callback journal lost or rewrote earlier samples')
    checked = 0
    for event in events:
        if event[0] <= old_sequence or event[3] != 'onResize':
            continue
        geometry = json.loads(current['geometries'][event[4]])
        detail = event[5]
        require(isinstance(detail, dict) and isinstance(detail.get('size'), dict) and
                isinstance(detail['size'].get('size'), dict), 'onResize callback must retain its actual size payload')
        size = detail['size']['size']
        for key in ('windowWidth', 'windowHeight'):
            close_enough(size.get(key), geometry.get('window', {}).get(key), 1e-6, 'onResize callback size versus synchronous window.' + key)
        matches = []
        for layout in observed_layouts:
            try:
                require_guest_geometry({'snapshot': {'state': {'schemaVersion': 1, 'acceptedLayout': layout}}}, geometry)
                matches.append(layout)
            except RuntimeError:
                pass
        require(bool(matches), 'Unbound onResize journal sample at sequence ' + str(event[0]) +
                ': callback window and capsule do not share an observed accepted native transaction')
        checked += 1
    a, b = native_state(before), native_state(after)
    same_page = a.get('page') == b.get('page')
    changed = a['acceptedLayout']['windowMetrics'] != b['acceptedLayout']['windowMetrics']
    if same_page and changed:
        require(checked > 0, 'Changed same-page native layout has no retained onResize callback')
    return checked


def journal_sequence(result):
    journal = result['snapshot']['pages'][-1]['data'].get('journal')
    require(isinstance(journal, dict) and journal.get('schemaVersion') == 1,
            'Back navigation requires a complete prior callback journal')
    events = [json.loads(value) for value in journal['events']]
    require(bool(events) and all(isinstance(value, list) and len(value) == 6 and
            isinstance(value[0], int) and not isinstance(value[0], bool) and value[0] > 0
            for value in events), 'Back callback journal is malformed')
    require(all(a[0] < b[0] for a, b in zip(events, events[1:])),
            'Back callback sequence must increase without duplicates')
    return events[-1][0]


def require_back_lifecycle(before, after, before_sequence):
    """Bind navigateBack callbacks to the old and new accepted geometry.

    Page destruction fires onUnload; it does not imply an onHide callback.
    Unrelated Activity hide/show events before the actual click are retained
    in the journal but cannot stand in for navigation lifecycle evidence.
    """
    old_identity, new_identity = presentation_identity(before), presentation_identity(after)
    require(old_identity[:4] == new_identity[:4], 'Back changed accepted session/pack/owner')
    require_fresh_layout(before, after)
    require(before_sequence == journal_sequence(before), 'Back boundary is not the last pre-click callback sequence')
    journal_sequence(after)
    old_pages, new_pages = before['snapshot']['pages'], after['snapshot']['pages']
    require(len(old_pages) >= 2 and len(new_pages) == len(old_pages) - 1 and
            [page['id'] for page in new_pages] == [page['id'] for page in old_pages[:-1]],
            'Back must remove exactly the departing page and preserve the destination stack')
    departing, destination = old_pages[-1]['data'], new_pages[-1]['data']
    require(destination.get('kind') == 'home' and destination.get('instance') == old_pages[-2]['data'].get('instance'),
            'Back destination is not the existing home instance')
    prior, current = departing['journal'], destination['journal']
    old_events = [json.loads(value) for value in prior['events']]
    events = [json.loads(value) for value in current['events']]
    require(events[:len(old_events)] == old_events, 'Back callback journal lost or rewrote prior observations')
    following = [event for event in events if event[0] > before_sequence]
    exited = [event for event in following if event[1:3] == [departing['kind'], departing['instance']]]
    unloads = [event for event in exited if event[3] == 'onUnload']
    backs = [event for event in exited if event[3] == 'navigateBack']
    require(len(unloads) == 1 and not any(event[3] == 'onHide' for event in exited),
            'navigateBack requires exactly one departing onUnload and no departing onHide after the click boundary')
    require(len(backs) == 1 and backs[0][0] < unloads[0][0], 'Back click must precede the departing onUnload exactly once')
    shown = [event for event in following if event[1:4] == [destination['kind'], destination['instance'], 'onShow']]
    require(len(shown) == 1 and shown[0][0] > unloads[0][0],
            'Back must show the retained home exactly once after unloading the departing page')
    exit_geometry = json.loads(current['geometries'][unloads[0][4]])
    show_geometry = json.loads(current['geometries'][shown[0][4]])
    require_guest_geometry(before, exit_geometry)
    require_guest_geometry(after, show_geometry)
    retired = destination.get('lastRetired')
    require(isinstance(retired, dict) and retired.get('kind') == departing['kind'] and
            retired.get('first') == departing.get('first'), 'Back lastRetired does not identify the departing page')
    retired_events = [json.loads(value) for value in retired['events']]
    prior_page_events = [json.loads(value) for value in departing['events']]
    require(retired_events[:len(prior_page_events)] == prior_page_events,
            'Back lastRetired lost or rewrote departing page callbacks')
    retired_unloads = [event for event in retired_events if event['sequence'] > before_sequence and event['event'] == 'onUnload']
    require(len(retired_unloads) == 1 and retired_unloads[0]['sequence'] == unloads[0][0] and
            not any(event['sequence'] > before_sequence and event['event'] == 'onHide' for event in retired_events),
            'Retired page and cross-page unload journals disagree')
    require(json.loads(retired['geometries'][retired_unloads[0]['geometry']]) == exit_geometry,
            'Retired onUnload geometry differs from its complete cross-page observation')
    page_shows = [json.loads(value) for value in destination['events'] if json.loads(value)['sequence'] == shown[0][0]]
    require(len(page_shows) == 1 and page_shows[0]['event'] == 'onShow' and
            json.loads(destination['geometries'][page_shows[0]['geometry']]) == show_geometry,
            'Destination onShow geometry is not retained in both page and cross-page journals')
    return {'beforeSequence': before_sequence, 'departingKind': departing['kind'],
            'departingInstance': departing['instance'], 'unloadSequence': unloads[0][0],
            'destinationInstance': destination['instance'], 'onShowSequence': shown[0][0],
            'exitGeometry': exit_geometry, 'destinationGeometry': show_geometry}


def installed_apk_path(path):
    """Accept package-manager paths, including Android's randomized ~~ dirs.

    Keep every shell-delivered component literal and bounded; no traversal,
    control characters, whitespace, quoting, expansions or empty segments.
    """
    require(isinstance(path, str) and len(path) <= 2048 and path.startswith('/data/app/') and
            path.endswith('.apk'), 'installed APK path is bounded')
    components = path[len('/data/app/'):].split('/')
    require(1 <= len(components) <= 8 and all(part not in ('', '.', '..') and
            re.fullmatch(r'[A-Za-z0-9_+=.~\-]+', part) for part in components),
            'installed APK path is bounded')
    return path


def android_density(output):
    values = dict(re.findall(r'^(Physical|Override) density:\s*([1-9][0-9]*)\s*$', output, re.M))
    require('Physical' in values, 'Android wm density lacks an independent native observation')
    return int(values.get('Override', values['Physical'])) / 160


def validate_native_geometry(result, surface, capsule, density):
    presentation_identity(result)
    state = native_state(result)
    layout = state['acceptedLayout']
    metrics, chrome = layout['windowMetrics'], layout['chrome']
    close_enough(metrics['pixelRatio'], density, 1e-6, 'native density versus guest pixelRatio')
    content, menu = chrome['contentRect'], chrome['menuButtonRect']
    for key in ('width', 'height'):
        close_enough(state['viewport'][key], metrics['window' + key.title()], 0, 'viewport.' + key)
        close_enough(state['observedViewport'][key], metrics['window' + key.title()], 0, 'observedViewport.' + key)
        close_enough(metrics['window' + key.title()], content[key], .501, 'logical content ' + key)
    x0, y0, x1, y1 = surface
    for actual, expected, label in ((x0, content['left'], 'surface left'), (y0, content['top'], 'surface top'),
                                    (x1 - x0, content['width'], 'surface width'), (y1 - y0, content['height'], 'surface height')):
        close_enough(actual, expected * density, 2, label + ' from independent density')
    # Flutter exposes 44dp accessible hit buttons around a centered 88x32dp
    # painted capsule. Compare its center/span rather than pretending AX gives
    # the painted top/bottom. Two physical pixels allow edge rounding only.
    mx0, my0, mx1, my1 = capsule
    close_enough(mx1 - mx0, 88 * density, 2, 'capsule AX horizontal span')
    close_enough(my1 - my0, 44 * density, 2, 'capsule AX hit height')
    close_enough(menu['width'], 88, 1e-6, 'painted capsule width contract')
    close_enough(menu['height'], 32, 1e-6, 'painted capsule height contract')
    close_enough(mx0, menu['left'] * density, 2, 'capsule independent left')
    close_enough(mx1, menu['right'] * density, 2, 'capsule independent right')
    close_enough((my0 + my1) / 2, (menu['top'] + menu['bottom']) * density / 2, 2, 'capsule independent vertical center')
    return {'density': density, 'surfacePhysical': list(surface), 'capsuleHitPhysical': list(capsule),
            'acceptedLayoutIdentity': list(presentation_identity(result)), 'edgeRoundingTolerancePhysical': 2}


def require_view_fault(before, after):
    a, b = native_state(before), native_state(after)
    require(presentation_identity(before, False) == presentation_identity(after, False), 'View fault changed accepted ownership')
    health = b.get('executionHealth', {})
    fault = health.get('viewFault') or {}
    require(health.get('requiresRestart') is True and fault.get('domain') == 'view' and
            fault.get('code') == 'ERR_TIMEOUT' and fault.get('requiresRestart') is True and
            health.get('appServiceFault') is None and health.get('navigationFault') is None,
            'Expected isolated typed View timeout, not an unrelated diagnostic')
    require(a.get('foreground') is True and b.get('foreground') is True and
            b.get('inputEnabled') is False and b.get('presentationEnabled') is False,
            'View fault must revoke input/presentation without backgrounding AppService')


class ViewRestartContractError(RuntimeError):
    """An explicit recovery lost its identity or original deadline; never retry it."""


def _view_restart_attempt(attempt, publication, old, accepted):
    require(isinstance(attempt, dict) and type(attempt.get('schemaVersion')) is int and
            attempt['schemaVersion'] == 1 and
            all(attempt.get(key) == publication.get(key) for key in ('projectId', 'runId', 'generation')) and
            attempt.get('targetRoot') == accepted['root'],
            'View restart lacks an exact Player-observed native attempt')
    receipt = attempt.get('receipt')
    require(isinstance(receipt, dict) and type(receipt.get('schemaVersion')) is int and
            receipt['schemaVersion'] == 1 and receipt.get('ownerId') == old['ownerId'] and
            receipt.get('targetRoot') == accepted['root'] and receipt.get('error') is None and
            not receipt.get('observationErrors'),
            'View restart receipt changed ownership or contains an error')
    decimal(receipt.get('ownerId'))
    decimal(receipt.get('attemptId'))
    return receipt


def _view_restart_context(baseline, observed, device_id):
    require_view_fault(baseline, baseline)
    old = native_state(baseline)
    data = baseline['snapshot']['pages'][-1].get('data', {})
    require(data.get('fixtureVersion') == 1 and data.get('triggerViewFault') is True,
            'View restart requires the explicitly injected fixture View fault')
    for result in (baseline, observed):
        require(isinstance(result, dict) and result.get('status') == 'completed' and
                isinstance(result.get('requestId'), str) and
                re.fullmatch(r'[A-Za-z0-9_-]{1,128}', result['requestId']) is not None and
                result.get('deviceId') == device_id and isinstance(device_id, str) and bool(device_id) and
                all(isinstance(result.get(key), str) and bool(result[key]) for key in ('projectId', 'runId')) and
                result.get('error') is None, 'View restart needs exact completed inspection envelopes')
        decimal(result.get('generation'))
    publication = baseline['snapshot']['acceptedPack']
    require(all(observed.get(key) == baseline.get(key) == publication.get(key)
                for key in ('projectId', 'runId', 'generation')) and
            observed['requestId'] != baseline['requestId'],
            'View restart belongs to a different inspection/publication')
    accepted = old['acceptedPackIdentity']
    require(isinstance(accepted.get('root'), str) and re.fullmatch(r'[a-f0-9]{64}', accepted['root']) is not None,
            'View restart needs the exact accepted root')
    previous = baseline['snapshot'].get('developmentAttempt')
    receipt = _view_restart_attempt(previous, publication, old, accepted)
    require(previous.get('resolution') == 'terminal' and receipt.get('status') == 'accepted' and
            receipt.get('acceptedPackIdentity') == accepted,
            'View restart needs the prior accepted native attempt')
    return old, accepted, publication, receipt


def require_pending_view_restart(baseline, observed, device_id):
    """Only this exact prepared restart is a wait reason, never frame authority."""
    old, accepted, publication, previous = _view_restart_context(baseline, observed, device_id)
    snapshot = observed.get('snapshot')
    require(isinstance(snapshot, dict) and snapshot.get('pages') == [] and 'state' not in snapshot and
            'acceptedPack' in snapshot and snapshot['acceptedPack'] is None,
            'Only the exact metadata-only restart snapshot may remain pending')
    attempt = snapshot.get('developmentAttempt')
    receipt = _view_restart_attempt(attempt, publication, old, accepted)
    require(attempt.get('resolution') == 'pending' and attempt.get('source') == 'begin' and
            receipt.get('status') == 'prepared' and receipt.get('operation') == 'applyDevPack' and
            receipt.get('reloadKind') == 'restart' and receipt.get('expectedAccepted') == accepted and
            receipt.get('acceptedPackIdentity') == accepted and
            decimal(receipt['attemptId']) > decimal(previous['attemptId']),
            'Not a new prepared restart of the exact faulted accepted pack')
    return (receipt['ownerId'], receipt['attemptId'], accepted['root'],
            accepted['acceptedPackRevision'], accepted['sessionId'])


def require_completed_view_restart(baseline, observed, device_id, pending=None):
    """A healthy frame cannot replace the terminal receipt for this operation."""
    try:
        old, accepted, publication, previous = _view_restart_context(baseline, observed, device_id)
        attempt = observed['snapshot'].get('developmentAttempt')
        receipt = _view_restart_attempt(attempt, publication, old, accepted)
        current = native_state(observed)
        identity = current.get('acceptedPackIdentity')
        require(attempt.get('resolution') == 'terminal' and attempt.get('source') in ('apply', 'query', 'event') and
                receipt.get('status') == 'accepted' and receipt.get('operation') == 'applyDevPack' and
                receipt.get('reloadKind') == 'restart' and receipt.get('expectedAccepted') == accepted and
                isinstance(identity, dict) and receipt.get('acceptedPackIdentity') == identity and
                current.get('ownerId') == old['ownerId'] and identity.get('root') == accepted['root'] and
                identity.get('sessionId') != accepted['sessionId'] and
                decimal(identity.get('acceptedPackRevision')) > decimal(accepted['acceptedPackRevision']) and
                decimal(receipt['attemptId']) > decimal(previous['attemptId']),
                'View restart is not the exact accepted new session/pack/owner/attempt')
        completed = (receipt['ownerId'], receipt['attemptId'], accepted['root'],
                     accepted['acceptedPackRevision'], accepted['sessionId'])
        require(pending is None or completed == pending, 'View restart completion changed the observed pending attempt')
        return completed
    except (RuntimeError, KeyError, TypeError) as error:
        raise ViewRestartContractError(str(error)) from None


def require_view_restart_observation(baseline, observed, device_id, pending=None):
    """Reject an unknown/failed/foreign operation even before a frame is ready."""
    try:
        old, accepted, publication, previous = _view_restart_context(baseline, observed, device_id)
        attempt = observed.get('snapshot', {}).get('developmentAttempt')
        receipt = _view_restart_attempt(attempt, publication, old, accepted)
        if (attempt.get('resolution') == 'terminal' and receipt.get('status') == 'accepted' and
                receipt.get('attemptId') == previous['attemptId'] and receipt.get('acceptedPackIdentity') == accepted):
            require(pending is None, 'View restart regressed to its prior accepted operation')
            return None  # still the old faulted frame; it has no recovery authority
        return require_completed_view_restart(baseline, observed, device_id, pending)
    except (RuntimeError, KeyError, TypeError) as error:
        raise ViewRestartContractError(str(error)) from None


def require_candidate_rejection(baseline, observed, candidate):
    old, current = presentation_identity(baseline), presentation_identity(observed)
    require(current[:4] == old[:4] and current[7] == old[7], 'Rejected candidate changed the accepted SDK session/pack/owner/page')
    attempt = observed.get('snapshot', {}).get('developmentAttempt')
    require(isinstance(attempt, dict), 'C018 needs the actual Player-observed native development attempt')
    require(attempt.get('resolution') == 'terminal', 'C018 cannot pass a pending or unknown native outcome')
    require(attempt.get('projectId') == candidate.get('projectId') == baseline.get('projectId') == observed.get('projectId') and
            attempt.get('runId') == candidate.get('runId') == baseline.get('runId') == observed.get('runId'),
            'Candidate receipt is not bound to the same service run/project')
    require(attempt.get('generation') == candidate.get('generation') and
            decimal(attempt.get('generation')) > decimal(baseline['snapshot']['acceptedPack'].get('generation')) and
            attempt.get('targetRoot') == candidate.get('integrityRoot') and attempt.get('targetRoot') != old[1],
            'Candidate receipt does not identify the distinct published candidate generation/root')
    receipt = attempt.get('receipt', {})
    require(receipt.get('status') == 'rejected' and receipt.get('operation') == 'applyDevPack' and
            receipt.get('reloadKind') == 'restart' and receipt.get('targetRoot') == attempt['targetRoot'],
            'C018 needs a real terminal rejected restart receipt')
    require(decimal(receipt.get('ownerId')) == old[3], 'Rejected attempt belongs to a different SDK owner')
    decimal(receipt.get('attemptId'))
    previous = baseline.get('snapshot', {}).get('developmentAttempt')
    if isinstance(previous, dict) and previous.get('receipt', {}).get('ownerId') == receipt['ownerId']:
        require(decimal(receipt['attemptId']) > decimal(previous['receipt'].get('attemptId')), 'Reused stale native candidate attempt')
    accepted = native_state(baseline)['acceptedPackIdentity']
    require(receipt.get('expectedAccepted') == accepted and receipt.get('acceptedPackIdentity') == accepted and
            native_state(observed)['acceptedPackIdentity'] == accepted and
            observed['snapshot']['acceptedPack'] == baseline['snapshot']['acceptedPack'],
            'Native rejection did not preserve exact accepted ownership/publication')
    error = receipt.get('error') or {}
    require(isinstance(error.get('code'), str) and error['code'].startswith('ERR_') and
            'P0_CANDIDATE_STARTUP_FAILURE' in error.get('message', ''),
            'C018 requires the original candidate startup exception, not a cancellation or unrelated failure')
    return attempt


def utc():
    return datetime.now(timezone.utc).isoformat()


def scrub(value):
    if isinstance(value, str):
        return re.sub(r'weapp-container://\S+|Bearer\s+\S+|(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+', '[redacted]', value)
    if isinstance(value, list):
        return [scrub(item) for item in value]
    if isinstance(value, dict):
        return {key: '[redacted]' if re.search(r'token|password|secret|authorization|cookie|credential|private.?key', key, re.I) else scrub(item)
                for key, item in value.items()}
    return value


def write_json(path, value):
    path.write_text(json.dumps(scrub(value), ensure_ascii=False, indent=2) + '\n')


def write_private_raw(path, data):
    """Keep unredacted native evidence private and never replace an original."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as file:
        os.fchmod(file.fileno(), 0o600)
        file.write(data)


class InspectionWitnessStore:
    """Retain existing completed polls without issuing another inspector call.

    Every completed snapshot and its receipt live in a separate directory. Only
    healthy native-owner snapshots are mirrored beside explicit captures for
    the existing non-recursive layout-proof monitor. Intentional fault evidence
    keeps its canonical capture names; a poll never manufactures that authority.
    Nothing is evicted, and exhausting either budget fails the run explicitly.
    """
    def __init__(self, out, max_count=2048, max_bytes=128 * 1024 * 1024,
                 max_snapshot_bytes=2 * 1024 * 1024):
        require(all(isinstance(value, int) and not isinstance(value, bool) and value > 0
                    for value in (max_count, max_bytes, max_snapshot_bytes)),
                'Invalid inspection witness limits')
        self.out = Path(out)
        self.directory = self.out / 'poll-witnesses'
        self.directory.mkdir(mode=0o700)
        self.max_count, self.max_bytes = max_count, max_bytes
        self.max_snapshot_bytes = max_snapshot_bytes
        self.count, self.bytes_written = 0, 0
        self.requests = set()

    @staticmethod
    def _layout_proof_eligible(result):
        state = result.get('snapshot', {}).get('state')
        if not isinstance(state, dict) or state.get('schemaVersion') != 1 or state.get('status') != 'ready':
            return False
        surface, health = state.get('hostSurface'), state.get('executionHealth')
        owner = state.get('ownerId')
        if (not isinstance(surface, dict) or surface.get('ownerId') != owner or
                not isinstance(health, dict) or health.get('schemaVersion') != 1 or
                health.get('requiresRestart') is not False or
                not all(key in health and health[key] is None for key in
                        ('appServiceFault', 'viewFault', 'navigationFault'))):
            return False
        try:
            decimal(owner)
            decimal(surface.get('surfaceGeneration'))
        except RuntimeError:
            return False
        # This is eligibility only. The unchanged monitor still has to prove
        # the exact submitted owner/surface/observation/revision was superseded.
        return True

    @staticmethod
    def _atomic_write(path, data):
        require(not path.exists(), 'Inspection witness must not replace existing evidence')
        descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', suffix='.part', dir=path.parent)
        try:
            with os.fdopen(descriptor, 'wb') as file:
                os.fchmod(file.fileno(), 0o600)
                file.write(data)
                file.flush()
                os.fsync(file.fileno())
            # Only a complete file becomes visible to the monitor. The output
            # directory and sequence have one runner owner; names never repeat.
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def record(self, result, *, request_id, device_id, started_ns, received_ns,
               deadline_ns, wire_sha256, wire_bytes):
        require(isinstance(request_id, str) and
                re.fullmatch(r'[A-Za-z0-9_-]{1,128}', request_id) is not None,
                'Invalid inspection witness request identity')
        require(isinstance(result, dict) and result.get('status') == 'completed' and
                result.get('requestId') == request_id,
                'Completed inspection witness request does not match')
        require(result.get('deviceId') == device_id and isinstance(result.get('snapshot'), dict),
                'Completed inspection witness device or snapshot does not match')
        require(all(isinstance(value, int) and not isinstance(value, bool) for value in
                    (started_ns, received_ns, deadline_ns)) and
                0 <= started_ns <= received_ns < deadline_ns,
                'Inspection witness response exceeded its original deadline')
        require(isinstance(wire_sha256, str) and re.fullmatch(r'[a-f0-9]{64}', wire_sha256) is not None and
                isinstance(wire_bytes, int) and not isinstance(wire_bytes, bool) and
                0 < wire_bytes <= 2 * 1024 * 1024,
                'Missing exact inspection HTTP byte binding')
        require(request_id not in self.requests, 'Inspection witness duplicate request')
        require(self.count < self.max_count, 'Inspection witness count limit exceeded')
        encoded = (json.dumps(scrub(result), ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode()
        require(len(encoded) <= self.max_snapshot_bytes, 'Inspection witness snapshot limit exceeded')
        sequence = self.count + 1
        snapshot = self.directory / ('poll-%06d.snapshot.json' % sequence)
        receipt = self.directory / ('poll-%06d.json' % sequence)
        mirror = self.out / ('poll-%06d.inspect.json' % sequence) if self._layout_proof_eligible(result) else None
        snapshot_hash = hashlib.sha256(encoded).hexdigest()
        metadata = {
            'schemaVersion': 1, 'kind': 'existing-completed-inspection-poll',
            'sequence': sequence, 'requestId': request_id, 'deviceId': device_id,
            'requestedMonotonicNs': started_ns, 'receivedMonotonicNs': received_ns,
            'deadlineMonotonicNs': deadline_ns, 'persistedAt': utc(),
            'wire': {'sha256': wire_sha256, 'bytes': wire_bytes},
            'snapshot': {'path': str(snapshot.relative_to(self.out)), 'sha256': snapshot_hash,
                         'bytes': len(encoded)},
            'publishedForLayoutProof': mirror is not None,
            'layoutProofMirror': None if mirror is None else {
                'path': mirror.name, 'sha256': snapshot_hash, 'bytes': len(encoded)},
            'publicationPolicy': 'healthy-native-owner-only; faults retain canonical capture authority',
            'additionalInspectorRequests': 0,
        }
        receipt_bytes = (json.dumps(metadata, ensure_ascii=False, indent=2) + '\n').encode()
        total = len(encoded) * (2 if mirror is not None else 1) + len(receipt_bytes)
        require(self.bytes_written + total <= self.max_bytes, 'Inspection witness byte limit exceeded')
        # A healthy mirror becomes visible only after both complete evidence
        # files. Fault/unknown states remain intact in the witness directory.
        self._atomic_write(snapshot, encoded)
        self._atomic_write(receipt, receipt_bytes)
        if mirror is not None:
            self._atomic_write(mirror, encoded)
        self.requests.add(request_id)
        self.count, self.bytes_written = sequence, self.bytes_written + total
        return metadata


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('Admin endpoint redirects are forbidden')


class Runner:
    def __init__(self, args):
        self.args = args
        self.out = Path(args.out).resolve()
        self.out.mkdir(parents=True, exist_ok=False)
        self.index = 0
        self.secret = None
        self.device = None
        self.owner_validated = False
        self.opener = urllib.request.build_opener(NoRedirect)
        self.restores = {}
        self.posture_changed = False
        self.physical_mapping = None
        self.physical_submitted = False
        self.posture_readback_index = 0
        self.layout_observations = {}
        self.last_page = None
        self.native_index = 0
        self.native_binding = None
        self._inspection_wire = None
        self.inspection_witnesses = InspectionWitnessStore(self.out)
        self.report = {'schemaVersion': 1, 'status': 'running', 'startedAt': utc(), 'plan': PLAN,
                       'adbCleanupUncertain': False,
                       'stage': args.stage,
                       'owner': {'serial': args.serial, 'avd': args.avd, 'deviceId': args.device_id,
                                 'createdByHarness': False, 'serverCreatedByHarness': False,
                                 'retainedReason': 'caller-owned simulator and development service'},
                       'apkSha256': args.apk_sha256, 'cycles': args.cycles, 'checks': [], 'commands': [], 'cleanup': []}
        self.save()

    def save(self):
        write_json(self.out / 'report.json', self.report)

    def _cleanup_adb_child(self, process, command, original_error):
        """Bounded cleanup shared by deadlines and catchable interruptions."""
        cleanup = {'resource': 'owned ADB child', 'status': 'unknown',
            'childPid': process.pid, 'processGroupId': process.pid, 'argv': command,
            'originalException': type(original_error).__name__,
            'pipeEofConfirmed': False, 'childReaped': False, 'ownedPipesClosed': False,
            'drainTimeoutSeconds': 1, 'reapTimeoutSeconds': 1}
        output = (original_error.output or b'') if isinstance(original_error, subprocess.TimeoutExpired) else b''
        stderr = (original_error.stderr or b'') if isinstance(original_error, subprocess.TimeoutExpired) else b''
        try:
            os.killpg(process.pid, signal.SIGKILL)
            cleanup['killGroupOutcome'] = 'signal-sent'
        except ProcessLookupError:
            cleanup['killGroupOutcome'] = 'already-gone'
        except BaseException as error:
            cleanup['killGroupOutcome'] = 'error'
            cleanup['killGroupError'] = type(error).__name__ + ': ' + str(error)
        try:
            output, stderr = process.communicate(timeout=1)
            cleanup['pipeEofConfirmed'] = True
        except BaseException as error:
            cleanup['drainError'] = type(error).__name__ + ': ' + str(error)
            if isinstance(error, subprocess.TimeoutExpired):
                output, stderr = error.output or output, error.stderr or stderr
        finally:
            pipe_errors = []
            for name in ('stdout', 'stderr'):
                pipe = getattr(process, name, None)
                if pipe is not None:
                    try:
                        pipe.close()
                    except BaseException as error:
                        pipe_errors.append(name + ': ' + type(error).__name__ + ': ' + str(error))
            cleanup['ownedPipesClosed'] = not pipe_errors
            if pipe_errors:
                cleanup['pipeCloseErrors'] = pipe_errors
        try:
            process.wait(timeout=1)
            cleanup['childReaped'] = process.returncode is not None
        except BaseException as error:
            cleanup['reapError'] = type(error).__name__ + ': ' + str(error)
        if (cleanup['pipeEofConfirmed'] and cleanup['childReaped'] and cleanup['ownedPipesClosed']
                and 'killGroupError' not in cleanup):
            cleanup['status'] = 'closed'
        return output, stderr, cleanup

    def adb(self, *args, timeout=20, binary=False, check=True):
        # The configured ADB may be an ownership guard which spawns children.
        # A deadline must stop that owned process tree, not leave its final ADB
        # command running after only the guard parent has been killed.
        command = [self.args.adb, '-s', self.args.serial, *args]
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            output, stderr = process.communicate(timeout=timeout)
        except BaseException as original_error:
            output, stderr, cleanup = self._cleanup_adb_child(process, command, original_error)
            self.report['adbCleanupUncertain'] = self.report.get('adbCleanupUncertain', False) or cleanup['status'] == 'unknown'
            self.report.setdefault('cleanup', []).append(cleanup)
            try:
                self.report['commands'].append({'at': utc(), 'args': list(args), 'exitCode': process.returncode,
                    'status': ('deadline-expired' if isinstance(original_error, subprocess.TimeoutExpired) else 'interrupted')
                              + '-owned-process-group-cleanup',
                    'stdout': '<binary>' if binary else output.decode('utf8', 'replace')[-4096:],
                    'stderr': stderr.decode('utf8', 'replace')[-2048:], 'cleanup': cleanup})
                self.save()
            finally:
                raise original_error
        stdout = output if binary else output.decode('utf8', 'replace')
        self.report['commands'].append({'at': utc(), 'args': list(args), 'exitCode': process.returncode,
                                        'stdout': '<binary>' if binary else stdout[-4096:],
                                        'stderr': stderr.decode('utf8', 'replace')[-2048:]})
        self.save()
        if check and process.returncode:
            raise RuntimeError('ADB command failed: ' + ' '.join(args[:3]))
        return stdout

    def api(self, path, value=None, auth=True, remaining=None):
        self._inspection_wire = None
        headers = {'Origin': self.args.admin}
        if auth:
            headers['Authorization'] = 'Bearer ' + self.secret
        if value is not None:
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(self.args.admin + path, headers=headers,
                                         data=None if value is None else json.dumps(value).encode())
        def read(response):
            if remaining is None:
                return response.read(2 * 1024 * 1024 + 1)
            stream = response.fp if isinstance(response, urllib.error.HTTPError) else response
            chunks, length = [], 0
            while length <= 2 * 1024 * 1024:
                budget = remaining()
                if getattr(stream, 'length', None) == 0 or (chunks and stream.isclosed()):
                    break
                socket = getattr(getattr(getattr(stream, 'fp', None), 'raw', None), '_sock', None)
                require(socket is not None and callable(getattr(stream, 'read1', None)),
                        'Deadline-bound local HTTP transport is unavailable')
                socket.settimeout(min(8, budget))
                chunk = stream.read1(min(65536, 2 * 1024 * 1024 + 1 - length))
                remaining()
                if not chunk:
                    break
                chunks.append(chunk)
                length += len(chunk)
            return b''.join(chunks)
        try:
            with self.opener.open(request, timeout=min(8, remaining()) if remaining is not None else 8) as response:
                data = read(response)
        except urllib.error.HTTPError as error:
            data = read(error)
            try:
                code = json.loads(data).get('error')
            except (ValueError, AttributeError):
                code = None
            raise RuntimeError('Admin request rejected: ' + (code if isinstance(code, str) and re.fullmatch(r'ERR_[A-Z0-9_]+', code) else str(error.code))) from None
        if len(data) > 2 * 1024 * 1024:
            raise RuntimeError('Admin response exceeded test budget')
        result = json.loads(data) if auth else data.decode('utf8')
        if auth and path.startswith('/inspections/'):
            self._inspection_wire = {'path': path, 'sha256': hashlib.sha256(data).hexdigest(),
                                     'bytes': len(data)}
        return result

    def assert_(self, condition, name, **details):
        self.report['checks'].append({'name': name, 'status': 'passed' if condition else 'failed', **details})
        self.save()
        if not condition:
            raise AssertionError(name)

    def preflight(self):
        qemu = self.adb('shell', 'getprop', 'ro.kernel.qemu').strip()
        self.assert_(qemu == '1', 'target is an Android emulator')
        avd = self.adb('emu', 'avd', 'name').splitlines()[0].strip()
        self.assert_(avd == self.args.avd, 'AVD ownership matches explicit name', actual=avd)
        self.owner_validated = True
        if self.args.physical_posture_mapping:
            with Path(self.args.physical_posture_mapping).open('rb') as mapping_file:
                mapping_raw = mapping_file.read(65537)
            self.physical_mapping = physical_posture_mapping(mapping_raw, self.args.physical_posture_mapping_sha256, self.args.avd)
            self.report['physicalPostureMapping'] = {'sha256': self.physical_mapping.sha256,
                'evidenceSha256': self.physical_mapping.evidence_sha256, 'avd': self.physical_mapping.avd,
                'sensor': self.physical_mapping.sensor, 'requiredCommittedStates': self.physical_mapping.required_states,
                'steps': [posture_contract_json(item) for item in self.physical_mapping.steps],
                'sameSizeHostObservationAcknowledgement': 'not proved without an independent native host ID',
                'scope': 'sampled emulator physical angles and Android states; no hardware-device claim'}
        paths = self.adb('shell', 'pm', 'path', PACKAGE).splitlines()
        self.assert_(len(paths) == 1 and paths[0].startswith('package:/data/app/'), 'single installed Player APK path')
        apk = paths[0][len('package:'):].strip()
        installed_apk_path(apk)
        self.assert_(True, 'installed APK path is bounded')
        actual = self.adb('shell', 'sha256sum', apk).split()[0]
        self.assert_(actual == self.args.apk_sha256, 'installed APK matches reviewed build', actual=actual)
        self.native_binding = mapping_binding(self.args.mapping, self.args.mapping_sha256, self.args.apk, self.args.apk_sha256)
        self.report['nativeMappingBinding'] = self.native_binding
        self.report['environment'] = {key: self.adb('shell', 'getprop', key).strip() for key in
                                      ('ro.build.version.release', 'ro.build.version.sdk', 'ro.product.cpu.abi', 'ro.product.model')}
        self.report['environment']['wmSize'] = self.adb('shell', 'wm', 'size').strip()
        self.report['environment']['wmDensity'] = self.adb('shell', 'wm', 'density').strip()
        html = self.api('/', auth=False)
        match = re.search(r'const key=("[^"\n]+")', html)
        if not match:
            raise RuntimeError('Dashboard admin key not found; use the matching local service')
        self.secret = json.loads(match.group(1))
        state = self.api('/state')
        device = next((item for item in state['devices'] if item['id'] == self.args.device_id), None)
        self.assert_(device is not None and device['connected'] and device.get('platform') == 'android',
                     'explicit Android device is already paired/connected')
        self.report['deviceAssociation'] = {'status': 'pending', 'method': 'actual emulator input correlated with explicit device inspector'}
        self.report['initialProject'] = state['project']
        for key in ('accelerometer_rotation', 'user_rotation'):
            self.restores[key] = self.adb('shell', 'settings', 'get', 'system', key).strip()
        self.adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0')
        if self.args.postures:
            self.report['initialDeviceState'] = self.adb('shell', 'cmd', 'device_state', 'state')
            self.report['postureControlDomain'] = 'android-device-state-override-only; no physical folding claim'
        if self.physical_mapping is not None:
            actual = self.read_posture_actual()
            self.assert_(posture_actual_readback(self.physical_mapping.initial, actual)[0],
                         'physical baseline exactly matches the explicit reviewed initial angle/base/committed profile')
        self.save()

    def read_posture_actual(self, remaining=None):
        def adb(*args):
            return self.adb(*args, timeout=min(20, remaining()) if remaining is not None else 20)
        state_raw = adb('shell', 'dumpsys', 'device_state')
        result = android_state_readback(state_raw)
        raws = [('state', state_raw)]
        if self.physical_mapping is not None:
            raw = adb('emu', 'sensor', 'get', self.physical_mapping.sensor)
            result['physicalAngle'] = hinge_angle_readback(raw, self.physical_mapping.sensor)._asdict()
            raws.append(('hinge', raw))
        self.posture_readback_index += 1
        files = []
        for name, raw in raws:
            encoded = raw.encode('utf8')
            path = self.out / ('posture-actual-%04d-%s.private.txt' % (self.posture_readback_index, name))
            write_private_raw(path, encoded)
            files.append({'path': path.name, 'bytes': len(encoded), 'sha256': hashlib.sha256(encoded).hexdigest()})
        self.report.setdefault('postureActualReadbacks', []).append({'sequence': self.posture_readback_index,
            'actual': result, 'files': files, 'at': utc()})
        self.save()
        return result

    def submit_physical_posture(self, contract, remaining):
        mapping = self.physical_mapping
        require(mapping is not None and contract.mapping_sha256 == mapping.sha256
                and (contract in mapping.steps or contract == mapping.restore),
                'Physical operation is not admitted by this exact reviewed mapping')
        self.physical_submitted = True
        if contract.operation in ('fold', 'unfold'):
            args = ('emu', contract.operation)
        else:
            require(contract.operation in ('hinge-angle-set', 'sensor-restore'), 'Unknown physical operation')
            args = ('emu', 'sensor', 'set', mapping.sensor, contract.physical_angle.value)
        self.adb(*args, timeout=min(20, remaining()))
        return {'controlDomain': contract.control_domain.value, 'target': posture_target(contract),
                'mappingSha256': mapping.sha256, 'exitCode': 0}

    def transition_physical_posture(self, before, index):
        mapping = self.physical_mapping
        require(mapping is not None, 'Explicit physical mapping is required')
        position = index % len(mapping.steps)
        contract, from_profiles = mapping.steps[position], mapping.from_profiles[position]
        deadline = time.monotonic() + 15
        def remaining():
            budget = deadline - time.monotonic()
            if budget <= 0:
                raise PostureDeadlineError('Physical transition baseline exhausted its original fifteen second budget')
            return budget
        # Fresh independent baseline facts are taken before the single setter.
        baseline_actual = self.read_posture_actual(remaining)
        baseline_native = self.measure_native_geometry(remaining, include_safe_area=True)
        confirmed = self.inspection(remaining)
        baseline_confirmed = self.read_posture_actual(remaining)
        require(posture_actual_readback(contract, baseline_actual)[1] == posture_actual_readback(contract, baseline_confirmed)[1],
                'Physical baseline actual identity changed while independently measuring native geometry')
        require(presentation_identity(before) == presentation_identity(confirmed),
                'Physical baseline layout changed while measuring native geometry')
        if from_profiles is not None:
            require(any(posture_actual_readback(profile, baseline_actual)[0] for profile in from_profiles),
                    'Actual from profile is not admitted for this physical edge/window contract')
        outcome = await_posture_transition(posture_contract_json(contract), confirmed, baseline_native, baseline_actual,
            submit=lambda remaining: self.submit_physical_posture(contract, remaining),
            read_actual=self.read_posture_actual,
            measure_native=lambda remaining: self.measure_native_geometry(remaining, include_safe_area=True),
            inspect_runtime=self.inspection, transition_deadline=deadline)
        for identity, layout in outcome['layoutTransactions']:
            self.layout_observations[tuple(identity)] = layout
        self.last_page = outcome['result']
        self.report.setdefault('physicalPostureTransitions', []).append({'cycle': index, **outcome['postureEvidence']})
        self.assert_(True, 'cycle %d: actual physical/Android edge and independent native/runtime geometry validated' % index,
                     observedWindowEffect=outcome['postureEvidence']['observedWindowEffect'],
                     layoutChangingFoldRound=outcome['postureEvidence']['layoutChangingFoldRound'])
        return outcome['result']

    def restore_physical_posture(self):
        # Cleanup restores the explicit initial sensor value, even after a
        # runtime failure. It makes no runtime presentation or E2E pass claim.
        contract = self.physical_mapping.restore
        deadline = time.monotonic() + 15
        def remaining():
            budget = deadline - time.monotonic()
            if budget <= 0:
                raise PostureDeadlineError('Explicit physical cleanup restore deadline expired')
            return budget
        actual = self.read_posture_actual(remaining)
        if posture_actual_readback(contract, actual)[0]:
            return {'status': 'already-at-explicit-initial-profile', 'runtimePresentationClaim': False}
        receipt = self.submit_physical_posture(contract, remaining)
        previous = None
        while remaining() > 0:
            current = self.read_posture_actual(remaining)
            ready, identity = posture_actual_readback(contract, current)
            if ready and identity == previous:
                return {'status': 'restored', 'receipt': receipt, 'actualIdentity': identity,
                        'stableSamples': 2, 'runtimePresentationClaim': False}
            previous = identity if ready else None
            time.sleep(min(.15, remaining()))

    def foreground(self, remaining=None):
        activities = self.adb('shell', 'dumpsys', 'activity', 'activities',
                              **({'timeout': min(20, remaining())} if remaining is not None else {}))
        lines = [line for line in activities.splitlines() if 'mResumedActivity' in line or 'topResumedActivity' in line]
        if not any(PACKAGE in line for line in lines):
            raise RuntimeError('Player is not foreground; refusing to capture or tap another app')

    def ui(self, remaining=None):
        self.foreground(remaining) if remaining is not None else self.foreground()
        remote = '/data/local/tmp/weapp-container-p0-' + self.args.serial + '.xml'
        self.adb('shell', 'uiautomator', 'dump', remote,
                 timeout=min(15, remaining()) if remaining is not None else 15)
        xml = self.adb('shell', 'cat', remote,
                       **({'timeout': min(20, remaining())} if remaining is not None else {}))
        self.adb('shell', 'rm', remote,
                 **({'timeout': min(20, remaining())} if remaining is not None else {}))
        return xml, ET.fromstring(xml)

    @staticmethod
    def bounds(node):
        match = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
        if not match:
            raise RuntimeError('Native UI node has no usable bounds')
        return tuple(map(int, match.groups()))

    def tap_ax(self, labels):
        _, root = self.ui()
        for node in root.iter('node'):
            if node.get('enabled') == 'true' and any(node.get(key) in labels for key in ('content-desc', 'text')):
                x0, y0, x1, y1 = self.bounds(node)
                self.adb('shell', 'input', 'tap', str((x0 + x1) // 2), str((y0 + y1) // 2))
                return
        raise RuntimeError('Required Player control is absent: ' + '/'.join(labels))

    def inspection(self, remaining=None):
        requested_ns = time.monotonic_ns()
        outer_deadline_ns = None if remaining is None else requested_ns + int(remaining() * 1_000_000_000)
        def api(path, value=None):
            return self.api(path, value, remaining=remaining) if remaining is not None else self.api(path, value)
        start = api('/inspect', {'deviceId': self.args.device_id})
        request_id = start.get('requestId')
        if (start.get('status') != 'pending' or not isinstance(request_id, str) or
                re.fullmatch(r'[A-Za-z0-9_-]{1,128}', request_id) is None):
            raise RuntimeError('Read-only inspector request failed: ' + str(start.get('error', 'ERR_DEV_INSPECT_FAILED')))
        deadline_ns = time.monotonic_ns() + 7_000_000_000
        if outer_deadline_ns is not None:
            deadline_ns = min(deadline_ns, outer_deadline_ns)
        path = '/inspections/' + request_id
        while time.monotonic_ns() < deadline_ns:
            if remaining is not None:
                remaining()
            result = api(path)
            received_ns = time.monotonic_ns()
            if result['status'] == 'completed':
                wire = self._inspection_wire
                require(isinstance(wire, dict) and wire.get('path') == path,
                        'Missing exact inspection HTTP response binding')
                self.inspection_witnesses.record(
                    result, request_id=request_id, device_id=self.args.device_id,
                    started_ns=requested_ns, received_ns=received_ns, deadline_ns=deadline_ns,
                    wire_sha256=wire['sha256'], wire_bytes=wire['bytes'])
                return result
            if result['status'] != 'pending':
                raise RuntimeError('Read-only inspector failed: ' + str(result.get('error')))
            time.sleep(min(.1, remaining()) if remaining is not None else .1)
        raise RuntimeError('Read-only inspector response timeout')

    @staticmethod
    def current(result):
        pages = result.get('snapshot', {}).get('pages', [])
        if not pages:
            raise RuntimeError('No active page in read-only inspector')
        return pages[-1]

    @staticmethod
    def observations(page):
        data = page['data']
        events = [json.loads(item) for item in data['events']]
        geometry = json.loads(data['geometries'][events[-1]['geometry']])
        return events, geometry

    def measure_native_geometry(self, remaining=None, include_safe_area=False):
        """Collect native facts before comparing them with any accepted SDK layout."""
        # Future posture adapters pass their shared deadline into every command.
        # Ordinary callers keep the established per-command bounds.
        def adb(*args, **kwargs):
            if remaining is not None:
                kwargs['timeout'] = min(kwargs.get('timeout', 20), remaining())
            return self.adb(*args, **kwargs)
        _, xml = self.ui(remaining) if remaining is not None else self.ui()
        require(self.native_binding is not None, 'Actual APK/native view mapping must be bound before observing geometry')
        activity = adb('shell', 'dumpsys', 'activity', 'top')
        encoded = adb('exec-out', 'cmd', 'window', 'dump-visible-window-views', binary=True)
        gfxinfo = adb('shell', 'dumpsys', 'gfxinfo', PACKAGE)
        bounds, native_evidence = independent_bounds(activity, encoded, gfxinfo, PACKAGE, self.native_binding)
        raw_evidence = [('.activity.txt', activity.encode()), ('.window.zip', encoded), ('.gfxinfo.txt', gfxinfo.encode())]
        safe_area = None
        if include_safe_area:
            displays = adb('shell', 'dumpsys', 'window', 'displays')
            windows = adb('shell', 'dumpsys', 'window', 'windows')
            safe_area = window_safe_area_observation(displays, windows, activity, PACKAGE)
            raw_evidence.extend([('.displays.txt', displays.encode()), ('.windows.txt', windows.encode())])
        self.native_index += 1
        base = self.out / ('native-%03d' % self.native_index)
        paths = []
        for suffix, raw in raw_evidence:
            path = base.with_suffix(suffix)
            write_private_raw(path, raw)
            paths.append({'path': path.name, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)})
        native_evidence['files'] = paths
        controls = []
        for labels in (('更多', 'More'), ('关闭小程序', 'Close mini program')):
            matches = [node for node in xml.iter('node') if node.get('enabled') == 'true' and
                       any(node.get(key) in labels for key in ('content-desc', 'text'))]
            require(len(matches) == 1, 'A unique accessible capsule control is required: ' + '/'.join(labels))
            controls.append(self.bounds(matches[0]))
        capsule = (min(rect[0] for rect in controls), min(rect[1] for rect in controls),
                   max(rect[2] for rect in controls), max(rect[3] for rect in controls))
        density = android_density(adb('shell', 'wm', 'density'))
        measured = {'surfacePhysical': list(bounds), 'capsulePhysical': list(capsule),
                    'density': density, 'nativeWitness': native_evidence}
        if safe_area is not None:
            close_enough(density, safe_area['densityDpi'] / 160, 1e-6,
                         'independent wm density versus current display density')
            measured['displaySafeAreaPhysical'] = safe_area['displaySafeAreaPhysical']
            native_evidence['safeArea'] = safe_area
        return measured

    @staticmethod
    def validate_native_measurement(result, measured):
        observed = validate_native_geometry(result, measured['surfacePhysical'], measured['capsulePhysical'],
                                            measured['density'])
        if 'displaySafeAreaPhysical' in measured:
            # Posture adapters must provide independent OS safe-area evidence.
            # Do not fill missing native facts from the accepted guest values.
            native_window_fingerprint(measured)
            display = measured['nativeWitness']['display']
            metrics = native_state(result)['acceptedLayout']['windowMetrics']
            rotation_plan(display, metrics, measured['density'], display['rotation'])
            safe = metrics.get('safeArea', {})
            left, top, right, bottom = measured['displaySafeAreaPhysical']
            for key, physical in (('left', left), ('top', top), ('right', right), ('bottom', bottom),
                                  ('width', right-left), ('height', bottom-top)):
                value = safe.get(key)
                require(type(value) in (int, float), 'Accepted safe-area metric missing: ' + key)
                close_enough(value * measured['density'], physical, 2, 'native safeArea.' + key)
        observed['nativeWitness'] = measured['nativeWitness']
        result['nativeObservation'] = observed
        return observed

    def observe_native_geometry(self, result):
        return self.validate_native_measurement(result, self.measure_native_geometry())

    def wait_page(self, route, orientation=None, after=None, restart_after=None, display_rotation=None):
        deadline = time.monotonic() + 15
        previous = None
        last_reason = None
        pending_restart = None
        def require_restart_budget():
            if restart_after is not None and time.monotonic() >= deadline:
                raise ViewRestartContractError('View restart exceeded its original fifteen second deadline')
        if restart_after is not None:
            require(after is None, 'A View restart cannot also be a same-session layout transition')
            require_view_fault(restart_after, restart_after)
        baseline = after or self.last_page
        if baseline is not None:
            identity = presentation_identity(baseline, False)
            self.layout_observations[identity] = native_state(baseline)['acceptedLayout']
        while time.monotonic() < deadline:
            try:
                state = self.api('/state')
                require_restart_budget()
                device = next((item for item in state['devices'] if item['id'] == self.args.device_id), None)
                if device is None or not device['connected']:
                    raise RuntimeError('Explicit paired device disconnected')
                result = self.inspection()
                require_restart_budget()
                if restart_after is not None and result.get('snapshot', {}).get('pages') == []:
                    attempt = require_pending_view_restart(restart_after, result, self.args.device_id)
                    require(pending_restart is None or pending_restart == attempt,
                            'Pending View restart changed native attempt')
                    pending_restart = attempt
                    previous = None
                    last_reason = 'Exact prepared View restart remains pending'
                    time.sleep(min(.15, max(0, deadline - time.monotonic())))
                    continue
                if restart_after is not None:
                    terminal = require_view_restart_observation(restart_after, result, self.args.device_id, pending_restart)
                    if terminal is not None:
                        pending_restart = terminal
                page = self.current(result)
                try:
                    observed_identity = presentation_identity(result, False)
                    self.layout_observations[observed_identity] = native_state(result)['acceptedLayout']
                except RuntimeError:
                    pass  # an incomplete transaction has no accepted authority
            except RuntimeError as error:
                if any(code in str(error) for code in ('ERR_DEV_INSPECT_BUSY', 'ERR_DEV_STALE_INSPECTION', 'ERR_DEV_NOT_STARTED')):
                    time.sleep(.1)
                    continue
                raise
            if page['route'] == ROUTES[route] and page['data'].get('fixtureVersion') == 1:
                try:
                    identity = presentation_identity(result)
                    if restart_after is not None:
                        require_completed_view_restart(restart_after, result, self.args.device_id, pending_restart)
                    _, geometry = self.observations(page)
                    require_guest_geometry(result, geometry)
                    window = native_state(result)['acceptedLayout']['windowMetrics']
                    if after is not None:
                        require_fresh_layout(after, result)
                    fingerprint = (identity, json.dumps(geometry, sort_keys=True))
                    if (orientation is None or window.get('deviceOrientation') == orientation) and fingerprint == previous:
                        observed = self.observe_native_geometry(result)
                        if display_rotation is not None:
                            require_observed_rotation(observed['nativeWitness']['display'], display_rotation)
                        require_restart_budget()
                        # AX collection is slower than an AppService tick. Only
                        # layout ownership must stay fixed; frame counters may
                        # advance, and the final read must again be presented.
                        confirmed = self.inspection()
                        require_restart_budget()
                        if restart_after is not None:
                            require_completed_view_restart(restart_after, confirmed, self.args.device_id, pending_restart)
                        require(presentation_identity(confirmed) == identity, 'Layout changed while independently measuring native geometry')
                        require_guest_geometry(confirmed, self.observations(self.current(confirmed))[1])
                        if baseline is not None:
                            prior_identity = presentation_identity(baseline, False)
                            layouts = [value for key, value in self.layout_observations.items() if key[0] == identity[0] and
                                key[3] == identity[3] and key[6] > prior_identity[6]]
                            checked = require_resize_journal(baseline, confirmed, layouts)
                            confirmed['resizeJournalEvidence'] = {'validatedNewCallbacks': checked,
                                'observedTransactions': len(layouts), 'method': 'exact callback size/window/capsule in a single observed accepted transaction'}
                        confirmed['nativeObservation'] = result['nativeObservation']
                        require_restart_budget()
                        self.last_page = confirmed
                        return confirmed
                    previous = fingerprint
                except ViewRestartContractError:
                    raise
                except RuntimeError as error:
                    last_reason = str(error)
            time.sleep(.15)
        raise RuntimeError('Stable presented page/orientation not observed: ' + route + '/' + str(orientation) + ': ' + str(last_reason))

    def capture(self, name, result=None):
        self.index += 1
        base = self.out / ('%03d-%s' % (self.index, name))
        xml, _ = self.ui()
        base.with_suffix('.xml').write_text(scrub(xml))
        base.with_suffix('.png').write_bytes(self.adb('exec-out', 'screencap', '-p', binary=True))
        if self.secret is None:
            write_json(base.with_suffix('.capture.json'), {'adminState': 'not-attempted',
                'reason': 'preflight has not initialized the matching admin credentials'})
        else:
            write_json(base.with_suffix('.state.json'), self.api('/state'))
        if result is not None:
            write_json(base.with_suffix('.inspect.json'), result)
        return base

    def target(self, result, identifier):
        require_target_geometry(result)
        page = self.current(result)
        _, geometry = self.observations(page)
        require_guest_geometry(result, geometry)
        window = geometry['window']
        observed = self.observe_native_geometry(result)
        bx0, by0, _, _ = observed['surfacePhysical']
        density = observed['density']
        target = next((item for item in page['data']['targets'] if item.get('id') == identifier), None)
        if not target:
            raise RuntimeError('Presented selector geometry missing for ' + identifier)
        cx, cy = target['left'] + target['width'] / 2, target['top'] + target['height'] / 2
        if not 0 <= cx < window['windowWidth'] or not 0 <= cy < window['windowHeight']:
            raise RuntimeError('Target is outside current viewport; no speculative tap')
        return round(bx0 + cx * density), round(by0 + cy * density)

    def tap(self, result, identifier):
        x, y = self.target(result, identifier)
        self.last_tap = {'physical': [x, y], 'target': identifier, 'nativeObservation': result['nativeObservation']}
        self.adb('shell', 'input', 'tap', str(x), str(y))
        time.sleep(.12)

    def rotate(self, rotation, route, before):
        # A requested settings value is not proof of the current display angle.
        # Re-measure the owned native view for every request, including after a
        # fold posture change; never cache a device-name/natural-orientation guess.
        observed = self.observe_native_geometry(before)
        plan = rotation_plan(observed['nativeWitness']['display'],
                             native_state(before)['acceptedLayout']['windowMetrics'],
                             observed['density'], rotation)
        self.adb('shell', 'settings', 'put', 'system', 'user_rotation', str(rotation))
        return self.wait_page(route, plan['expectedOrientation'],
                              after=before if plan['requiresFreshLayout'] else None,
                              display_rotation=rotation)

    def validate_geometry(self, result, label):
        page = self.current(result)
        data = page['data']
        events, _ = self.observations(page)
        self.assert_(bool(events) and events[0] == data['first'], label + ': first sample retained')
        self.assert_(events[0]['event'] == 'onLoad', label + ': initial callback is onLoad')
        self.assert_(all(a['sequence'] < b['sequence'] for a, b in zip(events, events[1:])), label + ': callback sequence monotonic')
        require_guest_geometry(result, json.loads(data['geometries'][data['first']['geometry']]))
        self.assert_(True, label + ': first onLoad matches accepted destination layout/window/capsule')
        for event in events:
            value = json.loads(data['geometries'][event['geometry']])
            self.assert_(isinstance(value.get('window'), dict) and isinstance(value.get('capsule'), dict),
                         label + ': complete geometry at ' + str(event['sequence']))
            window, capsule = value['window'], value['capsule']
            self.assert_(window['windowWidth'] > 0 and window['windowHeight'] > 0 and capsule['width'] > 0 and capsule['height'] > 0,
                         label + ': non-placeholder measured geometry at ' + str(event['sequence']))

    def run_cycles(self):
        result = self.wait_page('home')
        self.validate_geometry(result, 'initial home')
        initial_data = self.current(result)['data']
        _, latest_geometry = self.observations(self.current(result))
        first_geometry = json.loads(initial_data['geometries'][initial_data['first']['geometry']])
        self.assert_(first_geometry == latest_geometry, 'first onLoad already has complete final initial geometry')
        self.target(result, 'p0-increment')
        result = self.rotate(0, 'home', result)
        self.capture('initial-home', result)
        initial_first = self.current(result)['data']['first']
        for cycle in range(self.args.cycles):
            if getattr(self, 'physical_mapping', None) is not None:
                result = self.transition_physical_posture(result, cycle)
            elif self.args.postures:
                state = self.args.postures[cycle % len(self.args.postures)]
                before_posture = result
                self.adb('shell', 'cmd', 'device_state', 'state', str(state))
                self.posture_changed = True
                time.sleep(.3)
                result = self.wait_page('home', after=before_posture)
            count = self.current(result)['data']['count']
            last_sequence = json.loads(self.current(result)['data']['events'][-1])['sequence']
            self.tap(result, 'p0-increment')
            result = self.wait_page('home')
            data = self.current(result)['data']
            self.assert_(data['count'] == count + 1, 'cycle %d: actual tap increments once' % cycle)
            new_events = [json.loads(item) for item in data['events'] if json.loads(item)['sequence'] > last_sequence]
            names = [item['event'] for item in new_events]
            self.assert_(names.count('increment.begin') == names.count('increment.callback') == names.count('increment.return') == 1,
                         'cycle %d: setData callback and return recorded' % cycle)
            point = next(item['detail'] for item in new_events if item['event'] == 'increment.begin')
            observed = self.last_tap['nativeObservation']
            x0, y0, _, _ = observed['surfacePhysical']
            close_enough(point.get('x'), (self.last_tap['physical'][0] - x0) / observed['density'], 1,
                         'actual tap x in content coordinates')
            close_enough(point.get('y'), (self.last_tap['physical'][1] - y0) / observed['density'], 1,
                         'actual tap y in content coordinates')
            if self.report['deviceAssociation']['status'] == 'pending':
                self.report['deviceAssociation'].update({'status': 'passed', 'actualInput': self.last_tap,
                    'observedDeviceId': self.args.device_id, 'observedIncrementEvent': next(item for item in new_events if item['event'] == 'increment.begin')})
                self.save()
            self.tap(result, 'p0-custom')
            result = self.wait_page('custom', after=result)
            self.validate_geometry(result, 'cycle %d custom' % cycle)
            self.capture('cycle-%02d-custom' % cycle, result)
            result = self.rotate(1, 'custom', result)
            orientation = completed_rotation_orientation(result, 1)
            self.capture('cycle-%02d-custom-rotation1-%s' % (cycle, orientation), result)
            back_before, back_sequence = result, journal_sequence(result)
            self.tap(result, 'p0-back')
            result = self.wait_page('home', orientation, after=back_before)
            self.assert_(self.current(result)['data']['count'] == count + 1, 'cycle %d: navigation preserves count' % cycle)
            evidence = require_back_lifecycle(back_before, result, back_sequence)
            self.report.setdefault('backLifecycle', []).append({'cycle': cycle, **evidence})
            self.assert_(True, 'cycle %d custom: one onUnload with old geometry, then home onShow with new geometry' % cycle)
            self.tap(result, 'p0-normal')
            result = self.wait_page('detail', orientation, after=result)
            self.validate_geometry(result, 'cycle %d normal' % cycle)
            back_before, back_sequence = result, journal_sequence(result)
            self.tap(result, 'p0-back')
            result = self.wait_page('home', orientation, after=back_before)
            evidence = require_back_lifecycle(back_before, result, back_sequence)
            self.report.setdefault('backLifecycle', []).append({'cycle': cycle, **evidence})
            self.assert_(True, 'cycle %d normal: one onUnload with old geometry, then home onShow with new geometry' % cycle)
            result = self.rotate(0, 'home', result)
            self.assert_(self.current(result)['data']['first'] == initial_first,
                         'cycle %d: rotation/navigation never overwrites first onLoad' % cycle)
            self.capture('cycle-%02d-home-rotation0-%s' % (cycle, completed_rotation_orientation(result, 0)), result)
        return result

    def secondary_cases(self, result):
        count = self.current(result)['data']['count']
        self.tap(result, 'p0-save')
        result = self.wait_page('home')
        self.tap(result, 'p0-tab')
        result = self.wait_page('settings', after=result)
        self.assert_(self.current(result)['data']['stored'] == count, 'tab reads persisted count')
        self.capture('storage-tab', result)
        self.tap_ax(['验证首页'])
        result = self.wait_page('home', after=result)
        self.tap(result, 'p0-scroll')
        result = self.wait_page('scroll', after=result)
        # The scroll region follows the fixed controls; use actual surface bounds,
        # never canvas.width or whole-screen fractions for the coordinate scale.
        x0, y0, x1, y1 = self.observe_native_geometry(result)['surfacePhysical']
        x, y = self.target(result, 'p0-scroll-region')
        _, geometry = self.observations(self.current(result))
        distance = round(60 * result['nativeObservation']['density'])
        self.assert_(y0 < y - distance < y + distance < y1, 'scroll gesture stays in actual native surface')
        self.adb('shell', 'input', 'swipe', str(x), str(y + distance), str(x), str(y - distance), '400')
        result = self.wait_page('scroll')
        self.assert_(self.current(result)['data']['scrollEvents'] > 0, 'actual scroll event delivered')
        self.capture('scrolled', result)
        back_before, back_sequence = result, journal_sequence(result)
        self.tap(result, 'p0-back')
        result = self.wait_page('home', after=back_before)
        evidence = require_back_lifecycle(back_before, result, back_sequence)
        self.report.setdefault('backLifecycle', []).append({'stage': 'scroll', **evidence})
        self.assert_(True, 'scroll: one onUnload with old geometry, then home onShow with new geometry')
        before = self.current(result)['data']
        original_run = before['runMarker']
        original_session = native_state(result)['sessionId']
        self.tap_ax(['更多', 'More'])
        self.tap_ax(['开发工具', 'Developer tools'])
        time.sleep(1)
        covered = self.inspection()
        covered_state = native_state(covered)
        self.assert_(self.current(covered)['data']['count'] == before['count'] and
                     self.current(covered)['data']['ticks'] > before['ticks'], 'tools preserve page state and business timer')
        self.assert_(covered_state.get('sessionId') == original_session and covered_state.get('foreground') is True and
                     covered_state.get('previewOccluded') is True and covered_state.get('inputEnabled') is False and
                     covered_state.get('presentationEnabled') is False, 'tools occlude preview without backgrounding or replacing session')
        self.capture('tools-covered', covered)
        self.tap_ax(['返回小程序', 'Return to mini program'])
        result = self.wait_page('home')
        self.tap_ax(['关闭小程序', 'Close mini program'])
        self.capture('closed-project-page')
        closed_native = self.adb('exec-out', 'cmd', 'window', 'dump-visible-window-views', binary=True)
        write_private_raw(self.out / 'closed-native-window.zip', closed_native)
        closed_count = native_class_count(closed_native, PACKAGE, self.native_binding['nativeClass'])
        self.assert_(closed_count == 0, 'closed project page has no actual native preview surface')
        try:
            self.inspection()
            self.assert_(False, 'closed Player must not expose a live runtime')
        except RuntimeError as error:
            self.assert_(any(code in str(error) for code in ('ERR_DEV_STALE_INSPECTION', 'ERR_DEV_NOT_STARTED')),
                         'closed instance rejects runtime inspector', error=str(error))
        self.report['resourceEvidence'] = {'preview': 'actual native Java surface absent in owned encoded window and inspector rejects closed runtime',
            'gpuRelease': 'blocked: no device-level live GPU resource counter; not inferred from AX absence'}
        self.tap_ax(['打开小程序', 'Open mini program'])
        result = self.wait_page('home')
        reopened = self.current(result)['data']
        self.assert_(native_state(result)['sessionId'] != original_session and reopened['count'] == 0 and
                     reopened['stored'] == count and reopened['runMarker'] != original_run,
                     'close/reopen starts fresh memory and preserves storage')
        self.capture('reopened', result)
        return result

    def view_fault(self, result):
        baseline = result
        count_target = self.target(result, 'p0-increment')
        journal_before = [json.loads(item) for item in self.current(result)['data']['journal']['events']]
        sequence_before = journal_before[-1][0]
        self.tap(result, 'p0-fault')
        time.sleep(.5)
        before = self.inspection()
        require_view_fault(baseline, before)
        self.assert_(self.current(before)['data']['triggerViewFault'] is True, 'explicit View fault requested')
        # Reuse only the last verified target and surface mapping, then ensure the
        # damaged view cannot dispatch a count mutation. No bridge mutation used.
        self.adb('shell', 'input', 'tap', *(str(value) for value in count_target))
        time.sleep(1)
        after = self.inspection()
        require_view_fault(baseline, after)
        a, b = self.current(before)['data'], self.current(after)['data']
        self.assert_(b['count'] == a['count'], 'damaged View rejects actual input')
        self.assert_(b['ticks'] > a['ticks'], 'isolated View interruption preserves AppService timers')
        journal_after = [json.loads(item) for item in b['journal']['events']]
        self.assert_(all(item[3] not in ('onHide', 'onUnload') for item in journal_after if item[0] > sequence_before),
                     'isolated View interruption synthesizes no AppService hide/unload')
        self.capture('view-fault', after)
        self.report['viewFaultEvidence'] = 'same accepted SDK session/pack/layout, typed View ERR_TIMEOUT, healthy foreground AppService, real denied input and continuing timer'
        self.tap_ax(['更多', 'More'])
        self.tap_ax(['重载小程序', 'Reload mini program'])
        recovered = self.wait_page('home', restart_after=after)
        data = self.current(recovered)['data']
        self.assert_(native_state(recovered)['sessionId'] != native_state(after)['sessionId'] and
                     data['runMarker'] != b['runMarker'] and data['triggerViewFault'] is False and
                     data['count'] == 0 and data['stored'] == b['stored'],
                     'View fault recovery uses new AppService session and retains storage')
        self.validate_geometry(recovered, 'recovered after sticky View fault')
        self.capture('view-fault-recovered', recovered)

    def c018_baseline(self):
        result = self.wait_page('home')
        self.validate_geometry(result, 'C018 baseline')
        self.capture('c018-baseline', result)
        write_json(self.out / 'c018-baseline.json', {'schemaVersion': 1, 'stage': 'c018-baseline',
            'serial': self.args.serial, 'avd': self.args.avd, 'deviceId': self.args.device_id,
            'apkSha256': self.args.apk_sha256, 'capturedAt': utc(), 'inspection': result})
        self.report['caseStatus'] = {'C018': 'baseline-captured; rejection not yet tested'}

    def c018_rejection(self):
        raw = Path(self.args.baseline).read_bytes()
        baseline = json.loads(raw)
        self.assert_(baseline.get('schemaVersion') == 1 and baseline.get('stage') == 'c018-baseline' and
                     all(baseline.get(key) == value for key, value in
                         (('serial', self.args.serial), ('avd', self.args.avd), ('deviceId', self.args.device_id),
                          ('apkSha256', self.args.apk_sha256))), 'C018 baseline belongs to this exact reviewed emulator/client')
        self.report['baselineSha256'] = hashlib.sha256(raw).hexdigest()
        candidate = self.report['initialProject']
        self.assert_(candidate['integrityRoot'] == self.args.candidate_root and candidate['generation'] == self.args.candidate_generation,
                     'C018 candidate root/generation match the actual local service publication')
        before = self.wait_page('home')
        attempt = require_candidate_rejection(baseline['inspection'], before, candidate)
        self.capture('c018-terminal-rejected-old-owner', before)
        count, ticks = (self.current(before)['data'][key] for key in ('count', 'ticks'))
        self.tap(before, 'p0-increment')
        after = self.wait_page('home')
        require_candidate_rejection(baseline['inspection'], after, candidate)
        self.assert_(self.current(after)['data']['count'] == count + 1 and self.current(after)['data']['ticks'] > ticks,
                     'C018 retained old session accepts actual input and keeps AppService timer')
        self.capture('c018-retained-input-and-timer', after)
        self.report['caseStatus'] = {'C018': 'passed'}
        self.report['candidateEvidence'] = attempt

    def cleanup(self):
        for key, value in self.restores.items():
            try:
                if value == 'null':
                    self.adb('shell', 'settings', 'delete', 'system', key)
                elif re.fullmatch(r'-?\d+', value):
                    self.adb('shell', 'settings', 'put', 'system', key, value)
                else:
                    raise RuntimeError('Unrecognized previous rotation setting')
                self.report['cleanup'].append({'resource': key, 'status': 'restored'})
            except Exception as error:
                self.report['cleanup'].append({'resource': key, 'status': 'failed', 'error': str(error)})
        if self.posture_changed:
            try:
                self.adb('shell', 'cmd', 'device_state', 'state', 'reset')
                self.report['cleanup'].append({'resource': 'owned test posture override', 'status': 'reset'})
            except Exception as error:
                self.report['cleanup'].append({'resource': 'owned test posture override', 'status': 'failed', 'error': str(error)})
        if self.physical_submitted:
            try:
                restored = self.restore_physical_posture()
                self.report['cleanup'].append({'resource': 'explicit physical hinge profile', **restored})
            except Exception as error:
                self.report['cleanup'].append({'resource': 'explicit physical hinge profile', 'status': 'failed', 'error': str(error)})
        self.report['finishedAt'] = utc()
        if self.report.get('adbCleanupUncertain') or any(item['status'] == 'failed' for item in self.report['cleanup']):
            self.report['status'] = 'failed'
        self.save()
        files = []
        for path in sorted(self.out.iterdir()):
            if path.is_file() and path.name != 'files.json':
                value = path.read_bytes()
                files.append({'file': path.name, 'size': len(value), 'sha256': hashlib.sha256(value).hexdigest()})
        write_json(self.out / 'files.json', {'schemaVersion': 1, 'files': files})


def arguments(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--describe', action='store_true', help='print passive plan; never contact ADB/server')
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--stage', choices=('full', 'c018-baseline', 'c018-rejection'), default='full',
                        help='C018 stages observe an externally published candidate; they never alter source or fabricate receipts')
    parser.add_argument('--baseline', help='actual c018-baseline.json emitted by the baseline stage')
    parser.add_argument('--candidate-root', help='exact expected SHA-256 root of the failing service publication')
    parser.add_argument('--candidate-generation', help='exact expected decimal generation of the failing service publication')
    parser.add_argument('--serial')
    parser.add_argument('--avd')
    parser.add_argument('--device-id')
    parser.add_argument('--admin', help='exact local dashboard URL, e.g. http://127.0.0.1:51791')
    parser.add_argument('--out', help='new evidence directory; existing paths are refused')
    parser.add_argument('--apk-sha256', help='reviewed installed APK hash; no installation is performed')
    parser.add_argument('--adb', default='adb')
    parser.add_argument('--cycles', type=int, default=10)
    parser.add_argument('--mapping', help='exact release R8 mapping matching the reviewed APK')
    parser.add_argument('--mapping-sha256')
    parser.add_argument('--apk', help='reviewed local APK for DEX marker binding')
    parser.add_argument('--postures', type=lambda value: [int(item) for item in value.split(',')],
                        help='framework override state IDs only; never proves physical folding')
    parser.add_argument('--physical-posture-mapping', help='explicit bounded UTF-8 physical hinge mapping for this AVD')
    parser.add_argument('--physical-posture-mapping-sha256', help='exact lowercase SHA-256 of reviewed physical mapping bytes')
    args = parser.parse_args(argv)
    if args.describe:
        return args
    if not args.execute or not all([args.serial, args.avd, args.device_id, args.admin, args.out, args.apk_sha256]):
        parser.error('--execute requires serial, avd, device-id, admin, out and apk-sha256')
    if not re.fullmatch(r'emulator-\d+', args.serial):
        parser.error('physical devices are refused; use an explicit emulator-N serial')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+', args.avd):
        parser.error('invalid explicit AVD name')
    if not re.fullmatch(r'[a-f0-9]{64}', args.apk_sha256):
        parser.error('apk-sha256 must be the exact lowercase SHA-256')
    if not args.mapping or not args.apk or not re.fullmatch(r'[a-f0-9]{64}', args.mapping_sha256 or ''):
        parser.error('native geometry requires exact mapping, mapping-sha256 and apk')
    if args.stage == 'c018-rejection' and (not args.baseline or not re.fullmatch(r'[a-f0-9]{64}', args.candidate_root or '') or
            not re.fullmatch(r'[1-9][0-9]{0,15}', args.candidate_generation or '')):
        parser.error('c018-rejection requires actual baseline, candidate-root and candidate-generation')
    if not 10 <= args.cycles <= 12:
        parser.error('P0 requires 10-12 cycles in one bounded inspector session')
    origin = urllib.parse.urlsplit(args.admin)
    try:
        local = ipaddress.ip_address(origin.hostname).is_loopback
    except ValueError:
        local = origin.hostname == 'localhost'
    if not local or origin.scheme != 'http' or not origin.port or origin.path not in ('', '/') or origin.query or origin.fragment or origin.username or origin.password:
        parser.error('admin must be an exact loopback HTTP origin without credentials/path')
    args.admin = args.admin.rstrip('/')
    if args.postures and any(value < 0 or value > 255 for value in args.postures):
        parser.error('posture IDs must be explicit supported state numbers')
    if bool(args.physical_posture_mapping) != bool(args.physical_posture_mapping_sha256):
        parser.error('physical posture mapping path and SHA-256 must be supplied together')
    if args.physical_posture_mapping:
        if args.postures or args.stage != 'full':
            parser.error('physical mapping is only allowed for full stage and is mutually exclusive with framework --postures')
        if not re.fullmatch(r'[a-f0-9]{64}', args.physical_posture_mapping_sha256):
            parser.error('physical mapping SHA-256 must be exact lowercase hex')
    return args


def main(argv=None):
    args = arguments(sys.argv[1:] if argv is None else argv)
    if args.describe:
        print(json.dumps(PLAN, ensure_ascii=False, indent=2))
        return 0
    runner = Runner(args)
    try:
        runner.preflight()
        if args.stage == 'c018-baseline':
            runner.c018_baseline()
        elif args.stage == 'c018-rejection':
            runner.c018_rejection()
        else:
            result = runner.run_cycles()
            result = runner.secondary_cases(result)
            runner.view_fault(result)
        runner.report['status'] = 'passed'
    except Exception as error:
        runner.report['status'] = 'failed'
        runner.report['failure'] = {'type': type(error).__name__, 'message': scrub(str(error))}
        try:
            if runner.owner_validated:
                runner.capture('failure')
        except Exception as capture_error:
            runner.report['failure']['captureError'] = scrub(str(capture_error))
    finally:
        runner.cleanup()
    print(json.dumps({'status': runner.report['status'], 'report': str(runner.out / 'report.json')}, ensure_ascii=False))
    return 0 if runner.report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
