"""Independent bounded Android view geometry; no guest/runtime inputs.

R8 mapping is matched to markers inside the reviewed APK. Native activity text,
encoded window hierarchy and TextureView layer sizes must agree. Nonidentity
transforms, custom clipping, scrolling ancestors and ambiguous surfaces fail.
"""
import hashlib
import io
import json
import math
from pathlib import Path
import re
import struct
from enum import Enum
from decimal import Decimal, InvalidOperation
from typing import NamedTuple, Optional
import zipfile


def require(value, message):
    if not value:
        raise RuntimeError(message)


class PostureControlDomain(str, Enum):
    ANDROID_OVERRIDE = 'android-device-state-override'
    EMULATOR_PHYSICAL = 'emulator-hinge-control'


class PostureWindowContract(str, Enum):
    CHANGING = 'changing'
    CONTINUITY = 'continuity'
    OBSERVE = 'observe'


class HingeAngle(NamedTuple):
    sensor: str
    unit: str
    value: str


class PostureContract(NamedTuple):
    control_domain: PostureControlDomain
    target_identifier: Optional[int]
    committed_identifier: int
    committed_name: str
    base_identifier: Optional[int]
    base_name: Optional[str]
    physical_angle: Optional[HingeAngle]
    operation: Optional[str]
    window_contract: PostureWindowContract
    mapping_sha256: str


class PhysicalPostureMapping(NamedTuple):
    sha256: str
    evidence_sha256: str
    avd: str
    sensor: str
    initial: PostureContract
    steps: tuple
    from_profiles: tuple
    required_states: tuple
    restore: PostureContract


def hinge_angle(value):
    """A measured angle in degrees, never an Android state or posture enum."""
    require(type(value) is dict and set(value) == {'sensor', 'unit', 'value'}
            and type(value['sensor']) is str and re.fullmatch(r'hinge-angle(?:0|[1-9][0-9]?)', value['sensor'])
            and value['unit'] == 'degrees' and type(value['value']) in (str, int, float),
            'Explicit emulator hinge sensor and degrees are required')
    raw = str(value['value'])
    require(len(raw) <= 64 and re.fullmatch(r'[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]{1,4})?', raw),
            'Bounded finite hinge angle is required')
    try:
        number = Decimal(raw)
    except InvalidOperation:
        raise RuntimeError('Finite hinge angle is required') from None
    require(number.is_finite(), 'Finite hinge angle is required')
    # Exact decimal identity avoids a tolerance or angle range invented by the
    # harness. Targets come from the separately reviewed, hashed AVD mapping.
    canonical = format(number, 'f')
    if '.' in canonical:
        canonical = canonical.rstrip('0').rstrip('.')
    return HingeAngle(value['sensor'], 'degrees', '0' if number.is_zero() else canonical)


def hinge_angle_readback(raw, sensor):
    require(type(raw) is str and len(raw) <= 4096, 'Bounded actual hinge readback is required')
    rows = raw.replace('\r\n', '\n').strip().splitlines()
    require(len(rows) == 2 and rows[1] == 'OK', 'Actual hinge readback and console terminator are required')
    match = re.fullmatch(re.escape(sensor) + r' = ([^\s]+)', rows[0])
    require(match is not None, 'Actual hinge readback sensor does not match the mapping')
    return hinge_angle({'sensor': sensor, 'unit': 'degrees', 'value': match[1]})


def committed_device_state(raw):
    """Parse an actual readback, never a request or successful command receipt."""
    require(type(raw) is str and len(raw) <= 65536, 'Bounded Android committed-state readback is required')
    rows = re.findall(r"^Committed state: DeviceState\{identifier=([0-9]+), name='([A-Za-z0-9 _-]{1,96})'"
                      r", app_accessible=(?:true|false), cancel_when_requester_not_on_top=(?:true|false)\}\s*$",
                      raw, re.M)
    require(len(rows) == 1 and len(raw.strip().splitlines()) == 1,
            'Unique actual Android committed state is required')
    identifier, name = int(rows[0][0]), rows[0][1]
    require(0 <= identifier <= 255, 'Actual Android committed-state identifier exceeds bound')
    return {'domain': 'android-device-state', 'identifier': identifier, 'name': name}


def posture_contract(value):
    """Freeze a predeclared mapping; Android and emulator IDs never imply each other."""
    require(type(value) is dict and set(value) == {'schemaVersion', 'controlDomain', 'target',
            'expectedCommittedState', 'expectedBaseState', 'windowContract', 'mappingSha256'}
            and type(value['schemaVersion']) is int and value['schemaVersion'] == 2,
            'Versioned explicit posture contract is required')
    try:
        domain = PostureControlDomain(value['controlDomain'])
        window = PostureWindowContract(value['windowContract'])
    except (ValueError, TypeError):
        raise RuntimeError('Unknown posture control domain or window contract') from None
    target, committed, base = (value[key] for key in ('target', 'expectedCommittedState', 'expectedBaseState'))
    def state(item):
        require(type(item) is dict and set(item) == {'identifier', 'name'}
                and type(item['identifier']) is int and 0 <= item['identifier'] <= 255
                and type(item['name']) is str and re.fullmatch(r'[A-Za-z0-9 _-]{1,96}', item['name']),
                'Explicit Android state mapping is required')
        return item['identifier'], item['name']
    committed_identifier, committed_name = state(committed)
    require(type(value['mappingSha256']) is str and re.fullmatch(r'[a-f0-9]{64}', value['mappingSha256']),
            'Root-observed posture mapping SHA-256 is required')
    if domain is PostureControlDomain.EMULATOR_PHYSICAL:
        require(type(target) is dict and set(target) == {'operation', 'angle'}
                and target['operation'] in ('fold', 'unfold', 'hinge-angle-set', 'sensor-restore'),
                'Only reviewed fold/unfold, bounded hinge set and restore operations are allowed')
        physical = hinge_angle(target['angle'])
        if target['operation'] in ('hinge-angle-set', 'sensor-restore'):
            require(0 <= Decimal(physical.value) <= 180, 'Explicit hinge set/restore must be within 0..180 degrees')
        base_identifier, base_name = state(base)
        target_identifier, operation = None, target['operation']
    else:
        require(base is None and type(target) is dict and set(target) == {'identifier'}
                and type(target['identifier']) is int and target['identifier'] == committed_identifier,
                'Android override must not claim a physical angle or a different Android target')
        target_identifier, operation, physical, base_identifier, base_name = target['identifier'], None, None, None, None
    return PostureContract(domain, target_identifier, committed_identifier, committed_name,
                           base_identifier, base_name, physical, operation, window, value['mappingSha256'])


def posture_target(contract):
    if contract.physical_angle is None:
        return {'identifier': contract.target_identifier}
    return {'operation': contract.operation, 'angle': contract.physical_angle._asdict()}


def posture_contract_json(contract):
    return {'schemaVersion': 2, 'controlDomain': contract.control_domain.value,
            'target': posture_target(contract),
            'expectedCommittedState': {'identifier': contract.committed_identifier, 'name': contract.committed_name},
            'expectedBaseState': None if contract.base_identifier is None else {
                'identifier': contract.base_identifier, 'name': contract.base_name},
            'windowContract': contract.window_contract.value, 'mappingSha256': contract.mapping_sha256}


def android_state_readback(raw):
    """Parse actual committed/base/override/pending domains from one OS dump."""
    require(type(raw) is str and len(raw) <= 65536, 'Bounded actual device-state dump is required')
    def field(key):
        rows = [line for line in raw.splitlines() if re.match(r'^ *' + re.escape(key) + r'(?=\s|=|:|$)', line)]
        require(len(rows) == 1, 'Unique actual Android ' + key + ' field is required')
        match = re.fullmatch(r' *' + re.escape(key) + r'=([^\r\n]*)', rows[0])
        require(match is not None, 'Unsupported actual Android ' + key + ' field')
        return match[1]
    def optional(value):
        if value == 'Optional.empty':
            return None
        require(value.startswith('Optional[') and value.endswith(']'), 'Unsupported actual Android optional state')
        line = 'Committed state: ' + value[9:-1]
        return line, committed_device_state(line)
    committed, base = optional(field('mCommittedState')), optional(field('mBaseState'))
    override, pending = optional(field('mOverrideState')), optional(field('mPendingState'))
    active_rows = [line for line in raw.splitlines() if line.startswith('Override Request active')]
    require(len(active_rows) == 1, 'Unique actual Android override request field is required')
    active = re.fullmatch(r'Override Request active: (true|false)', active_rows[0])
    require(committed is not None and base is not None and active is not None
            and (active[1] == 'true') == (override is not None), 'Actual Android override/state evidence is inconsistent')
    return {'committedState': committed[0], 'baseState': base[0], 'physicalAngle': None,
            'overrideActive': active[1] == 'true', 'pendingActive': pending is not None}


def physical_posture_mapping(raw, expected_sha256, avd):
    require(type(raw) is bytes and len(raw) <= 65536 and type(expected_sha256) is str
            and re.fullmatch(r'[a-f0-9]{64}', expected_sha256)
            and hashlib.sha256(raw).hexdigest() == expected_sha256, 'Physical mapping bytes/SHA-256 mismatch')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'Duplicate physical mapping JSON key')
            result[key] = value
        return result
    try:
        value = json.loads(raw.decode('utf8'), object_pairs_hook=pairs)
    except (ValueError, UnicodeError):
        raise RuntimeError('Physical mapping must be bounded UTF-8 JSON') from None
    require(type(value) is dict and set(value) == {'schemaVersion', 'avd', 'sensor', 'evidenceSha256',
            'initial', 'steps', 'requiredCommittedStates', 'restore'} and type(value['schemaVersion']) is int and value['schemaVersion'] == 1
            and value['avd'] == avd and type(value['evidenceSha256']) is str
            and re.fullmatch(r'[a-f0-9]{64}', value['evidenceSha256']), 'Explicit reviewed AVD physical mapping is required')
    sensor = value['sensor']
    def contract(item, initial=False, step=False):
        keys = {'angleDegrees', 'committedState', 'baseState'}
        require(type(item) is dict and set(item) == (keys if initial else keys | {'operation', 'windowContract'} | ({'from'} if step else set())),
                'Explicit physical mapping step is required')
        return posture_contract({'schemaVersion': 2, 'controlDomain': PostureControlDomain.EMULATOR_PHYSICAL.value,
            'target': {'operation': 'sensor-restore' if initial else item['operation'],
                       'angle': {'sensor': sensor, 'unit': 'degrees', 'value': item['angleDegrees']}},
            'expectedCommittedState': item['committedState'], 'expectedBaseState': item['baseState'],
            'windowContract': value['restore']['windowContract'] if initial else item['windowContract'],
            'mappingSha256': expected_sha256})
    require(type(value['steps']) is list and 2 <= len(value['steps']) <= 16
            and type(value['restore']) is dict, 'Two to sixteen explicit physical mapping steps are required')
    restore = contract(value['restore'])
    initial, steps = contract(value['initial'], True), tuple(contract(item, step=True) for item in value['steps'])
    from_profiles = []
    for item, step in zip(value['steps'], steps):
        require(step.operation != 'sensor-restore', 'Sensor restore is a separate cleanup operation')
        profiles = item['from']
        require((profiles is None and step.window_contract is PostureWindowContract.OBSERVE)
                or (type(profiles) is list and 1 <= len(profiles) <= 16),
                'Strict window contracts require explicit observed from profiles')
        from_profiles.append(None if profiles is None else tuple(contract(profile, True) for profile in profiles))
    required = value['requiredCommittedStates']
    require(type(required) is list and 2 <= len(required) <= 16 and all(type(item) is dict
            and set(item) == {'identifier', 'name'} and type(item['identifier']) is int
            and type(item['name']) is str for item in required), 'Explicit frozen Android state coverage is required')
    required_states = tuple((item['identifier'], item['name']) for item in required)
    require(len(set(required_states)) == len(required_states)
            and set(required_states) == {(step.committed_identifier, step.committed_name) for step in steps},
            'Physical mapping steps do not exactly preserve declared Android state coverage')
    require(restore.operation == 'sensor-restore'
            and restore.physical_angle == initial.physical_angle
            and (restore.committed_identifier, restore.committed_name, restore.base_identifier, restore.base_name)
                == (initial.committed_identifier, initial.committed_name, initial.base_identifier, initial.base_name),
            'Physical steps/verified initial sensor restore must remain explicit and distinct')
    return PhysicalPostureMapping(expected_sha256, value['evidenceSha256'], avd, sensor, initial,
                                  steps, tuple(from_profiles), required_states, restore)


def posture_actual_readback(contract, readback):
    """Return convergence and observed identities, independently of setter status."""
    require(isinstance(contract, PostureContract), 'Typed posture contract is required')
    require(type(readback) is dict and set(readback) == {'committedState', 'baseState', 'physicalAngle', 'overrideActive', 'pendingActive'},
            'Separate actual Android and physical readbacks are required')
    committed = committed_device_state(readback['committedState'])
    base = committed_device_state(readback['baseState'])
    require(type(readback['overrideActive']) is bool and type(readback['pendingActive']) is bool,
            'Actual Android override/pending status is required')
    physical = readback['physicalAngle']
    if contract.control_domain is PostureControlDomain.EMULATOR_PHYSICAL:
        physical_angle = hinge_angle(physical)
        base_matches = (base['identifier'], base['name']) == (contract.base_identifier, contract.base_name)
        environment_matches = base_matches and not readback['overrideActive'] and not readback['pendingActive']
    else:
        require(physical is None, 'Framework-only observation cannot imply emulator physical posture')
        physical_angle, environment_matches = None, not readback['pendingActive']
    identity = (committed['identifier'], committed['name'], physical_angle,
                base['identifier'], base['name'], readback['overrideActive'], readback['pendingActive'])
    expected = (contract.committed_identifier, contract.committed_name, contract.physical_angle)
    return identity[:3] == expected and environment_matches, identity


def native_window_fingerprint(measured):
    """Independent native semantics only; file names, guest data and counters are excluded."""
    require(type(measured) is dict, 'Independent native posture measurement is required')
    witness = measured.get('nativeWitness')
    display = witness.get('display') if type(witness) is dict else None
    require(type(display) is dict and type(display.get('schemaVersion')) is int and display['schemaVersion'] == 1
            and type(display.get('displayId')) is int and display['displayId'] >= 0
            and type(display.get('rotation')) is int and 0 <= display['rotation'] <= 3
            and display.get('orientation') in ('portrait', 'landscape'),
            'Independent actual native posture display is required')
    rectangles = [display.get('boundsPhysical'), measured.get('displaySafeAreaPhysical'),
                  measured.get('surfacePhysical'), measured.get('capsulePhysical')]
    for rect in rectangles:
        require(isinstance(rect, (tuple, list)) and len(rect) == 4 and all(type(n) is int for n in rect)
                and rect[0] >= 0 and rect[1] >= 0 and rect[2] > rect[0] and rect[3] > rect[1],
                'Independent positive native posture rectangles are required')
    bounds = rectangles[0]
    require(bounds[0] == bounds[1] == 0 and bounds[2] != bounds[3]
            and (bounds[2] < bounds[3]) == (display['orientation'] == 'portrait'),
            'Independent native posture display bounds/orientation disagree')
    require(all(rect[0] >= bounds[0] and rect[1] >= bounds[1]
                and rect[2] <= bounds[2] and rect[3] <= bounds[3] for rect in rectangles[1:]),
            'Native posture surface/capsule exceeds actual display')
    density = measured.get('density')
    require(type(density) in (int, float) and math.isfinite(density) and density > 0,
            'Independent native posture density is required')
    return (display['displayId'], display['rotation'], display['orientation'], density,
            *(tuple(rect) for rect in rectangles))


def mapping_binding(mapping_path, expected_sha, apk_path, expected_apk):
    raw = Path(mapping_path).read_bytes()
    require(len(raw) <= 64 * 1024 * 1024 and hashlib.sha256(raw).hexdigest() == expected_sha, 'R8 mapping hash mismatch')
    text = raw.decode('utf8')
    ids = re.findall(r'^# pg_map_id: ([a-f0-9]{64})$', text, re.M)
    hashes = re.findall(r'^# pg_map_hash: SHA-256 ([a-f0-9]{64})$', text, re.M)
    require(len(ids) == len(hashes) == 1 and ids == hashes, 'R8 mapping identity/hash mismatch')
    require(hashlib.sha256(Path(apk_path).read_bytes()).hexdigest() == expected_apk, 'Mapping APK bytes mismatch')
    markers = []
    with zipfile.ZipFile(apk_path) as package:
        for entry in package.infolist():
            if re.fullmatch(r'classes[0-9]*\.dex', entry.filename):
                require(entry.file_size <= 64 * 1024 * 1024, 'DEX marker input exceeds bound')
                data = package.read(entry)
                require(data[:4] == b'dex\n' and len(data) >= 112, 'Unsupported DEX header')
                count, offset = struct.unpack_from('<II', data, 56)
                require(count <= 2000000 and offset + count * 4 <= len(data), 'DEX string table exceeds bound')
                for index in range(count):
                    position, = struct.unpack_from('<I', data, offset + index * 4)
                    require(position < len(data), 'DEX string offset exceeds bound')
                    # DEX string_data_item starts with a bounded UTF-16 length ULEB.
                    for _ in range(5):
                        require(position < len(data), 'Truncated DEX string')
                        byte = data[position]
                        position += 1
                        if byte < 128:
                            break
                    else:
                        raise RuntimeError('Invalid DEX string length')
                    if data[position:position + 5] == b'~~R8{':
                        end = data.find(b'\0', position, position + 4096)
                        require(end >= 0, 'Unbounded R8 marker')
                        markers.append(json.loads(data[position + 4:end]))
    require(bool(markers) and all(marker.get('pg-map-id') == ids[0] and marker.get('backend') == 'dex' for marker in markers),
            'APK DEX R8 marker does not match mapping')
    class_names = re.findall(r'^com\.sonofmagic\.weapp\.container\.sdk\.WeappContainerView -> ([\w.$]+):$', text, re.M)
    require(len(class_names) == 1, 'R8 native view class mapping is ambiguous')
    return {'mappingSha256': expected_sha, 'pgMapId': ids[0], 'pgMapHash': hashes[0],
            'apkSha256': expected_apk, 'nativeClass': class_names[0], 'dexR8Markers': markers}


def decode_hierarchy(data):
    require(len(data) <= 4 * 1024 * 1024, 'Native hierarchy exceeds byte bound')
    position = 0
    values = 0

    class PropertyMap(dict):
        property_index = False

    def read(count):
        nonlocal position
        require(position + count <= len(data), 'Truncated native hierarchy')
        value = data[position:position + count]
        position += count
        return value

    def value(depth=0):
        nonlocal values
        values += 1
        require(values <= 100000 and depth <= 96, 'Native hierarchy structure exceeds bound')
        kind = read(1)
        types = {b'Z': ('>B', 1), b'B': ('>b', 1), b'S': ('>h', 2), b'I': ('>i', 4),
                 b'J': ('>q', 8), b'F': ('>f', 4), b'D': ('>d', 8)}
        if kind in types:
            fmt, size = types[kind]
            result, = struct.unpack(fmt, read(size))
            return bool(result) if kind == b'Z' else result
        if kind == b'R':
            size, = struct.unpack('>h', read(2))
            require(size >= 0, 'Negative native hierarchy string length')
            return read(size).decode('utf8')
        if kind == b'M':
            result = PropertyMap()
            while True:
                require(read(1) == b'S', 'Native map key must be a short')
                key, = struct.unpack('>h', read(2))
                if key == 0:
                    return result
                require(key > 0, 'Invalid native map key')
                child = value(depth + 1)
                # endStream declares __name__=propertyIndex, then writes the
                # dictionary including that same __name__ key exactly once.
                duplicate_index = key in result and result[key] == 'propertyIndex' and child == '__name__'
                require(key not in result or duplicate_index, 'Duplicate native map key')
                if not result and child == 'propertyIndex':
                    result.property_index = True
                result[key] = child
        raise RuntimeError('Unknown native hierarchy type')

    top = []
    while position < len(data):
        top.append(value())
    require(len(top) == 6 and isinstance(top[-1], dict) and isinstance(top[-2], dict), 'Unsupported native window stream')
    index = top[-1]
    require(index.property_index, 'Missing native property index')
    names = dict(index)
    require(len(names) == len(set(names.values())), 'Ambiguous native property names')

    def expand(item):
        if not isinstance(item, dict):
            return item
        require(all(key in names for key in item), 'Native property index is incomplete')
        return {names[key]: expand(child) for key, child in item.items()}

    require(names.get(top[0]) == 'window:left' and names.get(top[2]) == 'window:top', 'Unsupported native window coordinates')
    return {'windowLeft': top[1], 'windowTop': top[3], 'root': expand(top[4])}


def owned_window_tree(zip_data, package):
    require(len(zip_data) <= 8 * 1024 * 1024, 'Native window ZIP exceeds byte bound')
    with zipfile.ZipFile(io.BytesIO(zip_data)) as archive:
        entries = [entry for entry in archive.infolist() if re.fullmatch(
            r'[a-f0-9]+ ' + re.escape(package) + '/' + re.escape(package) + r'\.MainActivity', entry.filename)]
        require(len(entries) == 1 and entries[0].file_size <= 4 * 1024 * 1024, 'Unique owned native window is required')
        return decode_hierarchy(archive.read(entries[0]))


def native_lineages(decoded, native_class):
    found = []

    def visit(node, parents):
        require(isinstance(node, dict) and isinstance(node.get('meta:__name__'), str), 'Malformed native node')
        lineage = parents + [node]
        if node['meta:__name__'] == native_class:
            found.append(lineage)
        for key, child in node.items():
            if re.fullmatch(r'meta:__child__[0-9]+', key):
                visit(child, lineage)

    visit(decoded['root'], [])
    return found


def native_class_count(zip_data, package, native_class):
    return len(native_lineages(owned_window_tree(zip_data, package), native_class))


def encoded_native_bounds(zip_data, package, native_class):
    decoded = owned_window_tree(zip_data, package)
    found = native_lineages(decoded, native_class)
    require(len(found) == 1, 'A unique actual native WeappContainerView is required')
    x, y = decoded['windowLeft'], decoded['windowTop']
    ancestors = []
    for node in found[0]:
        require(node.get('misc:visibility') == 0, 'Native surface or ancestor is not visible')
        for key, expected in {'drawing:translationX': 0, 'drawing:translationY': 0, 'drawing:rotation': 0,
                'drawing:rotationX': 0, 'drawing:rotationY': 0, 'drawing:scaleX': 1, 'drawing:scaleY': 1,
                'scrolling:scrollX': 0, 'scrolling:scrollY': 0}.items():
            require(node.get(key) == expected, 'Unsupported native transform or scrolling ancestor: ' + key)
        require(node.get('drawing:clipBounds') == '', 'Unsupported native custom clip bounds')
        left, right, top, bottom = (node.get('layout:' + key) for key in ('left', 'right', 'top', 'bottom'))
        require(all(isinstance(n, int) for n in (left, right, top, bottom)) and right >= left and bottom >= top,
                'Malformed native layout bounds')
        x, y = x + left, y + top
        bounds = (x, y, x + right - left, y + bottom - top)
        require(all(bounds[0] >= old[0] and bounds[1] >= old[1] and bounds[2] <= old[2] and bounds[3] <= old[3]
                for old in ancestors), 'Unsupported native ancestor clipping')
        ancestors.append(bounds)
    return bounds, {'nativeClass': native_class, 'nodes': len(found[0]),
                    'windowOffset': [decoded['windowLeft'], decoded['windowTop']], 'ancestorBounds': ancestors}


def owned_activity_text(text, package):
    require(isinstance(text, str) and len(text) <= 4 * 1024 * 1024, 'Native activity dump exceeds bound')
    sections = re.split(r'^  ACTIVITY ', text, flags=re.M)[1:]
    owned = [part for part in sections if part.startswith(package + '/.MainActivity ')]
    require(len(owned) == 1, 'Unique owned Activity dump is required')
    return owned[0]


def activity_display_observation(text, package):
    """Read actual rotation/orientation from the same owned Activity as bounds.

    Settings user_rotation and AVD initialOrientation are requests/metadata, not
    observations. Fullscreen non-square current configurations are required;
    missing, intermediate, letterboxed or ambiguous configurations fail closed.
    """
    owned = owned_activity_text(text, package)
    header = owned.splitlines()[0]
    displays = re.findall(r'(?:^|\s)displayId=([0-9]+)(?=\(|\s|$)', header)
    require(len(displays) == 1, 'Unique actual Activity display ID is required')
    configs = re.findall(r'^ +mCurrentConfig=(\{[^\r\n]*\}) *$', owned, re.M)
    require(len(configs) == 1, 'Unique actual Activity current configuration is required')
    config = configs[0]
    display = re.findall(r'\bmDisplayRotation=ROTATION_(0|90|180|270)\b', config)
    window = re.findall(r'\bmRotation=ROTATION_(0|90|180|270)\b', config)
    require(len(display) == len(window) == 1 and display == window,
            'Actual display/window rotation is missing or ambiguous')
    modes = re.findall(r'\bmWindowingMode=([A-Za-z_]+)\b', config)
    require(modes == ['fullscreen'], 'Actual fullscreen Activity configuration is required')
    orientations = re.findall(r'(?<![A-Za-z])(port|land)(?![A-Za-z])', config)
    require(len(orientations) == 1, 'Actual Activity orientation is missing or ambiguous')
    rects = re.findall(r'\bmBounds=Rect\((-?[0-9]+), (-?[0-9]+) - (-?[0-9]+), (-?[0-9]+)\)', config)
    require(len(rects) == 1, 'Unique actual Activity bounds are required')
    left, top, right, bottom = map(int, rects[0])
    width, height = right - left, bottom - top
    require(left == top == 0 and width > 0 and height > 0 and width != height,
            'Actual Activity display bounds are unsupported or square')
    orientation = 'portrait' if orientations[0] == 'port' else 'landscape'
    require((width < height) == (orientation == 'portrait'), 'Actual Activity orientation/bounds disagree')
    return {'schemaVersion': 1, 'displayId': int(displays[0]), 'rotation': int(display[0]) // 90,
            'orientation': orientation, 'boundsPhysical': [left, top, right, bottom],
            'source': 'owned MainActivity mCurrentConfig from the native bounds dump'}


def window_safe_area_observation(displays_text, windows_text, activity_text, package):
    """Read fullscreen safe bounds from the focused OS display's InsetsState.

    This deliberately accepts a bounded Android dump grammar. Missing, foreign,
    intermediate, clipped or ambiguous observations fail rather than borrowing any
    accepted SDK/guest metric. Gesture regions and IME are not display safe-area
    insets; visible system bars, cutout safe insets and waterfall edges are.
    """
    require(all(type(text) is str and len(text) <= 4 * 1024 * 1024
                for text in (displays_text, windows_text)), 'Bounded actual window/insets dumps are required')

    def raw_row(scope, key):
        # Count the named native field before interpreting its value. Filtering
        # to valid/positive values first would hide a contradictory second row.
        token = re.escape(key) + r'(?=\s|=|:|$)'
        rows = [line for line in scope.splitlines() if re.match(r'^ +' + token, line)]
        require(len(rows) == 1 and len(re.findall(r'(?<!\S)' + token, scope)) == 1,
                'Unique unambiguous actual native ' + key + ' row is required')
        return rows[0]

    def parsed_row(scope, key, pattern):
        match = re.fullmatch(pattern, raw_row(scope, key))
        require(match is not None, 'Unsupported actual native ' + key + ' row')
        return match

    def unique_fields(row, keys):
        require(all(len(re.findall(r'(?<![A-Za-z0-9_])' + re.escape(key) + r'(?=\s|=|:|$)', row)) == 1
                    for key in keys), 'Repeated or missing actual native field in row')

    # The inherited Activity helper remains unchanged for existing callers.
    # This stricter posture boundary must reject malformed duplicate keys before
    # that helper can filter them to the recognized positive configuration.
    owned_activity = owned_activity_text(activity_text, package)
    unique_fields(owned_activity.splitlines()[0], ('displayId',))
    config = parsed_row(owned_activity, 'mCurrentConfig', r' +mCurrentConfig=(\{[^\r\n]*\}) *')[1]
    unique_fields(config, ('mBounds', 'mDisplayRotation', 'mRotation', 'mWindowingMode'))
    display = activity_display_observation(activity_text, package)
    blocks = re.split(r'^  Display: mDisplayId=([0-9]+)(?=\s|$)[^\r\n]*\n', displays_text, flags=re.M)
    require(len(re.findall(r'^  Display:', displays_text, re.M)) == (len(blocks) - 1) // 2,
            'Unsupported actual native display header')
    matches = [blocks[index + 1] for index in range(1, len(blocks), 2)
               if int(blocks[index]) == display['displayId']]
    require(len(matches) == 1, 'Unique owned actual display insets section is required')
    section = matches[0]
    layout = parsed_row(section, 'deferred', r' +deferred=(true|false) mLayoutNeeded=(true|false) *')
    require(len(re.findall(r'(?<!\S)mLayoutNeeded(?=\s|=|:|$)', section)) == 1
            and layout.groups() == ('false', 'false'), 'Native display layout is pending or ambiguous')
    frames = parsed_row(section, 'DisplayFrames', r' +DisplayFrames w=([0-9]+) h=([0-9]+) r=([0-3]) *')
    width, height, rotation = map(int, frames.groups())
    require([0, 0, width, height] == display['boundsPhysical'] and rotation == display['rotation'],
            'Owned Activity and independent window display disagree')
    density = parsed_row(section, 'init', r' +init=[0-9]+x[0-9]+ ([1-9][0-9]*)dpi '
                         r'[^\r\n]*\bcur=([0-9]+)x([0-9]+)(?=\s|$)[^\r\n]*')
    unique_fields(density[0], ('cur',))
    require(tuple(map(int, density.group(2, 3))) == (width, height),
            'Unique actual display density/current bounds are required')
    density_dpi = int(density[1])
    focus = parsed_row(section, 'mCurrentFocus', r' +mCurrentFocus=(Window\{[^\r\n]+\}) *')[1]
    parsed_row(section, 'mFocusedApp', r' +mFocusedApp=ActivityRecord\{[a-f0-9]+ u[0-9]+ '
               + re.escape(package) + r'/\.MainActivity(?: [^{}\r\n]*)?\} *')
    window_blocks = re.split(r'^  Window #[0-9]+ (Window\{[^\r\n]+\}): *\n', windows_text, flags=re.M)
    require(len(re.findall(r'^  Window #', windows_text, re.M)) == (len(window_blocks) - 1) // 2,
            'Unsupported actual native window header')
    owned_windows = [(window_blocks[index], window_blocks[index + 1])
                     for index in range(1, len(window_blocks), 2)
                     if re.search(r'\s' + re.escape(package) + r'/(?:' + re.escape(package)
                                  + r'\.MainActivity|\.MainActivity)\}$', window_blocks[index])]
    require(len(owned_windows) == 1 and owned_windows[0][0] == focus,
            'Unique focused owned MainActivity window is required')
    owned = owned_windows[0][1]
    owned_display = parsed_row(owned, 'mDisplayId', r' +mDisplayId=([0-9]+)(?=\s|$)[^\r\n]*')[1]
    on_screen = parsed_row(owned, 'isOnScreen', r' +isOnScreen=(true|false) *')[1]
    visible = parsed_row(owned, 'isVisible', r' +isVisible=(true|false) *')[1]
    view_visibility = parsed_row(owned, 'mViewVisibility', r' +mViewVisibility=(0x[0-9a-f]+)(?=\s|$)[^\r\n]*')[1]
    require(owned_display == str(display['displayId']) and on_screen == visible == 'true'
            and view_visibility == '0x0', 'Owned native window is not visibly on this display')
    window_frames = parsed_row(owned, 'Frames', r' +Frames: parent=\[[^\r\n]*?\] display=\[0,0\]\[([0-9]+),([0-9]+)\] '
                               r'frame=\[0,0\]\[([0-9]+),([0-9]+)\][^\r\n]*\binsetsChanged=false *')
    unique_fields(window_frames[0], ('parent', 'display', 'frame', 'insetsChanged'))
    require(tuple(map(int, window_frames.groups())) == (width, height, width, height),
            'Owned window is clipped, offset or inconsistent with the actual fullscreen display')
    controller = parsed_row(section, 'WindowInsetsStateController', r'( +)WindowInsetsStateController *')
    start = section.index(controller[0]) + len(controller[0])
    lines, body = section[start:].splitlines(), []
    for line in lines:
        if line.strip() and len(line) - len(line.lstrip(' ')) <= len(controller[1]):
            break
        body.append(line)
    insets = '\n'.join(body)
    parsed_row(insets, 'InsetsState', r' +InsetsState *')
    display_frame = parsed_row(insets, 'mDisplayFrame', r' +mDisplayFrame=Rect\(0, 0 - ([0-9]+), ([0-9]+)\) *')
    require(display_frame.groups() == (str(width), str(height)), 'InsetsState display frame differs from the owned display')
    cutout = parsed_row(insets, 'mDisplayCutout', r' +mDisplayCutout=DisplayCutout\{insets=Rect\(([0-9]+), ([0-9]+) - ([0-9]+), ([0-9]+)\) '
                         r'waterfall=Insets\{left=([0-9]+), top=([0-9]+), right=([0-9]+), bottom=([0-9]+)\}[^\r\n]*\} *')
    unique_fields(cutout[0], ('insets', 'waterfall'))
    values = tuple(map(int, cutout.groups()))
    edges = [max(values[index], values[index+4]) for index in range(4)]
    sources, seen_ids = [], set()
    for line in insets.splitlines():
        if not re.match(r'InsetsSource(?=\s|=|:|$)', line.lstrip()):
            continue
        match = re.fullmatch(r' +InsetsSource id=([a-f0-9]+) type=([A-Za-z]+) '
                             r'frame=\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\] '
                             r'visible=(true|false) flags=(?:[A-Z_]+(?:\|[A-Z_]+)*)? '
                             r'sideHint=(TOP|BOTTOM|LEFT|RIGHT|NONE) boundingRects=null *', line)
        require(match is not None and match[1] not in seen_ids, 'Ambiguous or unsupported native inset source')
        unique_fields(line, ('id', 'type', 'frame', 'visible', 'flags', 'sideHint', 'boundingRects'))
        seen_ids.add(match[1])
        kind, rect, visible, side = match[2], tuple(map(int, match.group(3, 4, 5, 6))), match[7] == 'true', match[8]
        require(kind in ('statusBars', 'navigationBars', 'captionBar', 'displayCutout', 'systemGestures',
                         'mandatorySystemGestures', 'tappableElement', 'ime'), 'Unsupported native inset source type')
        require(0 <= rect[0] <= rect[2] <= width and 0 <= rect[1] <= rect[3] <= height,
                'Native inset frame exceeds the owned display')
        if not visible or rect[0] == rect[2] or rect[1] == rect[3] or kind not in ('statusBars', 'navigationBars', 'captionBar'):
            continue
        if side == 'TOP':
            require(rect[0] == rect[1] == 0 and rect[2] == width, 'Unsupported partial top system bar')
            index, value = 1, rect[3]
        elif side == 'BOTTOM':
            require(rect[0] == 0 and rect[2:] == (width, height), 'Unsupported partial bottom system bar')
            index, value = 3, height-rect[1]
        elif side == 'LEFT':
            require(rect[0] == rect[1] == 0 and rect[3] == height, 'Unsupported partial left system bar')
            index, value = 0, rect[2]
        elif side == 'RIGHT':
            require(rect[1] == 0 and rect[2:] == (width, height), 'Unsupported partial right system bar')
            index, value = 2, width-rect[0]
        else:
            raise RuntimeError('Visible nonempty system bar has no supported edge')
        edges[index] = max(edges[index], value)
        sources.append({'type': kind, 'side': side, 'framePhysical': list(rect)})
    require(bool(seen_ids), 'Actual native inset sources are missing')
    safe = [edges[0], edges[1], width-edges[2], height-edges[3]]
    require(safe[0] < safe[2] and safe[1] < safe[3], 'Actual native safe area is empty')
    return {'schemaVersion': 1, 'displayId': display['displayId'], 'rotation': rotation,
            'boundsPhysical': [0, 0, width, height], 'densityDpi': density_dpi,
            'displaySafeAreaPhysical': safe, 'visibleSystemBars': sources,
            'source': 'focused owned MainActivity + native DisplayFrames and InsetsState; no guest values'}


def rotation_plan(display, metrics, density, requested):
    """Derive this request from fresh actual display and accepted SDK evidence.

    No natural-orientation cache survives a posture/display change. Reverse
    rotations are real changes even when their portrait/landscape labels match.
    """
    require(type(requested) is int and 0 <= requested <= 3, 'Requested Android rotation must be 0..3')
    require(isinstance(display, dict) and display.get('schemaVersion') == 1
            and type(display.get('displayId')) is int and display['displayId'] >= 0
            and type(display.get('rotation')) is int and 0 <= display['rotation'] <= 3
            and display.get('orientation') in ('portrait', 'landscape'),
            'Actual Android display rotation/orientation is required')
    bounds = display.get('boundsPhysical')
    require(isinstance(bounds, list) and len(bounds) == 4 and all(type(n) is int for n in bounds)
            and bounds[0] == bounds[1] == 0 and bounds[2] > 0 and bounds[3] > 0 and bounds[2] != bounds[3],
            'Actual Android display bounds are required')
    require(isinstance(density, (int, float)) and not isinstance(density, bool)
            and math.isfinite(density) and density > 0, 'Independent Android density is required')
    require(isinstance(metrics, dict) and metrics.get('deviceOrientation') == display['orientation'],
            'Actual native and accepted SDK orientations disagree')
    require((bounds[2] < bounds[3]) == (display['orientation'] == 'portrait'),
            'Actual native display bounds/orientation disagree')
    for key, physical in (('screenWidth', bounds[2]), ('screenHeight', bounds[3])):
        value = metrics.get(key)
        require(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
                and abs(value * density - physical) <= 2,
                'Actual native display versus accepted SDK ' + key + ' disagree')
    expected = display['orientation']
    if (requested - display['rotation']) % 2:
        expected = 'landscape' if expected == 'portrait' else 'portrait'
    return {'observedRotation': display['rotation'], 'requestedRotation': requested,
            'expectedOrientation': expected, 'requiresFreshLayout': requested != display['rotation'],
            'displayId': display['displayId']}


def require_observed_rotation(display, requested):
    require(isinstance(display, dict) and type(display.get('rotation')) is int
            and type(requested) is int and 0 <= requested <= 3 and display['rotation'] == requested,
            'Actual native display has not reached the requested Android rotation')


def text_native_bounds(text, package, native_class):
    split = owned_activity_text(text, package).split('    View Hierarchy:\n')
    require(len(split) == 2, 'Unique actual native View Hierarchy is required')
    lines = split[1].splitlines()
    stack, matches = [], []
    pattern = re.compile(r'^( +)([\w.$]+)\{[a-f0-9]+ ([A-Z.]+) [A-Z.]+ (-?[0-9]+),(-?[0-9]+)-(-?[0-9]+),(-?[0-9]+)(?: [^{}]*)?\}(?:\[[^\]]*\])?$')
    for line in lines:
        if not line.startswith('      '):
            break
        match = pattern.fullmatch(line)
        require(match, 'Malformed or unsupported native view hierarchy line')
        indent, name, flags = len(match[1]), match[2], match[3]
        rect = tuple(map(int, match.group(4, 5, 6, 7)))
        while stack and stack[-1][0] >= indent:
            stack.pop()
        require(not stack or indent == stack[-1][0] + 2, 'Malformed native hierarchy indentation')
        require(rect[2] >= rect[0] and rect[3] >= rect[1], 'Malformed native hierarchy rectangle')
        x, y = (stack[-1][1][0], stack[-1][1][1]) if stack else (0, 0)
        absolute = (x + rect[0], y + rect[1], x + rect[2], y + rect[3])
        visible = flags[0] == 'V' and (not stack or stack[-1][2])
        stack.append((indent, absolute, visible))
        if name == native_class:
            require(visible, 'Actual native view is hidden')
            matches.append(absolute)
    require(len(matches) == 1, 'A unique visible mapped native view is required')
    return matches[0]


def independent_bounds(text, encoded_zip, gfxinfo, package, binding):
    bounds, evidence = encoded_native_bounds(encoded_zip, package, binding['nativeClass'])
    require(text_native_bounds(text, package, binding['nativeClass']) == bounds,
            'Native text and encoded hierarchy bounds disagree')
    sizes = re.findall(r'^TextureView: ([1-9][0-9]*)x([1-9][0-9]*)$', gfxinfo, re.M)
    require(len(sizes) == 1 and tuple(map(int, sizes[0])) == (bounds[2] - bounds[0], bounds[3] - bounds[1]),
            'Unique native TextureView layer size does not match actual view')
    evidence['display'] = activity_display_observation(text, package)
    return bounds, evidence
