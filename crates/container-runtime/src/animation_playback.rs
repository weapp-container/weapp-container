//! Session-owned, staged numeric animation playback.
//!
//! Explicit container policy: an accepted replacement starts at its publication
//! instant from the old run's sample captured during preparation. Empty queues
//! hold that captured style; removing the binding removes the layer. Ordinary
//! rerenders keep the original run and clock. No preparation, baseline reply or
//! host timestamp can publish a run or advance its captured sample.

use crate::{
    animation_bindings::{NodeKey, PreparedDescriptor},
    animation_protocol::{
        render_number, BaselineObservation, BaselineRequest, ConsumedSample, SampledStyle,
    },
    animation_timeline::{Program, Sample, Timeline, Values},
};
use container_bridge::{BridgeError, BridgeErrorCode};
use container_render_skia::Rect;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};

const MAX_RUNS: usize = 4096;
const SAMPLE_CADENCE: Duration = Duration::from_millis(16);

fn invalid(message: &str) -> BridgeError {
    BridgeError::new(BridgeErrorCode::InvalidRequest, message)
}

fn exhausted(message: &str) -> BridgeError {
    BridgeError::new(BridgeErrorCode::Render, message)
}

#[derive(Clone, Copy, Debug, Default)]
struct KnownProperties {
    opacity: bool,
    transform: bool,
}

#[derive(Clone, Debug)]
struct Run {
    occurrence: String,
    timeline: Option<Arc<Timeline>>,
    held: Sample,
    inherited_style: SampledStyle,
    known: KnownProperties,
    font_size: f32,
    elapsed_offset: Duration,
    anchor: Option<Duration>,
    sampled_elapsed: Duration,
}

impl Run {
    fn elapsed(&self, now: Duration) -> Result<Duration, BridgeError> {
        self.anchor.map_or(Ok(self.elapsed_offset), |anchor| {
            now.checked_sub(anchor)
                .and_then(|elapsed| self.elapsed_offset.checked_add(elapsed))
                .ok_or_else(|| invalid("animation clock regressed or elapsed time overflowed"))
        })
    }

    fn capture(
        &self,
        now: Duration,
        viewport: Rect,
    ) -> Result<(Sample, SampledStyle, Duration), BridgeError> {
        let elapsed = self.elapsed(now)?;
        let sample = match &self.timeline {
            Some(timeline) => timeline.sample(elapsed)?,
            None => self.held.clone(),
        };
        let mut style =
            SampledStyle::from_sample(self.occurrence.clone(), &sample, self.font_size, viewport)?;
        style.inherit_missing(&self.inherited_style);
        Ok((sample, style, elapsed))
    }

    fn progress(&self, now: Duration) -> Result<Option<(Duration, Duration)>, BridgeError> {
        let Some(timeline) = &self.timeline else {
            return Ok(None);
        };
        let duration = timeline.duration();
        let elapsed = self.elapsed(now)?.min(duration);
        if elapsed <= self.sampled_elapsed.min(duration) {
            return Ok(None);
        }
        Ok(Some((elapsed, duration)))
    }
}

#[derive(Clone, Debug)]
struct StagedRun {
    key: NodeKey,
    occurrence: String,
    previous: Option<Run>,
    program: Option<Program>,
    captured: Sample,
    inherited_style: SampledStyle,
    captured_elapsed: Duration,
    known: KnownProperties,
}

/// A preparation is a frozen sample plus a generation reservation. Template
/// preparations need exact baseline coverage before validation; sample-only
/// preparations are immediately complete and never reenter View or data.
#[derive(Clone, Debug)]
pub(super) struct PreparedPlayback {
    base_generation: u64,
    next_generation: u64,
    pub page: u64,
    viewport: Rect,
    entries: BTreeMap<NodeKey, Run>,
    staged: Vec<StagedRun>,
    starts: BTreeSet<NodeKey>,
    bound: bool,
    pub captured_at: Duration,
    pub baseline_requests: Vec<BaselineRequest>,
    pub styles: Vec<SampledStyle>,
    pub consumed_sample: Option<ConsumedSample>,
}

impl PreparedPlayback {
    /// Baselines may arrive in any order, exactly once per requested occurrence.
    /// Validate/build into local values first so even a bad final observation
    /// leaves both this candidate and the accepted owner unchanged.
    pub fn bind_baselines(
        &mut self,
        observations: &[BaselineObservation],
    ) -> Result<(), BridgeError> {
        if self.bound {
            if self.baseline_requests.is_empty() && observations.is_empty() {
                return Ok(());
            }
            return Err(invalid("animation baselines were already bound"));
        }
        if observations.len() != self.baseline_requests.len() {
            return Err(invalid(
                "animation baselines require exact occurrence coverage",
            ));
        }
        let mut observed = BTreeMap::new();
        for observation in observations {
            if observed
                .insert(observation.occurrence_id.as_str(), observation)
                .is_some()
            {
                return Err(invalid("duplicate animation baseline occurrence"));
            }
        }
        for request in &self.baseline_requests {
            observed
                .get(request.occurrence_id.as_str())
                .ok_or_else(|| invalid("missing animation baseline occurrence"))?
                .validate(request)?;
        }
        let mut entries = self.entries.clone();
        let mut styles = Vec::with_capacity(self.staged.len());
        for staged in &self.staged {
            let observation = observed[staged.occurrence.as_str()];
            let font_size = render_number(observation.font_size)?;
            let mut run = if let Some(program) = &staged.program {
                let mut baseline = staged.captured.values;
                let mut known = staged.known;
                if let Some(matrix) = observation.transform {
                    baseline = Values::from_affine(baseline.opacity, matrix.affine()?)?;
                    known.transform = true;
                }
                if let Some(opacity) = observation.opacity {
                    baseline.opacity = Some(opacity);
                    known.opacity = true;
                }
                let timeline = if program.is_empty() {
                    None
                } else {
                    Some(Arc::new(program.clone().bind(baseline)?))
                };
                let mut held = staged.captured.clone();
                held.values = baseline;
                held.finished = true;
                Run {
                    occurrence: staged.occurrence.clone(),
                    timeline,
                    held,
                    inherited_style: staged.inherited_style.clone(),
                    known,
                    font_size,
                    elapsed_offset: Duration::ZERO,
                    anchor: None,
                    sampled_elapsed: Duration::ZERO,
                }
            } else {
                let mut previous = staged
                    .previous
                    .clone()
                    .ok_or_else(|| invalid("missing retained animation run"))?;
                previous.occurrence.clone_from(&staged.occurrence);
                previous.font_size = font_size;
                previous.sampled_elapsed = staged.captured_elapsed;
                previous
            };
            // Continuing runs must use the exact preparation-time sample. In
            // particular a slow baseline roundtrip never advances playback.
            let sample = if staged.program.is_some() {
                match &run.timeline {
                    Some(timeline) => timeline.sample(Duration::ZERO)?,
                    None => run.held.clone(),
                }
            } else {
                staged.captured.clone()
            };
            let mut style = SampledStyle::from_sample(
                staged.occurrence.clone(),
                &sample,
                font_size,
                self.viewport,
            )?;
            style.inherit_missing(&run.inherited_style);
            run.occurrence.clone_from(&staged.occurrence);
            styles.push(style);
            entries.insert(staged.key.clone(), run);
        }
        self.entries = entries;
        self.styles = styles;
        self.bound = true;
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub(super) struct PlaybackState {
    generation: Option<u64>,
    sample_revision: u64,
    demand_revision: Option<u64>,
    entries: BTreeMap<NodeKey, Run>,
    paused: BTreeSet<u64>,
    requested_progress: BTreeMap<NodeKey, Duration>,
}

impl Default for PlaybackState {
    fn default() -> Self {
        Self {
            generation: Some(0),
            sample_revision: 0,
            demand_revision: None,
            entries: BTreeMap::new(),
            paused: BTreeSet::new(),
            requested_progress: BTreeMap::new(),
        }
    }
}

impl PlaybackState {
    pub fn sample_demand_revision(&self) -> Option<u64> {
        self.demand_revision
    }

    fn reservation(
        &self,
        discover: bool,
    ) -> Result<(u64, u64, Option<ConsumedSample>), BridgeError> {
        let generation = self
            .generation
            .ok_or_else(|| exhausted("animation playback generation exhausted"))?;
        let next = generation
            .checked_add(1)
            .ok_or_else(|| exhausted("animation playback generation exhausted"))?;
        let consumed = if discover || self.demand_revision.is_some() {
            Some(ConsumedSample {
                demand_revision: self.demand_revision.unwrap_or(0),
                sample_revision: self
                    .sample_revision
                    .checked_add(1)
                    .ok_or_else(|| exhausted("animation sample revision exhausted"))?,
            })
        } else {
            None
        };
        Ok((generation, next, consumed))
    }

    pub fn prepare_bindings(
        &self,
        page: u64,
        descriptors: &[PreparedDescriptor],
        now: Duration,
        viewport: Rect,
    ) -> Result<PreparedPlayback, BridgeError> {
        validate_context(page, viewport)?;
        if self.paused.contains(&page) {
            return Err(invalid(
                "cannot prepare animation bindings for a paused page",
            ));
        }
        let retained = self
            .entries
            .keys()
            .filter(|key| key.owner.page_id != page)
            .count();
        if descriptors.len() > MAX_RUNS
            || retained
                .checked_add(descriptors.len())
                .is_none_or(|count| count > MAX_RUNS)
        {
            return Err(exhausted("animation active run budget exceeded"));
        }
        let (base_generation, next_generation, consumed_sample) =
            self.reservation(!descriptors.is_empty())?;
        let mut entries = self.entries.clone();
        entries.retain(|key, _| key.owner.page_id != page);
        let mut occurrences = BTreeSet::new();
        let mut keys = BTreeSet::new();
        let mut staged = Vec::with_capacity(descriptors.len());
        let mut baseline_requests = Vec::with_capacity(descriptors.len());
        let mut styles = Vec::with_capacity(descriptors.len());
        let mut starts = BTreeSet::new();
        for descriptor in descriptors {
            descriptor.key.owner.validate()?;
            if descriptor.key.owner.page_id != page
                || descriptor.key.incarnation == 0
                || descriptor.key.source_site.is_empty()
                || descriptor.occurrence.is_empty()
                || !occurrences.insert(descriptor.occurrence.clone())
                || !keys.insert(descriptor.key.clone())
            {
                return Err(invalid(
                    "invalid or duplicate animation playback occurrence",
                ));
            }
            let previous = self.entries.get(&descriptor.key).cloned();
            let (captured, mut style, captured_elapsed, known) = match &previous {
                Some(run) => {
                    let (sample, style, elapsed) = run.capture(now, viewport)?;
                    (sample, style, elapsed, run.known)
                }
                None => (
                    empty_sample(),
                    empty_style(&descriptor.occurrence),
                    Duration::ZERO,
                    KnownProperties::default(),
                ),
            };
            style.occurrence_id.clone_from(&descriptor.occurrence);
            let program = if descriptor.new_run || previous.is_none() {
                starts.insert(descriptor.key.clone());
                Some(Program::decode(&descriptor.payload)?)
            } else {
                None
            };
            baseline_requests.push(BaselineRequest {
                occurrence_id: descriptor.occurrence.clone(),
                opacity: program.as_ref().is_some_and(Program::uses_opacity) && !known.opacity,
                transform: program.as_ref().is_some_and(Program::uses_transform)
                    && !known.transform,
            });
            styles.push(style.clone());
            staged.push(StagedRun {
                key: descriptor.key.clone(),
                occurrence: descriptor.occurrence.clone(),
                previous,
                program,
                captured,
                inherited_style: style,
                captured_elapsed,
                known,
            });
        }
        Ok(PreparedPlayback {
            base_generation,
            next_generation,
            page,
            viewport,
            entries,
            staged,
            starts,
            bound: descriptors.is_empty(),
            captured_at: now,
            baseline_requests,
            styles,
            consumed_sample,
        })
    }

    pub fn prepare_sample(
        &self,
        page: u64,
        now: Duration,
        viewport: Rect,
    ) -> Result<PreparedPlayback, BridgeError> {
        validate_context(page, viewport)?;
        if self.demand_revision.is_none() || self.paused.contains(&page) {
            return Err(invalid(
                "animation sample lane is unavailable for this page",
            ));
        }
        let (base_generation, next_generation, consumed_sample) = self.reservation(false)?;
        let mut entries = self.entries.clone();
        let mut styles = Vec::new();
        for (key, run) in entries
            .iter_mut()
            .filter(|(key, _)| key.owner.page_id == page)
        {
            let (_, style, elapsed) = run.capture(now, viewport)?;
            run.sampled_elapsed = elapsed;
            styles.push(style);
            debug_assert_eq!(key.owner.page_id, page);
        }
        Ok(PreparedPlayback {
            base_generation,
            next_generation,
            page,
            viewport,
            entries,
            staged: Vec::new(),
            starts: BTreeSet::new(),
            bound: true,
            captured_at: now,
            baseline_requests: Vec::new(),
            styles,
            consumed_sample,
        })
    }

    /// Must precede joint renderer/binding publication. `accept` below consists
    /// solely of moves and already checked scalar updates.
    pub fn validate(&self, prepared: &PreparedPlayback) -> Result<(), BridgeError> {
        if self.generation != Some(prepared.base_generation) || !prepared.bound {
            return Err(invalid("stale or unbound animation playback candidate"));
        }
        Ok(())
    }

    pub fn accept(&mut self, mut prepared: PreparedPlayback, presented_at: Duration) {
        debug_assert!(self.validate(&prepared).is_ok());
        debug_assert!(presented_at >= prepared.captured_at);
        for key in &prepared.starts {
            if let Some(run) = prepared.entries.get_mut(key) {
                run.anchor = run.timeline.as_ref().map(|_| presented_at);
            }
            self.requested_progress.remove(key);
        }
        self.requested_progress
            .retain(|key, _| prepared.entries.contains_key(key));
        for (key, run) in &prepared.entries {
            let progress = self.requested_progress.entry(key.clone()).or_default();
            *progress = (*progress).max(run.sampled_elapsed);
        }
        if let Some(sample) = prepared.consumed_sample {
            self.sample_revision = sample.sample_revision;
            self.demand_revision.get_or_insert(sample.demand_revision);
        }
        self.generation = Some(prepared.next_generation);
        self.entries = prepared.entries;
    }

    /// Called only with the Session's trusted poll instant. Coalesce each run
    /// at ~16ms, with one exact final endpoint even inside that cadence. A late
    /// accepted capture never erases progress requested by a newer poll.
    pub fn request_sample(&mut self, page: u64, now: Duration) -> Result<bool, BridgeError> {
        if self.generation.is_none() {
            return Err(exhausted("animation playback generation exhausted"));
        }
        if self.paused.contains(&page) || self.demand_revision.is_none() {
            return Ok(false);
        }
        let mut advances = Vec::new();
        for (key, run) in self
            .entries
            .iter()
            .filter(|(key, _)| key.owner.page_id == page)
        {
            let Some((elapsed, duration)) = run.progress(now)? else {
                continue;
            };
            let previous = self
                .requested_progress
                .get(key)
                .copied()
                .unwrap_or(run.sampled_elapsed)
                .min(duration);
            if elapsed > previous && (elapsed - previous >= SAMPLE_CADENCE || elapsed == duration) {
                advances.push((key.clone(), elapsed));
            }
        }
        if advances.is_empty() {
            return Ok(false);
        }
        let next = self
            .demand_revision
            .unwrap()
            .checked_add(1)
            .ok_or_else(|| exhausted("animation sample demand revision exhausted"))?;
        for (key, elapsed) in advances {
            self.requested_progress.insert(key, elapsed);
        }
        self.demand_revision = Some(next);
        Ok(true)
    }

    pub fn set_visibility(
        &mut self,
        page: u64,
        visible: bool,
        now: Duration,
    ) -> Result<(), BridgeError> {
        if visible == !self.paused.contains(&page) {
            return Ok(());
        }
        let mut entries = self.entries.clone();
        for (_, run) in entries
            .iter_mut()
            .filter(|(key, _)| key.owner.page_id == page)
        {
            if visible {
                run.anchor = run.timeline.as_ref().map(|_| now);
            } else {
                run.elapsed_offset = run.elapsed(now)?;
                run.anchor = None;
            }
        }
        self.invalidate();
        if self.generation.is_none() {
            return Err(exhausted("animation playback generation exhausted"));
        }
        self.entries = entries;
        if visible {
            self.paused.remove(&page);
        } else {
            self.paused.insert(page);
        }
        Ok(())
    }

    pub fn retire_page(&mut self, page: u64) {
        self.retire_page_topology(page);
        self.paused.remove(&page);
    }

    /// Retire the presented node topology while retaining the Page's pause
    /// state. Its private data/write owner can later create new node runs.
    pub fn retire_page_topology(&mut self, page: u64) {
        self.entries.retain(|key, _| key.owner.page_id != page);
        self.requested_progress
            .retain(|key, _| key.owner.page_id != page);
        self.invalidate();
    }

    pub fn retire_scopes(&mut self, page: u64, scopes: &BTreeSet<String>) {
        let survives = |key: &NodeKey| {
            key.owner.page_id != page
                || key
                    .owner
                    .scope_id
                    .as_ref()
                    .is_none_or(|scope| !scopes.contains(scope))
        };
        self.entries.retain(|key, _| survives(key));
        self.requested_progress.retain(|key, _| survives(key));
        self.invalidate();
    }

    pub fn retire_all(&mut self) {
        self.entries.clear();
        self.requested_progress.clear();
        self.paused.clear();
        self.invalidate();
    }

    fn invalidate(&mut self) {
        self.generation = self
            .generation
            .and_then(|generation| generation.checked_add(1));
    }
}

fn validate_context(page: u64, viewport: Rect) -> Result<(), BridgeError> {
    if page == 0
        || ![viewport.x, viewport.y, viewport.width, viewport.height]
            .into_iter()
            .all(f32::is_finite)
        || viewport.width <= 0.0
        || viewport.height <= 0.0
    {
        return Err(invalid("invalid animation page or viewport"));
    }
    Ok(())
}

fn empty_sample() -> Sample {
    Sample {
        values: Values::default(),
        opacity: None,
        transform: None,
        transform_origin: None,
        finished: true,
    }
}

fn empty_style(occurrence: &str) -> SampledStyle {
    SampledStyle {
        occurrence_id: occurrence.into(),
        opacity: None,
        transform: None,
        origin: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        animation_bindings::OwnerKey,
        animation_protocol::{Matrix, OriginPoint},
    };
    use serde_json::{json, Value};

    const VIEWPORT: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 375.0,
        height: 667.0,
    };

    fn ms(time: u64) -> Duration {
        Duration::from_millis(time)
    }

    fn payload(kind: &str, target: f64, duration: u64) -> Value {
        json!({"actions":[{"animates":[{"type":kind,"args":[target]}],"option":{
            "duration":duration,"delay":0,"timingFunction":"linear","transformOrigin":"center"
        }}]})
    }

    fn descriptor(index: u64, payload: Value, new_run: bool) -> PreparedDescriptor {
        PreparedDescriptor {
            occurrence: format!("node-{index}"),
            key: NodeKey {
                owner: OwnerKey {
                    page_id: 1,
                    page_incarnation: 1,
                    scope_id: None,
                    scope_incarnation: None,
                },
                source_site: format!("site-{index}"),
                incarnation: index,
            },
            resolved_paths: Vec::new(),
            payload,
            new_run,
        }
    }

    fn baselines(prepared: &PreparedPlayback, opacity: f64) -> Vec<BaselineObservation> {
        prepared
            .baseline_requests
            .iter()
            .map(|request| BaselineObservation {
                occurrence_id: request.occurrence_id.clone(),
                opacity: request.opacity.then_some(opacity),
                transform: request.transform.then_some(Matrix {
                    a: 1.0,
                    b: 0.0,
                    c: 0.0,
                    d: 1.0,
                    tx: 10.0,
                    ty: 0.0,
                }),
                font_size: 16.0,
                origin: request.transform.then_some(OriginPoint { x: 0.0, y: 0.0 }),
            })
            .collect()
    }

    fn bound(
        state: &PlaybackState,
        descriptors: &[PreparedDescriptor],
        now: u64,
    ) -> PreparedPlayback {
        let mut prepared = state
            .prepare_bindings(1, descriptors, ms(now), VIEWPORT)
            .unwrap();
        let observations = baselines(&prepared, 0.2);
        prepared.bind_baselines(&observations).unwrap();
        prepared
    }

    fn publish(state: &mut PlaybackState, prepared: PreparedPlayback, now: u64) {
        state.validate(&prepared).unwrap();
        state.accept(prepared, ms(now));
    }

    fn close(actual: f32, expected: f32) {
        assert!(
            (actual - expected).abs() < 1.0e-5,
            "actual={actual} expected={expected}"
        );
    }

    #[test]
    fn legacy_candidates_stay_absent_and_discovery_is_sticky_only_after_acceptance() {
        let mut state = PlaybackState::default();
        let legacy = bound(&state, &[], 0);
        assert_eq!(legacy.consumed_sample, None);
        publish(&mut state, legacy, 0);
        let first = bound(
            &state,
            &[descriptor(1, payload("opacity", 1.0, 100), true)],
            10,
        );
        assert_eq!(state.sample_demand_revision(), None);
        assert_eq!(
            first.consumed_sample,
            Some(ConsumedSample {
                demand_revision: 0,
                sample_revision: 1
            })
        );
        publish(&mut state, first, 20);
        assert_eq!(state.sample_demand_revision(), Some(0));
        let removed = bound(&state, &[], 30);
        assert_eq!(
            removed.consumed_sample,
            Some(ConsumedSample {
                demand_revision: 0,
                sample_revision: 2
            })
        );
        assert!(removed.styles.is_empty());
        publish(&mut state, removed, 30);
        assert!(!state.request_sample(1, ms(100)).unwrap());
        state.retire_all();
        assert_eq!(state.sample_demand_revision(), Some(0));
        assert!(state
            .prepare_sample(1, ms(100), VIEWPORT)
            .unwrap()
            .styles
            .is_empty());
    }

    #[test]
    fn first_run_reads_only_its_real_property_and_starts_at_publication() {
        let mut state = PlaybackState::default();
        let input = descriptor(1, payload("opacity", 1.0, 100), true);
        let prepared = bound(&state, &[input], 10);
        assert_eq!(
            prepared.baseline_requests,
            vec![BaselineRequest {
                occurrence_id: "node-1".into(),
                opacity: true,
                transform: false
            }]
        );
        close(prepared.styles[0].opacity.unwrap(), 0.2);
        assert_eq!(prepared.styles[0].transform, None);
        assert_eq!(prepared.styles[0].origin, None);
        publish(&mut state, prepared, 100);
        let sample = state.prepare_sample(1, ms(150), VIEWPORT).unwrap();
        close(sample.styles[0].opacity.unwrap(), 0.6);
        assert_eq!(sample.captured_at, ms(150));
    }

    #[test]
    fn continuing_render_uses_capture_time_through_a_slow_baseline_reply_without_restart() {
        let mut state = PlaybackState::default();
        let mut input = descriptor(1, payload("opacity", 1.0, 100), true);
        let prepared = bound(&state, std::slice::from_ref(&input), 0);
        publish(&mut state, prepared, 0);
        let original = state.entries[&input.key].timeline.clone().unwrap();
        input.new_run = false;
        let mut delayed = state
            .prepare_bindings(1, std::slice::from_ref(&input), ms(25), VIEWPORT)
            .unwrap();
        assert!(!delayed.baseline_requests[0].opacity && !delayed.baseline_requests[0].transform);
        let observations = baselines(&delayed, 0.99);
        delayed.bind_baselines(&observations).unwrap();
        close(delayed.styles[0].opacity.unwrap(), 0.4);
        publish(&mut state, delayed, 75);
        assert!(Arc::ptr_eq(
            &original,
            state.entries[&input.key].timeline.as_ref().unwrap()
        ));
        close(
            state.prepare_sample(1, ms(80), VIEWPORT).unwrap().styles[0]
                .opacity
                .unwrap(),
            0.84,
        );
    }

    #[test]
    fn replacement_uses_the_old_typed_capture_and_only_starts_after_its_own_publication() {
        let mut state = PlaybackState::default();
        let input = descriptor(1, payload("opacity", 1.0, 100), true);
        let first = bound(&state, &[input], 0);
        publish(&mut state, first, 0);
        let replacement = descriptor(1, payload("opacity", 0.0, 100), true);
        let prepared = bound(&state, &[replacement], 50);
        assert!(!prepared.baseline_requests[0].opacity);
        close(prepared.styles[0].opacity.unwrap(), 0.6);
        publish(&mut state, prepared, 100);
        close(
            state.prepare_sample(1, ms(150), VIEWPORT).unwrap().styles[0]
                .opacity
                .unwrap(),
            0.3,
        );
    }

    #[test]
    fn newly_touched_properties_observe_actual_css_while_known_properties_remain_context_only() {
        let mut state = PlaybackState::default();
        let first = bound(
            &state,
            &[descriptor(1, payload("translateX", 30.0, 100), true)],
            0,
        );
        assert!(!first.baseline_requests[0].opacity && first.baseline_requests[0].transform);
        publish(&mut state, first, 0);
        let next = bound(
            &state,
            &[descriptor(1, payload("opacity", 1.0, 100), true)],
            50,
        );
        assert!(next.baseline_requests[0].opacity && !next.baseline_requests[0].transform);
        close(next.styles[0].transform.unwrap().tx as f32, 20.0);
        publish(&mut state, next, 50);
        let third = bound(
            &state,
            &[descriptor(1, payload("translateX", 40.0, 100), true)],
            75,
        );
        assert!(!third.baseline_requests[0].opacity && !third.baseline_requests[0].transform);
        close(third.styles[0].transform.unwrap().tx as f32, 20.0);
        close(third.styles[0].opacity.unwrap(), 0.4);
    }

    #[test]
    fn empty_replacement_holds_captured_style_and_removed_binding_retires_the_layer() {
        let mut state = PlaybackState::default();
        let first = bound(
            &state,
            &[descriptor(1, payload("opacity", 1.0, 100), true)],
            0,
        );
        publish(&mut state, first, 0);
        let empty = descriptor(1, json!({"actions":[]}), true);
        let prepared = bound(&state, &[empty], 50);
        close(prepared.styles[0].opacity.unwrap(), 0.6);
        publish(&mut state, prepared, 60);
        close(
            state.prepare_sample(1, ms(1000), VIEWPORT).unwrap().styles[0]
                .opacity
                .unwrap(),
            0.6,
        );
        assert!(!state.request_sample(1, ms(1000)).unwrap());
        let removed = bound(&state, &[], 1000);
        publish(&mut state, removed, 1000);
        assert!(state.entries.is_empty());
    }

    #[test]
    fn baseline_coverage_and_binding_are_atomic_and_an_invalid_reply_can_be_corrected() {
        let state = PlaybackState::default();
        let inputs = [
            descriptor(1, payload("opacity", 1.0, 100), true),
            descriptor(2, payload("translateX", 20.0, 100), true),
        ];
        let mut prepared = state.prepare_bindings(1, &inputs, ms(0), VIEWPORT).unwrap();
        assert!(state.validate(&prepared).is_err());
        let observations = baselines(&prepared, 0.2);
        let initial = prepared.styles.clone();
        assert!(prepared.bind_baselines(&observations[..1]).is_err());
        assert_eq!(prepared.styles, initial);
        let mut invalid = observations.clone();
        invalid[1].font_size = f64::INFINITY;
        assert!(prepared.bind_baselines(&invalid).is_err());
        assert_eq!(prepared.styles, initial);
        let mut duplicate = observations.clone();
        duplicate[1].occurrence_id = duplicate[0].occurrence_id.clone();
        assert!(prepared.bind_baselines(&duplicate).is_err());
        let mut reversed = observations.clone();
        reversed.reverse();
        prepared.bind_baselines(&reversed).unwrap();
        state.validate(&prepared).unwrap();
        assert!(prepared.bind_baselines(&observations).is_err());
        assert!(state.entries.is_empty());
        assert_eq!(state.sample_demand_revision(), None);
    }

    #[test]
    fn malformed_program_or_matrix_preserves_the_accepted_owner() {
        let mut state = PlaybackState::default();
        let first = bound(
            &state,
            &[descriptor(1, payload("opacity", 1.0, 100), true)],
            0,
        );
        publish(&mut state, first, 0);
        let before = state.prepare_sample(1, ms(25), VIEWPORT).unwrap().styles;
        assert!(state
            .prepare_bindings(
                1,
                &[descriptor(1, payload("rotateX", 90.0, 100), true)],
                ms(25),
                VIEWPORT
            )
            .is_err());
        let mut candidate = state
            .prepare_bindings(
                1,
                &[descriptor(1, payload("translateX", 30.0, 100), true)],
                ms(25),
                VIEWPORT,
            )
            .unwrap();
        let mut observations = baselines(&candidate, 0.2);
        observations[0].transform.as_mut().unwrap().a = f64::NAN;
        assert!(candidate.bind_baselines(&observations).is_err());
        assert_eq!(
            state.prepare_sample(1, ms(25), VIEWPORT).unwrap().styles,
            before
        );
        assert_eq!(state.sample_revision, 1);
    }

    #[test]
    fn sample_revision_reservations_allow_failed_attempts_but_only_one_acceptance() {
        let mut state = PlaybackState::default();
        let input = descriptor(1, payload("opacity", 1.0, 100), true);
        let failed = bound(&state, std::slice::from_ref(&input), 0);
        let first = bound(&state, &[input], 0);
        assert_eq!(failed.consumed_sample, first.consumed_sample);
        publish(&mut state, first, 0);
        assert!(state.validate(&failed).is_err());
        let second = state.prepare_sample(1, ms(25), VIEWPORT).unwrap();
        assert_eq!(second.consumed_sample.unwrap().sample_revision, 2);
        let stale = second.clone();
        publish(&mut state, second, 25);
        assert!(state.validate(&stale).is_err());
    }

    #[test]
    fn poll_cadence_includes_an_exact_final_endpoint_and_has_no_post_completion_loop() {
        let mut state = PlaybackState::default();
        let first = bound(
            &state,
            &[descriptor(1, payload("opacity", 1.0, 35), true)],
            0,
        );
        publish(&mut state, first, 100);
        assert!(!state.request_sample(1, ms(115)).unwrap());
        assert!(state.request_sample(1, ms(116)).unwrap());
        assert_eq!(state.sample_demand_revision(), Some(1));
        assert!(!state.request_sample(1, ms(131)).unwrap());
        assert!(state.request_sample(1, ms(132)).unwrap());
        assert!(state.request_sample(1, ms(135)).unwrap());
        assert_eq!(state.sample_demand_revision(), Some(3));
        assert!(!state.request_sample(1, ms(136)).unwrap());
        let final_sample = state.prepare_sample(1, ms(140), VIEWPORT).unwrap();
        close(final_sample.styles[0].opacity.unwrap(), 1.0);
        publish(&mut state, final_sample, 145);
        assert!(!state.request_sample(1, ms(1000)).unwrap());
    }

    #[test]
    fn accepting_an_old_sample_keeps_newer_poll_demand_and_progress() {
        let mut state = PlaybackState::default();
        let first = bound(
            &state,
            &[descriptor(1, payload("opacity", 1.0, 100), true)],
            0,
        );
        publish(&mut state, first, 0);
        assert!(state.request_sample(1, ms(16)).unwrap());
        let old = state.prepare_sample(1, ms(16), VIEWPORT).unwrap();
        assert!(state.request_sample(1, ms(32)).unwrap());
        assert_eq!(old.consumed_sample.unwrap().demand_revision, 1);
        publish(&mut state, old, 40);
        assert_eq!(state.sample_demand_revision(), Some(2));
        assert!(!state.request_sample(1, ms(33)).unwrap());
        let newest = state.prepare_sample(1, ms(40), VIEWPORT).unwrap();
        assert_eq!(
            newest.consumed_sample.unwrap(),
            ConsumedSample {
                demand_revision: 2,
                sample_revision: 3
            }
        );
        close(newest.styles[0].opacity.unwrap(), 0.52);
    }

    #[test]
    fn hide_and_resume_pause_time_and_fence_every_prepared_candidate() {
        let mut state = PlaybackState::default();
        let first = bound(
            &state,
            &[descriptor(1, payload("opacity", 1.0, 100), true)],
            0,
        );
        publish(&mut state, first, 0);
        let stale = state.prepare_sample(1, ms(20), VIEWPORT).unwrap();
        state.set_visibility(1, false, ms(25)).unwrap();
        assert!(state.validate(&stale).is_err());
        assert!(!state.request_sample(1, ms(1000)).unwrap());
        assert!(state.prepare_sample(1, ms(1000), VIEWPORT).is_err());
        state.set_visibility(1, true, ms(1000)).unwrap();
        close(
            state.prepare_sample(1, ms(1025), VIEWPORT).unwrap().styles[0]
                .opacity
                .unwrap(),
            0.6,
        );
    }

    #[test]
    fn scope_and_page_retirement_remove_only_owned_runs_and_fence_stale_candidates() {
        let mut state = PlaybackState::default();
        let page = descriptor(1, payload("opacity", 1.0, 100), true);
        let mut scoped = descriptor(2, payload("opacity", 1.0, 100), true);
        scoped.key.owner.scope_id = Some("component-a".into());
        scoped.key.owner.scope_incarnation = Some(1);
        let first = bound(&state, &[page.clone(), scoped], 0);
        publish(&mut state, first, 0);
        let stale = state.prepare_sample(1, ms(20), VIEWPORT).unwrap();
        state.retire_scopes(1, &BTreeSet::from(["component-a".into()]));
        assert!(state.validate(&stale).is_err());
        assert_eq!(state.entries.len(), 1);
        assert!(state.entries.contains_key(&page.key));
        state.retire_page(1);
        assert!(state.entries.is_empty());
        assert!(state.requested_progress.is_empty());
    }

    #[test]
    fn topology_retirement_keeps_the_page_paused() {
        let mut state = PlaybackState::default();
        let input = descriptor(1, payload("opacity", 1.0, 100), true);
        let first = bound(&state, std::slice::from_ref(&input), 0);
        publish(&mut state, first, 0);
        state.set_visibility(1, false, ms(25)).unwrap();
        state.retire_page_topology(1);
        assert!(state.entries.is_empty());
        assert!(state.requested_progress.is_empty());
        assert!(!state.request_sample(1, ms(50)).unwrap());
        assert!(state
            .prepare_bindings(1, std::slice::from_ref(&input), ms(50), VIEWPORT)
            .is_err());
        state.set_visibility(1, true, ms(50)).unwrap();
        assert!(state
            .prepare_bindings(1, &[input], ms(50), VIEWPORT)
            .is_ok());
    }

    #[test]
    fn finite_endpoints_with_an_overflowing_intermediate_sample_reject_atomically() {
        let mut state = PlaybackState::default();
        let input = descriptor(1, payload("rotate", 90.0, 100), true);
        let mut first = state
            .prepare_bindings(1, &[input], ms(0), VIEWPORT)
            .unwrap();
        let mut observed = baselines(&first, 0.2);
        observed[0].transform = Some(Matrix {
            a: 3.0e38,
            b: 0.0,
            c: 3.0e38,
            d: 3.0e38,
            tx: 0.0,
            ty: 0.0,
        });
        first.bind_baselines(&observed).unwrap();
        publish(&mut state, first, 0);
        let original = state
            .entries
            .values()
            .next()
            .unwrap()
            .timeline
            .clone()
            .unwrap();
        assert!(state.prepare_sample(1, ms(50), VIEWPORT).is_err());
        assert_eq!(state.sample_revision, 1);
        assert!(Arc::ptr_eq(
            &original,
            state
                .entries
                .values()
                .next()
                .unwrap()
                .timeline
                .as_ref()
                .unwrap()
        ));
        assert!(state.prepare_sample(1, ms(100), VIEWPORT).is_ok());
    }

    #[test]
    fn active_budget_is_shared_across_pages_and_rejection_preserves_existing_runs() {
        let mut state = PlaybackState::default();
        let inputs = (1..=MAX_RUNS as u64)
            .map(|index| descriptor(index, json!({"actions":[]}), true))
            .collect::<Vec<_>>();
        let first = bound(&state, &inputs, 0);
        publish(&mut state, first, 0);
        let mut another = descriptor(1, json!({"actions":[]}), true);
        another.key.owner.page_id = 2;
        assert!(state
            .prepare_bindings(2, &[another], ms(0), VIEWPORT)
            .is_err());
        assert_eq!(state.entries.len(), MAX_RUNS);
        let too_many = (1..=MAX_RUNS as u64 + 1)
            .map(|index| descriptor(index, json!({"actions":[]}), true))
            .collect::<Vec<_>>();
        assert!(state
            .prepare_bindings(1, &too_many, ms(0), VIEWPORT)
            .is_err());
        assert_eq!(state.entries.len(), MAX_RUNS);
    }

    #[test]
    fn all_revision_exhaustion_paths_reject_without_saturation_or_resurrection() {
        let mut state = PlaybackState::default();
        let first = bound(
            &state,
            &[descriptor(1, payload("opacity", 1.0, 100), true)],
            0,
        );
        publish(&mut state, first, 0);
        state.sample_revision = u64::MAX;
        assert!(state.prepare_sample(1, ms(16), VIEWPORT).is_err());
        assert_eq!(state.sample_revision, u64::MAX);
        state.demand_revision = Some(u64::MAX);
        assert!(state.request_sample(1, ms(16)).is_err());
        assert!(state.requested_progress.values().all(Duration::is_zero));
        state.generation = Some(u64::MAX);
        state.retire_all();
        assert_eq!(state.generation, None);
        state.retire_all();
        assert_eq!(state.generation, None);
        assert!(state.prepare_bindings(1, &[], ms(20), VIEWPORT).is_err());
        assert!(state.request_sample(1, ms(20)).is_err());
    }
}
