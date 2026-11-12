//! Exact, bounded finals for the negotiated browser transaction protocol.
//!
//! One cache belongs to one native session/presenter owner. Reserve before the
//! outer engine turn (including storage synchronization) can execute JavaScript.
//! Only `seal_complete_turn` after that turn and its failure-effect drain may
//! publish a replayable final. Dropping a reservation leaves a pending tombstone;
//! an interrupted or ambiguous operation never becomes executable again.
//!
//! There is no soft eviction. The caller must extract the epoch from the
//! runtime-issued wire binding and check it against the native input lifetime;
//! it must never relabel an old request with the current epoch. Only an actual
//! hard lifetime advance may call `retire_epoch`. A retired epoch stays rejected,
//! even if an old final or request arrives after its entries have been released.
use container_bridge::{BridgeBatch, BridgeEnvelope, BridgeError, BridgeErrorCode, EnvelopeKind};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{self, Write};
use std::sync::Arc;

const MAX_FINGERPRINT_DEPTH: usize = 64;
const MAX_FINGERPRINT_NODES: usize = 100_000;
const MAX_LANE_BYTES: usize = 128;

/// Echoed by the owner only after it has accepted the complete sealed final.
/// Tokens identify immutable finals; they do not grant application authority.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ConsumptionReceipt {
    pub sequence: String,
    pub token: String,
}

struct ConsumptionLane {
    id: String,
    retired_through: u64,
}

/// Budgets charge retained canonical request bytes, final bytes (or their
/// reserved capacity), and the session ID. Entry count also bounds map metadata.
/// They describe protocol retention, not an exact allocator/RSS measurement.
#[derive(Clone, Copy, Debug)]
pub(super) struct BrowserTransactionFinalLimits {
    pub max_entries: usize,
    pub max_bytes: usize,
    pub max_request_bytes: usize,
    pub max_reserved_final_bytes: usize,
}

impl Default for BrowserTransactionFinalLimits {
    fn default() -> Self {
        Self {
            max_entries: 32,
            max_bytes: 8 * 1024 * 1024,
            max_request_bytes: 256 * 1024,
            max_reserved_final_bytes: 512 * 1024,
        }
    }
}

/// Only the first admission can receive this capability. It cannot be cloned
/// or manufactured by another cache, even with the same session and epoch.
#[derive(Debug)]
#[must_use = "reserve before executing, then seal the complete outer-turn final"]
pub(super) struct BrowserTransactionReservation {
    owner: Arc<()>,
    epoch: u64,
    sequence: u64,
    request_id: String,
}

#[derive(Debug)]
pub(super) enum BrowserTransactionAdmission {
    Execute(BrowserTransactionReservation),
    Replay(BridgeBatch),
    /// Already reserved. No JavaScript may execute for this admission, whether
    /// the original call is running, cancelled, or has an unknown outcome.
    Pending,
}

enum FinalState {
    Pending,
    Complete(Box<[u8]>),
    Indeterminate,
}

struct Entry {
    operation: String,
    fingerprint: Box<[u8]>,
    sequence: u64,
    reserved_final_bytes: usize,
    retained_bytes: usize,
    consumption_receipt: Option<String>,
    state: FinalState,
}

pub(super) struct BrowserTransactionFinals {
    owner: Arc<()>,
    session_id: String,
    epoch: Option<u64>,
    sequence: u64,
    consumption: Option<ConsumptionLane>,
    limits: BrowserTransactionFinalLimits,
    used_bytes: usize,
    entries: BTreeMap<String, Entry>,
}

impl BrowserTransactionFinals {
    pub fn new(
        session_id: impl Into<String>,
        epoch: u64,
        limits: BrowserTransactionFinalLimits,
    ) -> Result<Self, BridgeError> {
        let session_id = session_id.into();
        if session_id.trim().is_empty()
            || limits.max_entries == 0
            || limits.max_bytes == 0
            || limits.max_request_bytes == 0
            || limits.max_reserved_final_bytes == 0
            || limits.max_request_bytes > limits.max_bytes
            || limits.max_reserved_final_bytes > limits.max_bytes
            || session_id.len() > limits.max_bytes
        {
            return Err(BridgeError::invalid(
                "invalid finite browser transaction retention budgets or session",
            ));
        }
        Ok(Self {
            owner: Arc::new(()),
            used_bytes: session_id.len(),
            session_id,
            epoch: Some(epoch),
            sequence: 0,
            consumption: None,
            limits,
            entries: BTreeMap::new(),
        })
    }

    /// Explicit v2.1 owner lane. The legacy constructor retains v2.0's fixed
    /// retention behavior and never accepts a consumption request.
    pub fn new_consumable(
        session_id: impl Into<String>,
        epoch: u64,
        limits: BrowserTransactionFinalLimits,
        lane_id: String,
    ) -> Result<Self, BridgeError> {
        if lane_id.is_empty()
            || lane_id.len() > MAX_LANE_BYTES
            || !lane_id
                .bytes()
                .all(|byte| byte.is_ascii_graphic() && byte != b':')
        {
            return Err(BridgeError::invalid(
                "invalid browser transaction owner lane",
            ));
        }
        let mut cache = Self::new(session_id, epoch, limits)?;
        if lane_id.len() > cache.limits.max_bytes.saturating_sub(cache.used_bytes) {
            return Err(retention_full());
        }
        cache.used_bytes += lane_id.len();
        cache.consumption = Some(ConsumptionLane {
            id: lane_id,
            retired_through: 0,
        });
        Ok(cache)
    }

    pub fn lane_id(&self) -> Option<&str> {
        self.consumption.as_ref().map(|lane| lane.id.as_str())
    }

    pub(super) fn retention(&self) -> (usize, usize, Option<(u64, u64)>) {
        (
            self.entries.len(),
            self.used_bytes,
            self.consumption
                .as_ref()
                .map(|lane| (lane.retired_through, self.sequence)),
        )
    }

    /// A byte reservation is mandatory before execution. Even a cache with
    /// enough entry slots may reject admission because other unsettled turns
    /// still own their final capacity. Refusal performs no partial insertion.
    pub fn reserve(
        &mut self,
        epoch: u64,
        request: &BridgeEnvelope,
        reserved_final_bytes: usize,
    ) -> Result<BrowserTransactionAdmission, BridgeError> {
        self.check_epoch(epoch)?;
        request.validate()?;
        if request.kind != EnvelopeKind::Request || request.session_id != self.session_id {
            return Err(BridgeError::invalid(
                "browser transaction request does not identify this session owner",
            ));
        }
        let wire_sequence = if let Some(lane) = &self.consumption {
            if request.payload.get("version").and_then(Value::as_str) != Some("2.1") {
                return Err(BridgeError::protocol(
                    "consumable browser transactions require live protocol 2.1",
                ));
            }
            // Read the tiny binding without copying any application payload
            // before the bounded canonical fingerprint pass.
            let binding = request
                .payload
                .get("transaction")
                .and_then(Value::as_object)
                .filter(|binding| binding.len() == 2)
                .ok_or_else(|| BridgeError::invalid("invalid browser transaction owner binding"))?;
            let binding_lane = binding
                .get("laneId")
                .and_then(Value::as_str)
                .ok_or_else(|| BridgeError::invalid("invalid browser transaction owner lane"))?;
            let binding_sequence =
                binding
                    .get("sequence")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        BridgeError::invalid("invalid browser transaction owner sequence")
                    })?;
            let sequence = decimal(binding_sequence)?;
            if binding_lane != lane.id
                || request.request_id != canonical_request_id(&lane.id, sequence)
            {
                return Err(BridgeError::invalid(
                    "browser transaction requestId does not identify its owner lane and sequence",
                ));
            }
            if sequence <= lane.retired_through {
                return Err(BridgeError::new(
                    BridgeErrorCode::Cancelled,
                    "browser transaction sequence has been permanently consumed",
                ));
            }
            Some(sequence)
        } else {
            None
        };
        let fingerprint = fingerprint(request, self.limits.max_request_bytes)?;
        if let Some(entry) = self.entries.get(&request.request_id) {
            if entry.operation != request.op || entry.fingerprint != fingerprint {
                return Err(BridgeError::invalid(
                    "browser transaction requestId was reused with a different envelope",
                ));
            }
            return match &entry.state {
                FinalState::Pending => Ok(BrowserTransactionAdmission::Pending),
                FinalState::Indeterminate => Err(indeterminate()),
                FinalState::Complete(bytes) => serde_json::from_slice(bytes)
                    .map(BrowserTransactionAdmission::Replay)
                    .map_err(|_| {
                        BridgeError::new(
                            BridgeErrorCode::Engine,
                            "sealed browser transaction final could not be replayed",
                        )
                    }),
            };
        }
        let sequence = self.sequence.checked_add(1).ok_or_else(|| {
            BridgeError::new(
                BridgeErrorCode::Render,
                "browser transaction reservation sequence exhausted; replace the owner",
            )
        })?;
        if wire_sequence.is_some_and(|wire| wire != sequence) {
            return Err(BridgeError::invalid(
                "browser transaction sequence must be the next unadmitted sequence",
            ));
        }
        if reserved_final_bytes == 0 || reserved_final_bytes > self.limits.max_reserved_final_bytes
        {
            return Err(BridgeError::invalid(
                "browser transaction needs a bounded nonzero final reservation",
            ));
        }
        let request_bytes = request
            .request_id
            .len()
            .checked_add(request.op.len())
            .and_then(|bytes| bytes.checked_add(fingerprint.len()))
            .ok_or_else(retention_full)?;
        let charge = request_bytes
            .checked_add(reserved_final_bytes)
            .ok_or_else(retention_full)?;
        if self.entries.len() >= self.limits.max_entries
            || charge > self.limits.max_bytes.saturating_sub(self.used_bytes)
        {
            return Err(retention_full());
        }
        self.sequence = sequence;
        self.used_bytes += charge;
        self.entries.insert(
            request.request_id.clone(),
            Entry {
                operation: request.op.clone(),
                fingerprint,
                sequence,
                reserved_final_bytes,
                retained_bytes: charge,
                consumption_receipt: None,
                state: FinalState::Pending,
            },
        );
        Ok(BrowserTransactionAdmission::Execute(
            BrowserTransactionReservation {
                owner: Arc::clone(&self.owner),
                epoch,
                sequence,
                request_id: request.request_id.clone(),
            },
        ))
    }

    /// Call only on the complete result returned by the OUTERMOST engine turn.
    /// Include success/error responses, consumed receipts, effects and retirement
    /// diagnostics. An inner handler result is not final and must not be sealed.
    ///
    /// Invalid, queued or oversized results consume the reservation into an
    /// indeterminate tombstone and return an explicit error. No retry can rerun
    /// the original JavaScript. The caller must preserve any already committed
    /// effects when reporting this error; a retention failure is not rollback.
    pub fn seal_complete_turn(
        &mut self,
        reservation: BrowserTransactionReservation,
        batch: &mut BridgeBatch,
    ) -> Result<(), BridgeError> {
        let entry = self.reserved_entry(&reservation)?;
        let reserved = entry.reserved_final_bytes;
        let mut receipt_index = None;
        let result = (|| {
            if self.consumption.is_none() {
                return encode_final(
                    batch,
                    &self.session_id,
                    &reservation.request_id,
                    &entry.operation,
                    reserved,
                )
                .map(|bytes| (bytes, None));
            }
            let index = validate_final(
                batch,
                &self.session_id,
                &reservation.request_id,
                &entry.operation,
            )?;
            if batch.messages[index]
                .payload
                .as_object_mut()
                .expect("validated final object")
                .remove("consumptionReceipt")
                .is_some()
            {
                return Err(BridgeError::invalid(
                    "browser transaction consumption receipt is reserved for the native owner",
                ));
            }
            let original = encode_final(
                batch,
                &self.session_id,
                &reservation.request_id,
                &entry.operation,
                reserved,
            )?;
            // The opaque token binds the complete original final, including
            // the session, canonical request ID, effects and diagnostics. JS
            // only echoes it; it never reconstructs Rust's JSON encoding.
            let token = container_ir::hex_digest(&original);
            drop(original);
            // The separate retained token is charged as well as its copy in
            // the sealed final, within the pre-execution final reservation.
            let final_limit = reserved
                .checked_sub(token.len())
                .ok_or_else(retention_full)?;
            batch.messages[index].payload["consumptionReceipt"] = Value::String(token.clone());
            receipt_index = Some(index);
            encode_final(
                batch,
                &self.session_id,
                &reservation.request_id,
                &entry.operation,
                final_limit,
            )
            .map(|bytes| (bytes, Some(token)))
        })();
        let entry = self
            .entries
            .get_mut(&reservation.request_id)
            .expect("validated reservation retains its entry");
        self.used_bytes -= reserved;
        entry.retained_bytes -= reserved;
        entry.reserved_final_bytes = 0;
        match result {
            Ok((bytes, token)) => {
                let retained = bytes.len() + token.as_ref().map_or(0, String::len);
                self.used_bytes += retained;
                entry.retained_bytes += retained;
                entry.consumption_receipt = token;
                entry.state = FinalState::Complete(bytes);
                Ok(())
            }
            Err(error) => {
                if let Some(index) = receipt_index {
                    batch.messages[index]
                        .payload
                        .as_object_mut()
                        .expect("injected final object")
                        .remove("consumptionReceipt");
                }
                entry.state = FinalState::Indeterminate;
                Err(error)
            }
        }
    }

    /// Use when execution may have entered JavaScript but no complete outer
    /// final exists. This releases reserved output space, never request identity.
    pub fn mark_indeterminate(
        &mut self,
        reservation: BrowserTransactionReservation,
    ) -> Result<(), BridgeError> {
        self.reserved_entry(&reservation)?;
        let entry = self
            .entries
            .get_mut(&reservation.request_id)
            .expect("validated reservation retains its entry");
        self.used_bytes -= entry.reserved_final_bytes;
        entry.retained_bytes -= entry.reserved_final_bytes;
        entry.reserved_final_bytes = 0;
        entry.state = FinalState::Indeterminate;
        Ok(())
    }

    /// Pure owner-thread metadata: verify the entire continuous Complete
    /// prefix before releasing any byte. Pending/unknown outcomes never
    /// become executable or consumable through a metadata acknowledgement.
    pub fn consume(
        &mut self,
        epoch: u64,
        lane_id: &str,
        through: &str,
        receipts: &[ConsumptionReceipt],
    ) -> Result<(), BridgeError> {
        self.check_epoch(epoch)?;
        let lane = self.consumption.as_ref().ok_or_else(|| {
            BridgeError::protocol("browser transaction consumption was not negotiated")
        })?;
        if lane_id != lane.id {
            return Err(BridgeError::invalid(
                "browser transaction consumption owner lane mismatch",
            ));
        }
        let through = decimal(through)?;
        if receipts.len() > self.limits.max_entries {
            return Err(BridgeError::invalid(
                "browser transaction consumption receipt budget exceeded",
            ));
        }
        let mut previous = None;
        for receipt in receipts {
            let sequence = decimal(&receipt.sequence)?;
            if sequence == 0
                || sequence > through
                || previous.is_some_and(|last: u64| last.checked_add(1) != Some(sequence))
                || receipt.token.len() != 64
                || !receipt
                    .token
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(BridgeError::invalid(
                    "invalid browser transaction consumption receipt",
                ));
            }
            previous = Some(sequence);
        }
        if previous.is_some_and(|last| last != through) {
            return Err(BridgeError::invalid(
                "browser transaction consumption receipts do not end at through",
            ));
        }
        let mut budget = BudgetWriter::new(self.limits.max_request_bytes);
        write_json(&mut budget, &(lane_id, through, receipts))?;
        if through <= lane.retired_through {
            // Lost metadata replies are recoverable without retaining another
            // acknowledgement. Old receipts cannot release a newer prefix.
            return Ok(());
        }
        if through > self.sequence || through - lane.retired_through != receipts.len() as u64 {
            return Err(BridgeError::invalid(
                "browser transaction consumption must cover the complete retained prefix",
            ));
        }
        let first = lane
            .retired_through
            .checked_add(1)
            .ok_or_else(retention_full)?;
        let mut release_bytes = 0usize;
        for (index, receipt) in receipts.iter().enumerate() {
            let sequence = first.checked_add(index as u64).ok_or_else(retention_full)?;
            if receipt.sequence != sequence.to_string() {
                return Err(BridgeError::invalid(
                    "browser transaction consumption prefix contains a hole",
                ));
            }
            let request_id = canonical_request_id(lane_id, sequence);
            let entry = self.entries.get(&request_id).filter(|entry| {
                entry.sequence == sequence && matches!(entry.state, FinalState::Complete(_))
                    && entry.consumption_receipt.as_deref() == Some(receipt.token.as_str())
            }).ok_or_else(|| BridgeError::invalid("browser transaction consumption requires the exact sealed Complete receipt"))?;
            release_bytes = release_bytes
                .checked_add(entry.retained_bytes)
                .ok_or_else(retention_full)?;
        }
        // No fallible operations after the complete prefix and charges have
        // been checked. The monotonically retired identity survives deletion.
        self.used_bytes -= release_bytes;
        for receipt in receipts {
            self.entries.remove(&canonical_request_id(
                lane_id,
                decimal(&receipt.sequence).expect("validated sequence"),
            ));
        }
        self.consumption
            .as_mut()
            .expect("validated consumable lane")
            .retired_through = through;
        Ok(())
    }

    /// Only the owner may install a strictly newer native input-lifetime epoch.
    /// Future epochs on requests never advance this watermark implicitly.
    pub fn retire_epoch(&mut self, next: u64) -> Result<(), BridgeError> {
        if self.epoch.is_none_or(|current| next <= current) {
            return Err(BridgeError::invalid(
                "browser transaction epoch must strictly advance within a live owner",
            ));
        }
        self.epoch = Some(next);
        self.entries.clear();
        if let Some(lane) = &mut self.consumption {
            lane.retired_through = self.sequence;
        }
        self.used_bytes = self.base_bytes();
        Ok(())
    }

    /// Owner shutdown or native input-lifetime overflow is terminal. A new
    /// session/presenter must own a new cache; this instance cannot be revived.
    pub fn retire(&mut self) {
        self.epoch = None;
        self.entries.clear();
        if let Some(lane) = &mut self.consumption {
            lane.retired_through = self.sequence;
        }
        self.used_bytes = self.base_bytes();
    }

    fn base_bytes(&self) -> usize {
        self.session_id.len() + self.consumption.as_ref().map_or(0, |lane| lane.id.len())
    }

    fn check_epoch(&self, epoch: u64) -> Result<(), BridgeError> {
        if self.epoch != Some(epoch) {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "browser transaction belongs to an uninstalled or retired native epoch",
            ));
        }
        Ok(())
    }

    fn reserved_entry(
        &self,
        reservation: &BrowserTransactionReservation,
    ) -> Result<&Entry, BridgeError> {
        if !Arc::ptr_eq(&self.owner, &reservation.owner) {
            return Err(BridgeError::invalid(
                "browser transaction reservation belongs to another cache owner",
            ));
        }
        self.check_epoch(reservation.epoch)?;
        self.entries
            .get(&reservation.request_id)
            .filter(|entry| {
                entry.sequence == reservation.sequence && matches!(entry.state, FinalState::Pending)
            })
            .ok_or_else(|| {
                BridgeError::invalid("browser transaction reservation is no longer pending")
            })
    }
}

fn decimal(value: &str) -> Result<u64, BridgeError> {
    if value.is_empty() || value.len() > 20 {
        return Err(BridgeError::invalid(
            "browser transaction sequence must be canonical u64",
        ));
    }
    let number = value
        .parse::<u64>()
        .map_err(|_| BridgeError::invalid("browser transaction sequence must be canonical u64"))?;
    if number.to_string() != value {
        return Err(BridgeError::invalid(
            "browser transaction sequence must be canonical u64",
        ));
    }
    Ok(number)
}

fn canonical_request_id(lane_id: &str, sequence: u64) -> String {
    format!("live:{lane_id}:{sequence}")
}

fn retention_full() -> BridgeError {
    BridgeError::new(
        BridgeErrorCode::Render,
        "browser transaction retention budget exhausted; request was not executed",
    )
}

fn indeterminate() -> BridgeError {
    BridgeError::new(
        BridgeErrorCode::Render,
        "browser transaction outcome is indeterminate; request cannot execute again",
    )
}

struct BudgetWriter {
    bytes: Vec<u8>,
    limit: usize,
}

impl BudgetWriter {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
        }
    }

    fn finish(self) -> Box<[u8]> {
        self.bytes.into_boxed_slice()
    }
}

impl Write for BudgetWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(io::Error::other("browser transaction byte budget exceeded"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn write_json(writer: &mut BudgetWriter, value: &impl Serialize) -> Result<(), BridgeError> {
    serde_json::to_writer(writer, value).map_err(|_| retention_full())
}

/// The fingerprint retains exact canonical bytes instead of a collision-prone
/// non-cryptographic hash: a typed envelope header followed by recursively
/// sorted JSON payload. Transport deadlines/cancellation/trace are part of the
/// request, so changing them while reusing the ID is a conflict as well.
/// Check caller-controlled metadata before any typed payload clone. The same
/// bounded writer/depth/node limits used for business identities apply here.
pub(super) fn validate_metadata_request(
    request: &BridgeEnvelope,
    limit: usize,
) -> Result<(), BridgeError> {
    fingerprint(request, limit).map(|_| ())
}

fn fingerprint(request: &BridgeEnvelope, limit: usize) -> Result<Box<[u8]>, BridgeError> {
    let metadata_bytes = request
        .request_id
        .len()
        .checked_add(request.op.len())
        .filter(|bytes| *bytes < limit)
        .ok_or_else(retention_full)?;
    let mut writer = BudgetWriter::new(limit - metadata_bytes);
    write_json(
        &mut writer,
        &(
            &request.protocol_version,
            &request.session_id,
            &request.request_id,
            request.kind,
            &request.op,
            &request.cancel_token,
            request.deadline_ns,
            &request.trace_id,
        ),
    )?;
    writer.write_all(b"\n").map_err(|_| retention_full())?;
    canonical_value(&mut writer, &request.payload, 0, &mut 0)?;
    Ok(writer.finish())
}

fn canonical_value(
    writer: &mut BudgetWriter,
    value: &Value,
    depth: usize,
    nodes: &mut usize,
) -> Result<(), BridgeError> {
    *nodes += 1;
    if depth > MAX_FINGERPRINT_DEPTH || *nodes > MAX_FINGERPRINT_NODES {
        return Err(BridgeError::invalid(
            "browser transaction fingerprint exceeds its depth or node budget",
        ));
    }
    match value {
        Value::Array(values) => {
            writer.write_all(b"[").map_err(|_| retention_full())?;
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    writer.write_all(b",").map_err(|_| retention_full())?;
                }
                canonical_value(writer, value, depth + 1, nodes)?;
            }
            writer.write_all(b"]").map_err(|_| retention_full())?;
        }
        Value::Object(values) => {
            // Check before allocating the sorted reference table. This also
            // stays canonical if serde_json's preserve_order feature is enabled.
            if values.len() > MAX_FINGERPRINT_NODES.saturating_sub(*nodes) {
                return Err(BridgeError::invalid(
                    "browser transaction fingerprint exceeds its node budget",
                ));
            }
            let mut fields = values.iter().collect::<Vec<_>>();
            fields.sort_unstable_by_key(|(key, _)| *key);
            writer.write_all(b"{").map_err(|_| retention_full())?;
            for (index, (key, value)) in fields.into_iter().enumerate() {
                if index > 0 {
                    writer.write_all(b",").map_err(|_| retention_full())?;
                }
                write_json(writer, key)?;
                writer.write_all(b":").map_err(|_| retention_full())?;
                canonical_value(writer, value, depth + 1, nodes)?;
            }
            writer.write_all(b"}").map_err(|_| retention_full())?;
        }
        scalar => write_json(writer, scalar)?,
    }
    Ok(())
}

pub(super) fn encode_final(
    batch: &BridgeBatch,
    session_id: &str,
    request_id: &str,
    operation: &str,
    limit: usize,
) -> Result<Box<[u8]>, BridgeError> {
    validate_final(batch, session_id, request_id, operation)?;
    let mut writer = BudgetWriter::new(limit);
    serde_json::to_writer(&mut writer, batch).map_err(|_| {
        BridgeError::new(
            BridgeErrorCode::Render,
            "browser transaction final exceeds its reserved bytes; outcome is indeterminate and cannot execute again",
        )
    })?;
    let bytes = writer.finish();
    // Admit only a representation that can actually be replayed. Parsing here
    // also applies serde_json's recursion bound to complete retained batches.
    serde_json::from_slice::<BridgeBatch>(&bytes).map_err(|_| {
        BridgeError::invalid("browser transaction final exceeds its replay structure budget")
    })?;
    Ok(bytes)
}

fn validate_final(
    batch: &BridgeBatch,
    session_id: &str,
    request_id: &str,
    operation: &str,
) -> Result<usize, BridgeError> {
    let mut finals = 0;
    let mut final_index = 0;
    for (index, message) in batch.messages.iter().enumerate() {
        if message.session_id != session_id
            || !matches!(message.kind, EnvelopeKind::Response | EnvelopeKind::Event)
        {
            return Err(BridgeError::invalid(
                "complete browser transaction batch crossed its session or response boundary",
            ));
        }
        if message.kind == EnvelopeKind::Response
            && message.request_id == request_id
            && message.op == operation
        {
            finals += 1;
            final_index = index;
            if !matches!(message.payload.get("ok"), Some(Value::Bool(_)))
                || message.payload.get("queued") == Some(&Value::Bool(true))
            {
                return Err(BridgeError::invalid(
                    "browser transaction cannot seal a queued or nonfinal response",
                ));
            }
        }
    }
    if finals != 1 {
        return Err(BridgeError::invalid(
            "complete browser transaction batch needs exactly one correlated final response",
        ));
    }
    Ok(final_index)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cache(limits: BrowserTransactionFinalLimits) -> BrowserTransactionFinals {
        BrowserTransactionFinals::new("session", 7, limits).unwrap()
    }

    fn request(id: &str) -> BridgeEnvelope {
        BridgeEnvelope::request(
            "session",
            id,
            "view.presented",
            json!({"version":"2.0","inputLifetimeRevision":"7","key":{"pageId":"1"}}),
        )
    }

    fn execute(
        cache: &mut BrowserTransactionFinals,
        request: &BridgeEnvelope,
        bytes: usize,
    ) -> BrowserTransactionReservation {
        match cache.reserve(7, request, bytes).unwrap() {
            BrowserTransactionAdmission::Execute(reservation) => reservation,
            other => panic!("unexpected admission: {other:?}"),
        }
    }

    fn final_batch(request: &BridgeEnvelope) -> BridgeBatch {
        let mut final_response = request.clone();
        final_response.kind = EnvelopeKind::Response;
        final_response.payload = json!({"ok":true,"inputEnabled":false});
        BridgeBatch::new(vec![final_response])
    }

    fn consumable(limits: BrowserTransactionFinalLimits) -> BrowserTransactionFinals {
        BrowserTransactionFinals::new_consumable("session", 7, limits, "lane".into()).unwrap()
    }

    fn consumable_request(sequence: u64) -> BridgeEnvelope {
        let mut request = request(&canonical_request_id("lane", sequence));
        request.payload["version"] = json!("2.1");
        request.payload["transaction"] = json!({"laneId":"lane","sequence":sequence.to_string()});
        request
    }

    fn seal_consumable(
        cache: &mut BrowserTransactionFinals,
        request: &BridgeEnvelope,
    ) -> (BridgeBatch, ConsumptionReceipt) {
        let reservation = execute(cache, request, 4096);
        let mut completed = final_batch(request);
        cache
            .seal_complete_turn(reservation, &mut completed)
            .unwrap();
        let receipt = ConsumptionReceipt {
            sequence: request.payload["transaction"]["sequence"]
                .as_str()
                .unwrap()
                .into(),
            token: completed.messages[0].payload["consumptionReceipt"]
                .as_str()
                .unwrap()
                .into(),
        };
        (completed, receipt)
    }

    #[test]
    fn only_complete_outer_turn_finals_replay_with_all_effects_and_diagnostics() {
        for failed in [false, true] {
            let mut cache = cache(BrowserTransactionFinalLimits::default());
            let request = request("ack-1");
            let reservation = execute(&mut cache, &request, 4096);
            assert!(matches!(
                cache.reserve(7, &request, 4096).unwrap(),
                BrowserTransactionAdmission::Pending
            ));
            let mut completed = final_batch(&request);
            completed.messages[0].payload["ok"] = json!(!failed);
            if failed {
                completed.messages[0].payload["error"] =
                    json!({"code":"ERR_TIMEOUT","message":"outer turn expired after writes"});
            }
            completed.messages.push(BridgeEnvelope::event(
                "session",
                "view.events.consumed",
                json!({"events":1,"dropped":2}),
            ));
            completed.messages.push(BridgeEnvelope::event(
                "session",
                "error",
                json!({"message":"retirement callback diagnostic"}),
            ));
            cache
                .seal_complete_turn(reservation, &mut completed)
                .unwrap();
            for _ in 0..3 {
                match cache.reserve(7, &request, 1).unwrap() {
                    BrowserTransactionAdmission::Replay(replayed) => {
                        assert_eq!(replayed, completed)
                    }
                    other => panic!("must replay without another execution: {other:?}"),
                }
            }
        }
    }

    #[test]
    fn canonical_objects_replay_but_payload_operation_and_transport_changes_conflict() {
        let mut cache = cache(BrowserTransactionFinalLimits::default());
        let mut request = request("ack-1");
        request.payload = serde_json::from_str(r#"{"z":[{"b":2,"a":1}],"a":"x\n"}"#).unwrap();
        let reservation = execute(&mut cache, &request, 4096);
        cache
            .seal_complete_turn(reservation, &mut final_batch(&request))
            .unwrap();
        let mut equivalent = request.clone();
        equivalent.payload = serde_json::from_str(r#"{"a":"x\n","z":[{"a":1,"b":2}]}"#).unwrap();
        assert!(matches!(
            cache.reserve(7, &equivalent, 4096).unwrap(),
            BrowserTransactionAdmission::Replay(_)
        ));
        for variant in 0..6 {
            let mut changed = request.clone();
            match variant {
                0 => changed.payload["a"] = json!("changed"),
                1 => changed.op = "view.edit.flush".into(),
                2 => changed.deadline_ns = Some(123),
                3 => changed.cancel_token = Some("new-cancellation".into()),
                4 => changed.trace_id = Some("different-trace".into()),
                5 => changed.protocol_version = "1.1".into(),
                _ => unreachable!(),
            }
            assert_eq!(
                cache.reserve(7, &changed, 4096).unwrap_err().code,
                BridgeErrorCode::InvalidRequest
            );
        }
    }

    #[test]
    fn abandoned_and_unknown_reservations_never_execute_again() {
        let mut cache = cache(BrowserTransactionFinalLimits::default());
        let pending = request("pending");
        drop(execute(&mut cache, &pending, 4096));
        for _ in 0..3 {
            assert!(matches!(
                cache.reserve(7, &pending, 4096).unwrap(),
                BrowserTransactionAdmission::Pending
            ));
        }
        let unknown = request("unknown");
        let reservation = execute(&mut cache, &unknown, 4096);
        let before = cache.used_bytes;
        cache.mark_indeterminate(reservation).unwrap();
        assert_eq!(cache.used_bytes, before - 4096);
        assert_eq!(cache.entries.len(), 2);
        let error = cache.reserve(7, &unknown, 4096).unwrap_err();
        assert_eq!(error.code, BridgeErrorCode::Render);
        assert!(error.message.contains("cannot execute again"));
        let mut conflicting = unknown.clone();
        conflicting.payload["version"] = json!("different");
        assert_eq!(
            cache.reserve(7, &conflicting, 4096).unwrap_err().code,
            BridgeErrorCode::InvalidRequest
        );
    }

    #[test]
    fn entry_saturation_never_evicts_a_final_or_reexecutes_a_completed_request() {
        let mut cache = cache(BrowserTransactionFinalLimits {
            max_entries: 1,
            ..Default::default()
        });
        let first = request("first");
        let reservation = execute(&mut cache, &first, 4096);
        cache
            .seal_complete_turn(reservation, &mut final_batch(&first))
            .unwrap();
        let retained = cache.used_bytes;
        for _ in 0..10 {
            assert_eq!(
                cache.reserve(7, &request("second"), 4096).unwrap_err().code,
                BridgeErrorCode::Render
            );
            assert!(matches!(
                cache.reserve(7, &first, 4096).unwrap(),
                BrowserTransactionAdmission::Replay(_)
            ));
            assert_eq!(cache.used_bytes, retained);
            assert_eq!(cache.entries.len(), 1);
        }
    }

    #[test]
    fn final_space_is_reserved_before_execution_and_only_unused_space_is_released() {
        let mut cache = cache(BrowserTransactionFinalLimits {
            max_entries: 4,
            max_bytes: 1400,
            max_request_bytes: 512,
            max_reserved_final_bytes: 1000,
        });
        let first = request("first");
        let reservation = execute(&mut cache, &first, 1000);
        let charged = cache.used_bytes;
        assert_eq!(cache.entries.len(), 1);
        assert_eq!(
            cache.reserve(7, &request("second"), 500).unwrap_err().code,
            BridgeErrorCode::Render
        );
        assert_eq!(cache.used_bytes, charged);
        assert_eq!(cache.entries.len(), 1);
        let mut batch = final_batch(&first);
        let final_bytes = serde_json::to_vec(&batch).unwrap().len();
        cache.seal_complete_turn(reservation, &mut batch).unwrap();
        assert_eq!(cache.used_bytes, charged - 1000 + final_bytes);
        assert!(matches!(
            cache.reserve(7, &request("second"), 500).unwrap(),
            BrowserTransactionAdmission::Execute(_)
        ));
        assert!(cache.used_bytes <= 1400);
        assert!(matches!(
            cache.reserve(7, &first, 1000).unwrap(),
            BrowserTransactionAdmission::Replay(_)
        ));
    }

    #[test]
    fn invalid_queued_foreign_and_oversized_finals_become_permanent_tombstones() {
        for variant in 0..5 {
            let mut cache = cache(BrowserTransactionFinalLimits::default());
            let request = request("ack-1");
            let reservation = execute(&mut cache, &request, if variant == 0 { 8 } else { 4096 });
            let mut batch = final_batch(&request);
            match variant {
                0 => {}
                1 => batch.messages[0].payload = json!({"ok":true,"queued":true}),
                2 => batch.messages.clear(),
                3 => batch.messages.push(batch.messages[0].clone()),
                4 => batch.messages[0].session_id = "foreign-session".into(),
                _ => unreachable!(),
            }
            assert!(cache.seal_complete_turn(reservation, &mut batch).is_err());
            assert_eq!(cache.entries.len(), 1);
            assert!(cache
                .reserve(7, &request, 4096)
                .unwrap_err()
                .message
                .contains("indeterminate"));
        }
    }

    #[test]
    fn epochs_cannot_be_inferred_from_requests_or_restored_after_retirement() {
        let mut cache = cache(BrowserTransactionFinalLimits::default());
        let old = request("ack-1");
        let reservation = execute(&mut cache, &old, 4096);
        for epoch in [6, 8, u64::MAX] {
            assert_eq!(
                cache.reserve(epoch, &old, 4096).unwrap_err().code,
                BridgeErrorCode::Cancelled
            );
        }
        assert!(cache.retire_epoch(7).is_err());
        assert!(cache.retire_epoch(6).is_err());
        cache.retire_epoch(8).unwrap();
        assert_eq!(cache.used_bytes, "session".len());
        assert!(cache.entries.is_empty());
        assert_eq!(
            cache
                .seal_complete_turn(reservation, &mut final_batch(&old))
                .unwrap_err()
                .code,
            BridgeErrorCode::Cancelled
        );
        assert_eq!(
            cache.reserve(7, &old, 4096).unwrap_err().code,
            BridgeErrorCode::Cancelled
        );
        let mut fresh = old;
        fresh.payload["inputLifetimeRevision"] = json!("8");
        assert!(matches!(
            cache.reserve(8, &fresh, 4096).unwrap(),
            BrowserTransactionAdmission::Execute(_)
        ));
        cache.retire();
        assert_eq!(
            cache.reserve(8, &fresh, 4096).unwrap_err().code,
            BridgeErrorCode::Cancelled
        );
        assert!(cache.retire_epoch(9).is_err());
    }

    #[test]
    fn reservations_and_finals_cannot_cross_cache_or_session_owners() {
        let mut first = cache(BrowserTransactionFinalLimits::default());
        let mut second = cache(BrowserTransactionFinalLimits::default());
        let request = request("ack-1");
        let reservation = execute(&mut first, &request, 4096);
        assert_eq!(
            second
                .seal_complete_turn(reservation, &mut final_batch(&request))
                .unwrap_err()
                .code,
            BridgeErrorCode::InvalidRequest
        );
        assert!(matches!(
            first.reserve(7, &request, 4096).unwrap(),
            BrowserTransactionAdmission::Pending
        ));
        let mut foreign = request;
        foreign.session_id = "different".into();
        assert_eq!(
            first.reserve(7, &foreign, 4096).unwrap_err().code,
            BridgeErrorCode::InvalidRequest
        );
        assert!(second.entries.is_empty());
    }

    #[test]
    fn request_byte_and_structure_limits_refuse_before_any_reservation() {
        let mut cache = cache(BrowserTransactionFinalLimits {
            max_request_bytes: 512,
            ..Default::default()
        });
        let mut huge = request("huge");
        huge.payload = json!("x".repeat(1024));
        assert!(cache.reserve(7, &huge, 4096).is_err());
        let mut deep = request("deep");
        deep.payload = Value::Null;
        for _ in 0..MAX_FINGERPRINT_DEPTH + 2 {
            deep.payload = Value::Array(vec![deep.payload]);
        }
        assert_eq!(
            cache.reserve(7, &deep, 4096).unwrap_err().code,
            BridgeErrorCode::InvalidRequest
        );
        assert!(cache.entries.is_empty());
        assert_eq!(cache.used_bytes, "session".len());
    }

    #[test]
    fn consumable_owner_requires_a_finite_unambiguous_lane_and_explicit_negotiation() {
        for lane in [
            "".into(),
            ":".into(),
            "a b".into(),
            "a\nb".into(),
            "中".into(),
            "x".repeat(MAX_LANE_BYTES + 1),
        ] {
            assert!(BrowserTransactionFinals::new_consumable(
                "session",
                7,
                BrowserTransactionFinalLimits::default(),
                lane,
            )
            .is_err());
        }
        let mut legacy = cache(BrowserTransactionFinalLimits::default());
        assert_eq!(legacy.lane_id(), None);
        assert!(legacy.consume(7, "lane", "0", &[]).is_err());
        let mut cache = consumable(BrowserTransactionFinalLimits::default());
        assert_eq!(cache.lane_id(), Some("lane"));
        assert_eq!(cache.used_bytes, "sessionlane".len());
        cache.consume(7, "lane", "0", &[]).unwrap();
        assert!(cache.entries.is_empty());
        assert!(BrowserTransactionFinals::new_consumable(
            "session",
            7,
            BrowserTransactionFinalLimits {
                max_bytes: 10,
                max_request_bytes: 10,
                max_reserved_final_bytes: 10,
                max_entries: 1
            },
            "toolong".into(),
        )
        .is_err());
    }

    #[test]
    fn explicit_consumption_keeps_more_than_a_thousand_turns_bounded_without_id_revival() {
        let mut cache = consumable(BrowserTransactionFinalLimits {
            max_entries: 2,
            ..Default::default()
        });
        let base = cache.used_bytes;
        for sequence in 1..=1_200 {
            let request = consumable_request(sequence);
            let (complete, receipt) = seal_consumable(&mut cache, &request);
            assert!(cache.used_bytes > base);
            assert!(cache.used_bytes <= cache.limits.max_bytes);
            assert_eq!(cache.entries.len(), 1);
            match cache.reserve(7, &request, 1).unwrap() {
                BrowserTransactionAdmission::Replay(replayed) => assert_eq!(replayed, complete),
                other => panic!("unconsumed final must replay: {other:?}"),
            }
            cache
                .consume(
                    7,
                    "lane",
                    &sequence.to_string(),
                    std::slice::from_ref(&receipt),
                )
                .unwrap();
            assert_eq!(cache.used_bytes, base);
            assert!(cache.entries.is_empty());
            assert_eq!(cache.sequence, sequence);
            assert_eq!(
                cache.consumption.as_ref().unwrap().retired_through,
                sequence
            );
            assert_eq!(
                cache.reserve(7, &request, 4096).unwrap_err().code,
                BridgeErrorCode::Cancelled
            );
            cache
                .consume(7, "lane", &sequence.to_string(), &[receipt])
                .unwrap();
            assert_eq!(cache.used_bytes, base);
        }
    }

    #[test]
    fn consumable_requests_bind_canonical_sequence_lane_and_request_id_before_admission() {
        let mut cache = consumable(BrowserTransactionFinalLimits::default());
        let original = consumable_request(1);
        for variant in 0..11 {
            let mut bad = original.clone();
            match variant {
                0 => bad.request_id = "arbitrary-old-id".into(),
                1 => bad.payload["transaction"]["laneId"] = json!("another"),
                2 => bad.payload["transaction"]["sequence"] = json!("01"),
                3 => bad.payload["transaction"]["sequence"] = json!("+1"),
                4 => bad.payload["transaction"]["sequence"] = json!(1),
                5 => bad.payload["transaction"]["sequence"] = json!("18446744073709551616"),
                6 => bad.payload["transaction"]["extra"] = json!(true),
                7 => bad.payload["version"] = json!("2.0"),
                8 => {
                    bad.payload.as_object_mut().unwrap().remove("transaction");
                }
                9 => bad = consumable_request(2),
                10 => bad = consumable_request(0),
                _ => unreachable!(),
            }
            assert!(cache.reserve(7, &bad, 4096).is_err(), "variant {variant}");
            assert_eq!(cache.sequence, 0);
            assert!(cache.entries.is_empty());
            assert_eq!(cache.used_bytes, cache.base_bytes());
        }
        let (_, receipt) = seal_consumable(&mut cache, &original);
        let retained = cache.used_bytes;
        for variant in 0..3 {
            let mut bad = original.clone();
            match variant {
                0 => bad.op = "view.live.abort".into(),
                1 => bad.payload["changed"] = json!(true),
                2 => bad.payload["transaction"]["sequence"] = json!("2"),
                _ => unreachable!(),
            }
            assert!(cache.reserve(7, &bad, 4096).is_err());
            assert_eq!(cache.used_bytes, retained);
        }
        cache.consume(7, "lane", "1", &[receipt]).unwrap();
        let mut reused_id = consumable_request(2);
        reused_id.request_id = original.request_id;
        assert!(cache.reserve(7, &reused_id, 4096).is_err());
        assert_eq!(cache.sequence, 1);
    }

    #[test]
    fn consumption_rejects_pending_indeterminate_and_missing_prefixes_atomically() {
        for state in ["pending", "indeterminate", "missing"] {
            let mut cache = consumable(BrowserTransactionFinalLimits::default());
            let first = consumable_request(1);
            let reservation = execute(&mut cache, &first, 4096);
            if state == "indeterminate" {
                cache.mark_indeterminate(reservation).unwrap();
            } else {
                drop(reservation);
            }
            let (_, second_receipt) = seal_consumable(&mut cache, &consumable_request(2));
            if state == "missing" {
                cache.entries.remove(&first.request_id);
            }
            let bytes = cache.used_bytes;
            let count = cache.entries.len();
            let receipts = [
                ConsumptionReceipt {
                    sequence: "1".into(),
                    token: "0".repeat(64),
                },
                second_receipt,
            ];
            assert!(
                cache.consume(7, "lane", "2", &receipts).is_err(),
                "state {state}"
            );
            assert_eq!(cache.used_bytes, bytes);
            assert_eq!(cache.entries.len(), count);
            assert_eq!(cache.consumption.as_ref().unwrap().retired_through, 0);
        }
    }

    #[test]
    fn consumption_checks_the_whole_contiguous_prefix_before_releasing_valid_entries() {
        let mut cache = consumable(BrowserTransactionFinalLimits::default());
        let (_, first) = seal_consumable(&mut cache, &consumable_request(1));
        let (_, second) = seal_consumable(&mut cache, &consumable_request(2));
        let before = cache.used_bytes;
        for receipts in [
            vec![second.clone()],
            vec![first.clone()],
            vec![first.clone(), first.clone()],
            vec![
                first.clone(),
                ConsumptionReceipt {
                    sequence: "2".into(),
                    token: "0".repeat(64),
                },
            ],
            vec![
                first.clone(),
                ConsumptionReceipt {
                    sequence: "02".into(),
                    token: second.token.clone(),
                },
            ],
            vec![
                first.clone(),
                ConsumptionReceipt {
                    sequence: "2".into(),
                    token: "x".repeat(64),
                },
            ],
            vec![
                first.clone(),
                ConsumptionReceipt {
                    sequence: "2".into(),
                    token: "f".repeat(65),
                },
            ],
        ] {
            assert!(cache.consume(7, "lane", "2", &receipts).is_err());
            assert_eq!(cache.used_bytes, before);
            assert_eq!(cache.entries.len(), 2);
            assert_eq!(cache.consumption.as_ref().unwrap().retired_through, 0);
        }
        assert!(cache
            .consume(7, "lane", "3", &[first.clone(), second.clone()])
            .is_err());
        assert!(cache
            .consume(7, "other", "2", &[first.clone(), second.clone()])
            .is_err());
        for epoch in [6, 8, u64::MAX] {
            assert_eq!(
                cache
                    .consume(epoch, "lane", "2", &[first.clone(), second.clone()])
                    .unwrap_err()
                    .code,
                BridgeErrorCode::Cancelled
            );
        }
        cache
            .consume(7, "lane", "1", std::slice::from_ref(&first))
            .unwrap();
        let retained = cache.used_bytes;
        assert_eq!(cache.entries.len(), 1);
        cache
            .consume(7, "lane", "1", std::slice::from_ref(&first))
            .unwrap();
        assert_eq!(cache.used_bytes, retained);
        cache.consume(7, "lane", "2", &[second]).unwrap();
        cache.consume(7, "lane", "1", &[first]).unwrap();
        assert_eq!(cache.consumption.as_ref().unwrap().retired_through, 2);
        assert_eq!(cache.used_bytes, cache.base_bytes());
    }

    #[test]
    fn saturation_leaves_the_exact_next_request_available_after_explicit_consumption() {
        let mut cache = consumable(BrowserTransactionFinalLimits {
            max_entries: 1,
            ..Default::default()
        });
        let (_, receipt) = seal_consumable(&mut cache, &consumable_request(1));
        let next = consumable_request(2);
        let retained = cache.used_bytes;
        for _ in 0..3 {
            assert_eq!(
                cache.reserve(7, &next, 4096).unwrap_err().code,
                BridgeErrorCode::Render
            );
            assert_eq!(cache.sequence, 1);
            assert_eq!(cache.used_bytes, retained);
        }
        cache.consume(7, "lane", "1", &[receipt]).unwrap();
        assert!(matches!(
            cache.reserve(7, &next, 4096).unwrap(),
            BrowserTransactionAdmission::Execute(_)
        ));
        assert_eq!(cache.sequence, 2);
    }

    #[test]
    fn receipt_binds_the_original_complete_final_and_both_retained_copies_are_charged() {
        let mut cache = consumable(BrowserTransactionFinalLimits::default());
        let request = consumable_request(1);
        let reservation = execute(&mut cache, &request, 4096);
        let reserved = cache.used_bytes;
        let mut batch = final_batch(&request);
        batch.messages.push(BridgeEnvelope::event(
            "session",
            "data.patch.batch",
            json!({"value":1}),
        ));
        let original = serde_json::to_vec(&batch).unwrap();
        let expected = container_ir::hex_digest(&original);
        cache.seal_complete_turn(reservation, &mut batch).unwrap();
        assert_eq!(batch.messages[0].payload["consumptionReceipt"], expected);
        let final_bytes = serde_json::to_vec(&batch).unwrap().len();
        assert_eq!(cache.used_bytes, reserved - 4096 + final_bytes + 64);
        assert_eq!(
            cache.entries[&request.request_id]
                .consumption_receipt
                .as_deref(),
            Some(expected.as_str())
        );
        let changed = {
            let mut batch = final_batch(&request);
            batch.messages.push(BridgeEnvelope::event(
                "session",
                "data.patch.batch",
                json!({"value":2}),
            ));
            container_ir::hex_digest(&serde_json::to_vec(&batch).unwrap())
        };
        assert_ne!(expected, changed);
        let before = cache.used_bytes;
        assert!(cache
            .consume(
                7,
                "lane",
                "1",
                &[ConsumptionReceipt {
                    sequence: "1".into(),
                    token: changed
                }]
            )
            .is_err());
        assert_eq!(cache.used_bytes, before);
        cache
            .consume(
                7,
                "lane",
                "1",
                &[ConsumptionReceipt {
                    sequence: "1".into(),
                    token: expected,
                }],
            )
            .unwrap();
        assert_eq!(cache.used_bytes, cache.base_bytes());
    }

    #[test]
    fn receipt_injection_failure_is_indeterminate_and_cannot_leak_a_usable_token() {
        for forged in [false, true] {
            let mut cache = consumable(BrowserTransactionFinalLimits::default());
            let request = consumable_request(1);
            let mut batch = final_batch(&request);
            let original = batch.clone();
            let reserved = serde_json::to_vec(&batch).unwrap().len() + 64;
            let reservation = execute(&mut cache, &request, reserved);
            if forged {
                batch.messages[0].payload["consumptionReceipt"] = json!("forged");
            }
            assert!(cache.seal_complete_turn(reservation, &mut batch).is_err());
            assert_eq!(batch, original);
            assert!(cache.entries[&request.request_id]
                .consumption_receipt
                .is_none());
            assert!(matches!(
                cache.entries[&request.request_id].state,
                FinalState::Indeterminate
            ));
            assert!(cache.reserve(7, &request, 4096).is_err());
            assert!(cache
                .consume(
                    7,
                    "lane",
                    "1",
                    &[ConsumptionReceipt {
                        sequence: "1".into(),
                        token: "0".repeat(64)
                    }]
                )
                .is_err());
        }
    }

    #[test]
    fn hard_epoch_retirement_keeps_wire_sequences_monotonic_and_old_ids_non_executable() {
        let mut cache = consumable(BrowserTransactionFinalLimits::default());
        let old = consumable_request(1);
        let (_, receipt) = seal_consumable(&mut cache, &old);
        cache.retire_epoch(8).unwrap();
        assert_eq!(cache.used_bytes, cache.base_bytes());
        assert_eq!(cache.sequence, 1);
        assert_eq!(cache.consumption.as_ref().unwrap().retired_through, 1);
        assert_eq!(
            cache.reserve(7, &old, 4096).unwrap_err().code,
            BridgeErrorCode::Cancelled
        );
        let mut old_in_new_epoch = old;
        old_in_new_epoch.payload["inputLifetimeRevision"] = json!("8");
        assert_eq!(
            cache.reserve(8, &old_in_new_epoch, 4096).unwrap_err().code,
            BridgeErrorCode::Cancelled
        );
        assert_eq!(
            cache
                .consume(7, "lane", "1", std::slice::from_ref(&receipt))
                .unwrap_err()
                .code,
            BridgeErrorCode::Cancelled
        );
        cache.consume(8, "lane", "1", &[receipt]).unwrap();
        let mut next = consumable_request(2);
        next.payload["inputLifetimeRevision"] = json!("8");
        let reservation = match cache.reserve(8, &next, 4096).unwrap() {
            BrowserTransactionAdmission::Execute(reservation) => reservation,
            other => panic!("new epoch continues next sequence: {other:?}"),
        };
        cache
            .seal_complete_turn(reservation, &mut final_batch(&next))
            .unwrap();
        cache.retire();
        assert!(cache.reserve(8, &next, 4096).is_err());
        assert!(cache.consume(8, "lane", "2", &[]).is_err());
        assert!(cache.retire_epoch(9).is_err());
    }

    #[test]
    fn consumption_and_sequence_exhaustion_fail_closed_without_overflow() {
        let mut cache = consumable(BrowserTransactionFinalLimits::default());
        cache.sequence = u64::MAX - 1;
        cache.consumption.as_mut().unwrap().retired_through = u64::MAX - 1;
        let request = consumable_request(u64::MAX);
        let (_, receipt) = seal_consumable(&mut cache, &request);
        cache
            .consume(7, "lane", &u64::MAX.to_string(), &[receipt])
            .unwrap();
        assert_eq!(cache.used_bytes, cache.base_bytes());
        assert!(cache.reserve(7, &request, 4096).is_err());
        let mut overflow = consumable_request(1);
        overflow.payload["transaction"]["sequence"] = json!("18446744073709551616");
        assert!(cache.reserve(7, &overflow, 4096).is_err());
        assert!(cache
            .consume(7, "lane", "18446744073709551616", &[])
            .is_err());
        assert_eq!(cache.sequence, u64::MAX);
        assert!(cache.entries.is_empty());
    }

    #[test]
    fn consumption_payload_shape_and_receipt_vectors_remain_finite_even_for_old_watermarks() {
        let mut cache = consumable(BrowserTransactionFinalLimits {
            max_entries: 1,
            ..Default::default()
        });
        assert!(serde_json::from_value::<ConsumptionReceipt>(
            json!({"sequence":"1","token":"0".repeat(64),"extra":true})
        )
        .is_err());
        let (_, receipt) = seal_consumable(&mut cache, &consumable_request(1));
        cache
            .consume(7, "lane", "1", std::slice::from_ref(&receipt))
            .unwrap();
        for through in ["01", "+1", "-1", "", "1.0"] {
            assert!(cache.consume(7, "lane", through, &[]).is_err());
        }
        assert!(cache
            .consume(7, "lane", "1", &[receipt.clone(), receipt])
            .is_err());
        cache.consume(7, "lane", "0", &[]).unwrap();
        assert_eq!(cache.consumption.as_ref().unwrap().retired_through, 1);
    }
}
