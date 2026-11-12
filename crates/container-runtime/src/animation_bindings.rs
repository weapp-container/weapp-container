//! Private animation binding inputs. Evaluation supplies paths, never owners
//! or stamps. Snapshots are captured alongside data, before View/user hooks.
use container_bridge::{BridgeError, BridgeErrorCode};
use container_core::{DataPatch, DataPathToken};
use container_ir::{BindingDataPath, BindingPathSegment, WxmlAttributeSource};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

const MAX_PATHS: usize = 100_000;
const MAX_OWNERS: usize = 4096;
const MAX_BYTES: usize = 8 * 1024 * 1024;
fn path_bytes(path: &BindingDataPath) -> usize {
    path.iter()
        .map(|part| match part {
            BindingPathSegment::Key(text) => text.len().saturating_add(24),
            BindingPathSegment::Index(_) => 24,
        })
        .sum::<usize>()
        .saturating_add(32)
}
struct BudgetWriter(usize);
impl std::io::Write for BudgetWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len())
            .filter(|size| *size <= MAX_BYTES)
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "animation candidate exceeds byte budget",
                )
            })?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub(super) fn preflight_payloads<'a>(
    payloads: impl IntoIterator<Item = &'a Value>,
) -> Result<(), BridgeError> {
    let mut writer = BudgetWriter(0);
    let mut count = 0;
    for payload in payloads {
        count += 1;
        if count > MAX_OWNERS {
            return Err(invalid("animation active binding count exceeded"));
        }
        serde_json::to_writer(&mut writer, payload)
            .map_err(|_| invalid("animation aggregate payload byte budget exceeded"))?;
    }
    Ok(())
}
fn invalid(message: &str) -> BridgeError {
    BridgeError::new(BridgeErrorCode::Render, message)
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct OwnerKey {
    pub page_id: u64,
    pub page_incarnation: u64,
    pub scope_id: Option<String>,
    pub scope_incarnation: Option<u64>,
}
impl OwnerKey {
    pub fn validate(&self) -> Result<(), BridgeError> {
        if self.page_id == 0
            || self.page_incarnation == 0
            || self.scope_id.is_some() != self.scope_incarnation.is_some()
            || self.scope_incarnation == Some(0)
            || self
                .scope_id
                .as_ref()
                .is_some_and(|scope| scope.is_empty() || scope.len() > 4096)
        {
            return Err(invalid("invalid private animation owner"));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Default)]
pub(super) struct WriteLedger {
    poisoned: bool,
    sequence: u64,
    owners: BTreeMap<OwnerKey, BTreeMap<BindingDataPath, u64>>,
}
#[derive(Clone, Debug)]
pub(super) struct WriteSnapshot {
    pub owner: OwnerKey,
    paths: BTreeMap<BindingDataPath, u64>,
    local: BTreeMap<BindingDataPath, bool>,
}
impl WriteLedger {
    pub fn ensure_valid(&self) -> Result<(), BridgeError> {
        if self.poisoned {
            Err(invalid(
                "animation write provenance is invalid; a new Session is required",
            ))
        } else {
            Ok(())
        }
    }
    pub fn poison(&mut self) {
        self.poisoned = true;
    }
    /// Reserve before data mutation. Resource failure cannot leave accepted
    /// data without a stamp. Commit only after the data transaction succeeds.
    pub fn prepare_record(
        &self,
        owner: &OwnerKey,
        paths: &[BindingDataPath],
    ) -> Result<PreparedWrites, BridgeError> {
        self.ensure_valid()?;
        owner.validate()?;
        if paths.len() > MAX_PATHS
            || paths
                .iter()
                .any(|path| path.len() > 256 || path_bytes(path) > MAX_BYTES)
        {
            return Err(invalid("animation write path budget exceeded"));
        }
        let next = if paths.is_empty() {
            self.sequence
        } else {
            self.sequence
                .checked_add(1)
                .ok_or_else(|| invalid("animation write stamp exhausted"))?
        };
        let previous = self.owners.get(owner);
        let survives = |path: &BindingDataPath| !paths.iter().any(|new| path.starts_with(new));
        let mut count = 0usize;
        let mut bytes = self
            .owners
            .keys()
            .map(|owner| owner.scope_id.as_ref().map_or(0, String::len) + 64)
            .sum::<usize>()
            + if self.owners.contains_key(owner) {
                0
            } else {
                owner.scope_id.as_ref().map_or(0, String::len) + 64
            };
        for (key, entries) in &self.owners {
            for path in entries.keys() {
                if key != owner || survives(path) {
                    count = count.saturating_add(1);
                    bytes = bytes.saturating_add(path_bytes(path));
                }
            }
        }
        for path in paths {
            count = count.saturating_add(1);
            bytes = bytes.saturating_add(path_bytes(path));
        }
        if count > MAX_PATHS
            || bytes > MAX_BYTES
            || self.owners.len() + usize::from(!self.owners.contains_key(owner)) > MAX_OWNERS
        {
            return Err(invalid("animation aggregate write ledger budget exceeded"));
        }
        let mut candidate = previous
            .map(|entries| {
                entries
                    .iter()
                    .filter(|(path, _)| survives(path))
                    .map(|(path, stamp)| (path.clone(), *stamp))
                    .collect::<BTreeMap<_, _>>()
            })
            .unwrap_or_default();
        for path in paths {
            candidate.insert(path.clone(), next);
        }
        Ok(PreparedWrites {
            base_sequence: self.sequence,
            sequence: next,
            owner: owner.clone(),
            paths: candidate,
        })
    }
    pub fn prepare_patches(
        &self,
        owner: &OwnerKey,
        patches: &[DataPatch],
    ) -> Result<PreparedWrites, BridgeError> {
        if patches.len() > MAX_PATHS
            || patches
                .iter()
                .map(|patch| patch.path.len())
                .try_fold(0usize, |total, size| total.checked_add(size))
                .is_none_or(|size| size > MAX_BYTES)
        {
            return Err(invalid("animation patch path byte budget exceeded"));
        }
        self.prepare_record(owner, &patch_paths(patches)?)
    }
    pub fn validate_record(&self, prepared: &PreparedWrites) -> Result<(), BridgeError> {
        if self.sequence == prepared.base_sequence {
            Ok(())
        } else {
            Err(invalid("stale animation write reservation"))
        }
    }
    pub fn commit_record(&mut self, prepared: PreparedWrites) {
        debug_assert_eq!(self.sequence, prepared.base_sequence);
        self.sequence = prepared.sequence;
        self.owners.insert(prepared.owner, prepared.paths);
    }
    #[cfg(test)]
    pub fn record(
        &mut self,
        owner: &OwnerKey,
        paths: &[BindingDataPath],
    ) -> Result<(), BridgeError> {
        let prepared = self.prepare_record(owner, paths)?;
        self.commit_record(prepared);
        Ok(())
    }
    pub fn snapshot(&self, owner: &OwnerKey) -> WriteSnapshot {
        WriteSnapshot {
            owner: owner.clone(),
            paths: self.owners.get(owner).cloned().unwrap_or_default(),
            local: self
                .owners
                .get(owner)
                .map(|paths| paths.keys().map(|path| (path.clone(), true)).collect())
                .unwrap_or_default(),
        }
    }
    pub fn retire_page(&mut self, page: u64) {
        self.owners.retain(|owner, _| owner.page_id != page);
    }
    pub fn retire_scopes(&mut self, page: u64, scopes: &BTreeSet<String>) {
        self.owners.retain(|owner, _| {
            owner.page_id != page
                || owner
                    .scope_id
                    .as_ref()
                    .is_none_or(|scope| !scopes.contains(scope))
        });
    }
    pub fn retire_all(&mut self) {
        self.owners.clear();
    }
}
#[derive(Debug)]
pub(super) struct PreparedWrites {
    base_sequence: u64,
    sequence: u64,
    owner: OwnerKey,
    paths: BTreeMap<BindingDataPath, u64>,
}
fn patch_paths(patches: &[DataPatch]) -> Result<Vec<BindingDataPath>, BridgeError> {
    patches
        .iter()
        .map(|patch| {
            patch
                .path_tokens()
                .map(|parts| {
                    parts
                        .into_iter()
                        .map(|part| match part {
                            DataPathToken::Key(key) => BindingPathSegment::Key(key),
                            DataPathToken::Index(index) => BindingPathSegment::Index(index),
                        })
                        .collect()
                })
                .ok_or_else(|| invalid("invalid accepted animation write path"))
        })
        .collect()
}
impl WriteSnapshot {
    /// Input is native-retained receiver capture, never public effect JSON.
    pub fn from_private(owner: OwnerKey, records: &Value) -> Result<Self, BridgeError> {
        owner.validate()?;
        let records = records
            .as_array()
            .ok_or_else(|| invalid("animation private write snapshot unavailable"))?;
        if records.len() > MAX_PATHS {
            return Err(invalid("animation write snapshot path budget exceeded"));
        }
        let mut paths = BTreeMap::new();
        let mut local = BTreeMap::new();
        let mut bytes = 0usize;
        for record in records {
            let path: BindingDataPath = serde_json::from_value(
                record
                    .get("path")
                    .cloned()
                    .ok_or_else(|| invalid("invalid private write path"))?,
            )
            .map_err(|_| invalid("invalid private write path"))?;
            let text = record
                .get("stamp")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("invalid private write stamp"))?;
            let stamp = text
                .parse::<u64>()
                .ok()
                .filter(|stamp| *stamp != 0 && stamp.to_string() == text)
                .ok_or_else(|| invalid("invalid private write stamp"))?;
            bytes = bytes.saturating_add(path_bytes(&path));
            local.insert(
                path.clone(),
                record
                    .get("local")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| invalid("invalid private write source"))?,
            );
            if path.len() > 256 || bytes > MAX_BYTES || paths.insert(path, stamp).is_some() {
                return Err(invalid("invalid or oversized private write snapshot"));
            }
        }
        Ok(Self {
            owner,
            paths,
            local,
        })
    }
    fn is_local(&self, path: &BindingDataPath) -> bool {
        self.paths
            .iter()
            .filter(|(other, _)| other.starts_with(path) || path.starts_with(other))
            .max_by_key(|(_, stamp)| *stamp)
            .is_some_and(|(key, _)| self.local.get(key) == Some(&true))
    }
    pub fn stamp(&self, path: &BindingDataPath) -> u64 {
        self.paths
            .iter()
            .filter(|(other, _)| other.starts_with(path) || path.starts_with(other))
            .map(|(_, stamp)| *stamp)
            .max()
            .unwrap_or(0)
    }
}
#[derive(Clone, Debug)]
pub(super) struct ForwardedInput {
    pub source: WxmlAttributeSource,
    pub snapshot: Arc<ScopeSnapshot>,
}
#[derive(Clone, Debug)]
pub(super) struct ScopeSnapshot {
    pub owner: OwnerKey,
    pub writes: WriteSnapshot,
    pub forwarded_inputs: BTreeMap<String, ForwardedInput>,
}
impl ScopeSnapshot {
    pub fn new(writes: WriteSnapshot) -> Self {
        Self {
            owner: writes.owner.clone(),
            writes,
            forwarded_inputs: BTreeMap::new(),
        }
    }
    pub fn forward(&mut self, name: String, source: WxmlAttributeSource, snapshot: Arc<Self>) {
        self.forwarded_inputs
            .insert(name, ForwardedInput { source, snapshot });
    }
    pub fn resolve(&self, source: &WxmlAttributeSource) -> Result<Vec<ResolvedPath>, BridgeError> {
        self.resolve_inner(source, &[], 0)
    }
    fn resolve_inner(
        &self,
        source: &WxmlAttributeSource,
        suffix: &[BindingPathSegment],
        depth: usize,
    ) -> Result<Vec<ResolvedPath>, BridgeError> {
        if depth > 64 || !source.supported {
            return Err(invalid("unsupported animation binding provenance"));
        }
        self.owner.validate()?;
        if self.writes.owner != self.owner {
            return Err(invalid("animation snapshot owner mismatch"));
        }
        let mut resolved = Vec::new();
        for base in &source.paths {
            let mut path = base.clone();
            if source.direct_path.as_ref() == Some(base) {
                path.extend_from_slice(suffix);
            }
            if let Some(BindingPathSegment::Key(root)) = path.first() {
                if let Some(forward) = self
                    .forwarded_inputs
                    .get(root)
                    .filter(|_| !self.writes.is_local(&path))
                {
                    resolved.extend(forward.snapshot.resolve_inner(
                        &forward.source,
                        &path[1..],
                        depth + 1,
                    )?);
                    continue;
                }
            }
            resolved.push(ResolvedPath {
                owner: self.owner.clone(),
                stamp: self.writes.stamp(&path),
                path,
            });
        }
        resolved.sort();
        resolved.dedup();
        Ok(resolved)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct ResolvedPath {
    pub owner: OwnerKey,
    pub path: BindingDataPath,
    pub stamp: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct NodeKey {
    pub owner: OwnerKey,
    pub source_site: String,
    pub incarnation: u64,
}
#[derive(Clone, Debug)]
pub(super) struct BindingInput {
    pub occurrence: String,
    pub source_site: String,
    pub scope_snapshot: Arc<ScopeSnapshot>,
    pub source: WxmlAttributeSource,
    pub payload: Value,
}
#[derive(Clone, Debug)]
pub(super) struct PreparedDescriptor {
    pub occurrence: String,
    pub key: NodeKey,
    pub resolved_paths: Vec<ResolvedPath>,
    pub payload: Value,
    pub new_run: bool,
}
#[derive(Clone, Debug)]
struct AcceptedBinding {
    descriptor: PreparedDescriptor,
    local_paths: Vec<ResolvedPath>,
}
#[derive(Clone, Debug, Default)]
pub(super) struct AnimationBindings {
    generation: u64,
    next_node: u64,
    entries: BTreeMap<(OwnerKey, String), AcceptedBinding>,
    hidden: BTreeSet<u64>,
}
#[derive(Clone, Debug)]
pub(super) struct PreparedBindings {
    base_generation: u64,
    next_generation: u64,
    next_node: u64,
    entries: BTreeMap<(OwnerKey, String), AcceptedBinding>,
    pub descriptors: Vec<PreparedDescriptor>,
}
impl AnimationBindings {
    /// The private receipt may have been captured before an already accepted
    /// frame. Only a newer intersecting dependency requests another binding.
    pub fn touches(&self, owner: &OwnerKey, paths: &[BindingDataPath], stamp: u64) -> bool {
        self.entries.values().any(|entry| {
            entry
                .descriptor
                .resolved_paths
                .iter()
                .chain(entry.local_paths.iter())
                .any(|dependency| {
                    dependency.owner == *owner
                        && stamp > dependency.stamp
                        && paths.iter().any(|path| {
                            path.starts_with(&dependency.path) || dependency.path.starts_with(path)
                        })
                })
        })
    }
    pub fn prepare(
        &self,
        page: u64,
        inputs: Vec<BindingInput>,
    ) -> Result<PreparedBindings, BridgeError> {
        preflight_payloads(
            self.entries
                .iter()
                .filter(|((owner, _), _)| owner.page_id != page)
                .map(|(_, entry)| &entry.descriptor.payload)
                .chain(inputs.iter().map(|input| &input.payload)),
        )?;
        let identity_bytes = self
            .entries
            .iter()
            .filter(|((owner, _), _)| owner.page_id != page)
            .map(|((owner, site), entry)| {
                site.len()
                    + entry.descriptor.occurrence.len()
                    + owner.scope_id.as_ref().map_or(0, String::len)
            })
            .chain(inputs.iter().map(|input| {
                input.source_site.len()
                    + input.occurrence.len()
                    + input
                        .scope_snapshot
                        .owner
                        .scope_id
                        .as_ref()
                        .map_or(0, String::len)
            }))
            .try_fold(0usize, |total, size| total.checked_add(size))
            .ok_or_else(|| invalid("animation identity byte budget exceeded"))?;
        if identity_bytes > MAX_BYTES {
            return Err(invalid("animation identity byte budget exceeded"));
        }
        let mut entries = self
            .entries
            .iter()
            .filter(|((owner, _), _)| owner.page_id != page)
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<BTreeMap<_, _>>();
        let mut next_node = self.next_node;
        let mut descriptors = Vec::new();
        let mut occurrences = BTreeSet::new();
        for input in inputs {
            let owner = &input.scope_snapshot.owner;
            owner.validate()?;
            if owner.page_id != page
                || input.source.attribute != "animation"
                || input.source_site != input.source.source_site
                || input.occurrence.is_empty()
                || input.source_site.is_empty()
                || input.source_site.len() > 16384
                || !occurrences.insert(input.occurrence.clone())
            {
                return Err(invalid("invalid or duplicate animation binding"));
            }
            let identity = (owner.clone(), input.source_site.clone());
            let previous = self.entries.get(&identity);
            let resolved_paths = input.scope_snapshot.resolve(&input.source)?;
            let key = if let Some(previous) = previous {
                previous.descriptor.key.clone()
            } else {
                next_node = next_node
                    .checked_add(1)
                    .ok_or_else(|| invalid("animation node incarnation exhausted"))?;
                NodeKey {
                    owner: owner.clone(),
                    source_site: input.source_site,
                    incarnation: next_node,
                }
            };
            let new_run = previous
                .is_none_or(|previous| previous.descriptor.resolved_paths != resolved_paths);
            let local_paths = input
                .source
                .paths
                .iter()
                .map(|path| ResolvedPath {
                    owner: owner.clone(),
                    path: path.clone(),
                    stamp: input.scope_snapshot.writes.stamp(path),
                })
                .collect();
            let descriptor = PreparedDescriptor {
                occurrence: input.occurrence,
                key,
                resolved_paths,
                payload: input.payload,
                new_run,
            };
            if entries
                .insert(
                    identity,
                    AcceptedBinding {
                        descriptor: descriptor.clone(),
                        local_paths,
                    },
                )
                .is_some()
            {
                return Err(invalid("duplicate animation source occurrence"));
            }
            descriptors.push(descriptor);
        }
        if entries.len() > MAX_OWNERS {
            return Err(invalid("animation binding count exceeded"));
        }
        Ok(PreparedBindings {
            base_generation: self.generation,
            next_generation: self
                .generation
                .checked_add(1)
                .ok_or_else(|| invalid("animation binding generation exhausted"))?,
            next_node,
            entries,
            descriptors,
        })
    }
    /// Must run immediately before the joint renderer publication. Adopt below
    /// consists only of moves and cannot invoke guest code or return failure.
    pub fn validate(&self, prepared: &PreparedBindings) -> Result<(), BridgeError> {
        if self.generation == prepared.base_generation {
            Ok(())
        } else {
            Err(invalid("stale animation binding candidate"))
        }
    }
    pub fn accept(&mut self, prepared: PreparedBindings) {
        debug_assert_eq!(self.generation, prepared.base_generation);
        self.generation = prepared.next_generation;
        self.next_node = prepared.next_node;
        self.entries = prepared.entries;
    }
    pub fn set_visibility(&mut self, page: u64, visible: bool) {
        if visible {
            self.hidden.remove(&page);
        } else {
            self.hidden.insert(page);
        }
        self.invalidate();
    }
    pub fn is_visible(&self, page: u64) -> bool {
        !self.hidden.contains(&page)
    }
    pub fn retire_page(&mut self, page: u64) {
        self.retire_page_topology(page);
        self.hidden.remove(&page);
    }
    /// A presented replacement can remove every node without unloading its
    /// Page owner. Keep visibility and private write ownership intact.
    pub fn retire_page_topology(&mut self, page: u64) {
        self.entries.retain(|(owner, _), _| owner.page_id != page);
        self.invalidate();
    }
    pub fn retire_scopes(&mut self, page: u64, scopes: &BTreeSet<String>) {
        self.entries.retain(|(owner, _), _| {
            owner.page_id != page
                || owner
                    .scope_id
                    .as_ref()
                    .is_none_or(|scope| !scopes.contains(scope))
        });
        self.invalidate();
    }
    pub fn retire_all(&mut self) {
        self.entries.clear();
        self.hidden.clear();
        self.invalidate();
    }
    fn invalidate(&mut self) {
        self.generation = self.generation.saturating_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn owner() -> OwnerKey {
        OwnerKey {
            page_id: 1,
            page_incarnation: 11,
            scope_id: None,
            scope_incarnation: None,
        }
    }
    fn path(name: &str) -> BindingDataPath {
        vec![BindingPathSegment::Key(name.into())]
    }
    fn input(snapshot: Arc<ScopeSnapshot>) -> BindingInput {
        BindingInput {
            occurrence: "event:0".into(),
            source_site: "source".into(),
            source: WxmlAttributeSource {
                source_site: "source".into(),
                attribute: "animation".into(),
                paths: vec![path("anim")],
                direct_path: Some(path("anim")),
                supported: true,
            },
            scope_snapshot: snapshot,
            payload: json!({"actions":[]}),
        }
    }
    #[test]
    fn equal_writes_replay_but_unrelated_writes_and_old_snapshots_do_not() {
        let mut ledger = WriteLedger::default();
        let owner = owner();
        ledger.record(&owner, &[path("anim")]).unwrap();
        let first = Arc::new(ScopeSnapshot::new(ledger.snapshot(&owner)));
        let mut bindings = AnimationBindings::default();
        let prepared = bindings.prepare(1, vec![input(first.clone())]).unwrap();
        assert!(prepared.descriptors[0].new_run);
        let key = prepared.descriptors[0].key.clone();
        bindings.accept(prepared);
        ledger.record(&owner, &[path("other")]).unwrap();
        let unchanged = bindings
            .prepare(
                1,
                vec![input(Arc::new(ScopeSnapshot::new(ledger.snapshot(&owner))))],
            )
            .unwrap();
        assert!(!unchanged.descriptors[0].new_run);
        bindings.accept(unchanged);
        ledger.record(&owner, &[path("anim")]).unwrap();
        let replay = bindings
            .prepare(
                1,
                vec![input(Arc::new(ScopeSnapshot::new(ledger.snapshot(&owner))))],
            )
            .unwrap();
        assert!(replay.descriptors[0].new_run);
        assert_eq!(replay.descriptors[0].key, key);
        assert!(!bindings.prepare(1, vec![input(first)]).unwrap().descriptors[0].new_run);
    }
    #[test]
    fn changed_payload_without_a_matching_write_does_not_authorize_replay() {
        let mut ledger = WriteLedger::default();
        let owner = owner();
        ledger.record(&owner, &[path("anim")]).unwrap();
        let mut bindings = AnimationBindings::default();
        let first = bindings
            .prepare(
                1,
                vec![input(Arc::new(ScopeSnapshot::new(ledger.snapshot(&owner))))],
            )
            .unwrap();
        bindings.accept(first);
        ledger.record(&owner, &[path("other")]).unwrap();
        let mut mutated = input(Arc::new(ScopeSnapshot::new(ledger.snapshot(&owner))));
        mutated.payload = json!({"actions":[{"opacity":0.4}]});
        let changed = bindings.prepare(1, vec![mutated.clone()]).unwrap();
        assert!(!changed.descriptors[0].new_run);
        bindings.accept(changed);
        ledger.record(&owner, &[path("anim")]).unwrap();
        mutated.scope_snapshot = Arc::new(ScopeSnapshot::new(ledger.snapshot(&owner)));
        let replay = bindings.prepare(1, vec![mutated]).unwrap();
        assert!(replay.descriptors[0].new_run);
    }

    #[test]
    fn topology_retirement_preserves_hidden_page_and_recreates_its_nodes() {
        let ledger = WriteLedger::default();
        let snapshot = Arc::new(ScopeSnapshot::new(ledger.snapshot(&owner())));
        let mut bindings = AnimationBindings::default();
        let first = bindings.prepare(1, vec![input(snapshot.clone())]).unwrap();
        let key = first.descriptors[0].key.clone();
        bindings.accept(first);
        bindings.set_visibility(1, false);
        let stale = bindings.prepare(1, vec![input(snapshot.clone())]).unwrap();
        bindings.retire_page_topology(1);
        assert!(!bindings.is_visible(1));
        assert!(bindings.validate(&stale).is_err());
        let recreated = bindings.prepare(1, vec![input(snapshot)]).unwrap();
        assert!(recreated.descriptors[0].new_run);
        assert_eq!(recreated.descriptors[0].key.owner, key.owner);
        assert_ne!(recreated.descriptors[0].key.incarnation, key.incarnation);
    }

    #[test]
    fn failed_candidate_never_consumes_node_or_replay_generation() {
        let ledger = WriteLedger::default();
        let snapshot = Arc::new(ScopeSnapshot::new(ledger.snapshot(&owner())));
        let mut bindings = AnimationBindings::default();
        let failed = bindings.prepare(1, vec![input(snapshot.clone())]).unwrap();
        let retry = bindings.prepare(1, vec![input(snapshot.clone())]).unwrap();
        assert_eq!(failed.descriptors[0].key, retry.descriptors[0].key);
        assert!(retry.descriptors[0].new_run);
        bindings.accept(retry);
        assert!(bindings.validate(&failed).is_err());
        bindings.accept(bindings.prepare(1, vec![]).unwrap());
        let recreated = bindings.prepare(1, vec![input(snapshot)]).unwrap();
        assert_ne!(recreated.descriptors[0].key, failed.descriptors[0].key);
    }
    #[test]
    fn reservations_prune_overwritten_descendants_and_poison_is_sticky() {
        let mut ledger = WriteLedger::default();
        let owner = owner();
        let mut nested = path("anim");
        nested.push(BindingPathSegment::Key("actions".into()));
        ledger.record(&owner, &[nested]).unwrap();
        let reserved = ledger.prepare_record(&owner, &[path("anim")]).unwrap();
        assert_eq!(ledger.snapshot(&owner).paths.len(), 1);
        ledger.commit_record(reserved);
        assert_eq!(ledger.snapshot(&owner).paths.len(), 1);
        ledger.poison();
        ledger.retire_all();
        assert!(ledger.prepare_record(&owner, &[]).is_err());
    }
    #[test]
    fn forwarded_property_uses_parent_clone_stamp_and_local_override() {
        let mut ledger = WriteLedger::default();
        let parent = owner();
        ledger.record(&parent, &[path("anim")]).unwrap();
        let root = Arc::new(ScopeSnapshot::new(ledger.snapshot(&parent)));
        let child = OwnerKey {
            scope_id: Some("component".into()),
            scope_incarnation: Some(12),
            ..parent.clone()
        };
        let mut snapshot = ScopeSnapshot::new(ledger.snapshot(&child));
        let source = input(root.clone()).source;
        snapshot.forward("prop".into(), source, root);
        let mut binding = input(Arc::new(snapshot.clone()));
        binding.source.paths = vec![path("prop")];
        binding.source.direct_path = Some(path("prop"));
        let resolved = binding.scope_snapshot.resolve(&binding.source).unwrap();
        assert_eq!(resolved[0].owner, parent);
        assert_eq!(resolved[0].stamp, 1);
        ledger.record(&child, &[path("prop")]).unwrap();
        snapshot.writes = ledger.snapshot(&child);
        let resolved = snapshot.resolve(&binding.source).unwrap();
        assert_eq!(resolved[0].owner, child);
    }
    #[test]
    fn aggregate_payload_budget_is_checked_before_candidate_cloning() {
        let value = json!("x".repeat(MAX_BYTES));
        assert!(preflight_payloads([&value]).is_err());
    }
}
