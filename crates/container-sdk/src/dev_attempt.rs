//! SDK-owned development replacement journal. A lost transport response can
//! be queried without repeating application startup or irreversible hooks.
use crate::{
    host_layout::decimal, ContainerSession, HostLayout, LoadOptions, PackSource, SdkError,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    path::PathBuf,
};

const RETAINED_TERMINAL_ATTEMPTS: usize = 64;
const MAX_PENDING_ATTEMPTS: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptedPackIdentity {
    pub root: String,
    pub accepted_pack_revision: String,
    pub session_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DevPackAttemptReceipt {
    pub schema_version: u32,
    pub owner_id: String,
    pub attempt_id: String,
    pub status: String,
    pub operation: String,
    pub target_root: String,
    pub expected_accepted: Option<AcceptedPackIdentity>,
    pub accepted_pack_identity: Option<AcceptedPackIdentity>,
    pub reload_kind: crate::DevReloadKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
    /// Observation failures do not change the terminal execution outcome.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub observation_errors: Vec<Value>,
}

/// A query is passive, including after receipt retention expires. Missing
/// receipts expose current accepted metadata without recreating an attempt.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DevPackAttemptQuery {
    Receipt(Box<DevPackAttemptReceipt>),
    Missing(DevPackAttemptMissing),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DevPackAttemptMissing {
    pub schema_version: u32,
    pub owner_id: String,
    pub attempt_id: String,
    pub status: DevPackAttemptMissingStatus,
    pub accepted_pack_identity: Option<AcceptedPackIdentity>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DevPackAttemptMissingStatus {
    NotRetained,
    NotSeen,
}

struct Attempt {
    receipt: DevPackAttemptReceipt,
    source: PathBuf,
    options: LoadOptions,
    submission: Option<Value>,
}

#[derive(Default)]
pub(super) struct DevAttemptJournal {
    sequence: u64,
    attempts: BTreeMap<u64, Attempt>,
    terminal: VecDeque<u64>,
}

impl DevAttemptJournal {
    fn get(&self, id: &str) -> Result<&Attempt, SdkError> {
        let id = decimal(id, "attemptId")?;
        self.attempts.get(&id).ok_or_else(|| {
            SdkError::new(
                "ERR_CANCELLED",
                if id <= self.sequence {
                    "attempt receipt expired; an old attempt can never execute again"
                } else {
                    "attempt was not issued by this SDK owner"
                },
            )
        })
    }
    fn terminate(&mut self, id: u64, receipt: DevPackAttemptReceipt) {
        if let Some(attempt) = self.attempts.get_mut(&id) {
            attempt.receipt = receipt;
        }
        self.terminal.push_back(id);
        while self.terminal.len() > RETAINED_TERMINAL_ATTEMPTS {
            if let Some(old) = self.terminal.pop_front() {
                self.attempts.remove(&old);
            }
        }
    }
}

impl ContainerSession {
    pub fn accepted_pack_identity(&self) -> Result<Option<AcceptedPackIdentity>, SdkError> {
        self.check_owner()?;
        Ok(self.accepted_pack_metadata())
    }

    pub(super) fn accepted_pack_metadata(&self) -> Option<AcceptedPackIdentity> {
        self.active.as_ref().map(|active| AcceptedPackIdentity {
            root: active.pack.manifest.integrity.root.clone(),
            accepted_pack_revision: self.accepted_pack_revision.to_string(),
            session_id: active.session.config().session_id.clone(),
        })
    }

    fn validate_expected_accepted(
        &self,
        expected: &Option<AcceptedPackIdentity>,
    ) -> Result<(), SdkError> {
        if let Some(identity) = expected {
            decimal(&identity.accepted_pack_revision, "acceptedPackRevision")?;
        }
        if &self.accepted_pack_identity()? != expected {
            return Err(SdkError::new(
                "ERR_CANCELLED",
                "expectedAccepted does not match the current accepted pack identity",
            ));
        }
        Ok(())
    }

    pub fn begin_dev_pack_attempt(
        &mut self,
        payload: Value,
    ) -> Result<DevPackAttemptReceipt, SdkError> {
        crate::require_full_distribution()?;
        self.ensure_open()?;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Begin {
            operation: String,
            pack_path: PathBuf,
            expected_accepted: Option<AcceptedPackIdentity>,
            #[serde(default)]
            route: Option<String>,
            #[serde(default)]
            options: serde_json::Map<String, Value>,
        }
        if !payload
            .as_object()
            .is_some_and(|object| object.contains_key("expectedAccepted"))
        {
            return Err(SdkError::invalid(
                "beginDevPackAttempt requires explicit expectedAccepted (null for an empty owner)",
            ));
        }
        let request: Begin = serde_json::from_value(payload).map_err(SdkError::invalid)?;
        self.validate_expected_accepted(&request.expected_accepted)?;
        if !matches!(request.operation.as_str(), "load" | "applyDevPack") {
            return Err(SdkError::invalid(
                "attempt operation must be load or applyDevPack",
            ));
        }
        let pending = self
            .dev_attempts
            .attempts
            .values()
            .filter(|attempt| matches!(attempt.receipt.status.as_str(), "prepared" | "applying"))
            .count();
        if pending >= MAX_PENDING_ATTEMPTS {
            return Err(SdkError::invalid("development attempt queue is full"));
        }
        let source = request.pack_path.canonicalize().map_err(SdkError::pack)?;
        let pack = crate::pack::VerifiedPack::load(PackSource::Directory(source.clone()))?;
        pack.route(request.route.as_deref())?;
        let reload_kind = if request.operation == "load" {
            crate::DevReloadKind::Restart
        } else {
            self.classify_verified_dev_pack(&pack)
        };
        self.dev_attempts.sequence = self
            .dev_attempts
            .sequence
            .checked_add(1)
            .ok_or_else(|| SdkError::invalid("development attempt sequence exhausted"))?;
        let id = self.dev_attempts.sequence;
        let receipt = DevPackAttemptReceipt {
            schema_version: 1,
            owner_id: self.sdk_owner_id.to_string(),
            attempt_id: id.to_string(),
            status: "prepared".into(),
            operation: request.operation,
            target_root: pack.manifest.integrity.root,
            expected_accepted: request.expected_accepted,
            accepted_pack_identity: self.accepted_pack_identity()?,
            reload_kind,
            state: None,
            error: None,
            observation_errors: Vec::new(),
        };
        self.dev_attempts.attempts.insert(
            id,
            Attempt {
                receipt: receipt.clone(),
                source,
                options: LoadOptions {
                    route: request.route,
                    options: request.options,
                    ..LoadOptions::default()
                },
                submission: None,
            },
        );
        self.publish_attempt_receipt(&receipt);
        Ok(receipt)
    }

    pub fn query_dev_pack_attempt(
        &self,
        owner_id: &str,
        id: &str,
    ) -> Result<DevPackAttemptQuery, SdkError> {
        crate::require_full_distribution()?;
        self.check_owner()?;
        if owner_id != self.sdk_owner_id.to_string() {
            return Err(SdkError::new("ERR_CANCELLED", "attempt SDK owner changed"));
        }
        let sequence = decimal(id, "attemptId")?;
        if let Some(attempt) = self.dev_attempts.attempts.get(&sequence) {
            return Ok(DevPackAttemptQuery::Receipt(Box::new(
                attempt.receipt.clone(),
            )));
        }
        Ok(DevPackAttemptQuery::Missing(DevPackAttemptMissing {
            schema_version: 1,
            owner_id: owner_id.into(),
            attempt_id: id.into(),
            status: if sequence <= self.dev_attempts.sequence {
                DevPackAttemptMissingStatus::NotRetained
            } else {
                DevPackAttemptMissingStatus::NotSeen
            },
            accepted_pack_identity: self.accepted_pack_identity()?,
        }))
    }

    fn owned_dev_attempt_receipt(
        &self,
        owner_id: &str,
        id: &str,
    ) -> Result<DevPackAttemptReceipt, SdkError> {
        self.check_owner()?;
        if owner_id != self.sdk_owner_id.to_string() {
            return Err(SdkError::new("ERR_CANCELLED", "attempt SDK owner changed"));
        }
        Ok(self.dev_attempts.get(id)?.receipt.clone())
    }

    pub fn apply_dev_pack_attempt(
        &mut self,
        payload: Value,
    ) -> Result<DevPackAttemptReceipt, SdkError> {
        crate::require_full_distribution()?;
        self.apply_dev_pack_attempt_observing(payload, Self::state)
    }

    pub(super) fn apply_dev_pack_attempt_observing(
        &mut self,
        payload: Value,
        observe: impl FnOnce(&Self) -> Result<Value, SdkError>,
    ) -> Result<DevPackAttemptReceipt, SdkError> {
        self.check_owner()?;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Apply {
            owner_id: String,
            attempt_id: String,
            expected_accepted: Option<AcceptedPackIdentity>,
            #[serde(default)]
            initial_host_layout: Option<HostLayout>,
        }
        if !payload
            .as_object()
            .is_some_and(|object| object.contains_key("expectedAccepted"))
        {
            return Err(SdkError::invalid(
                "applyDevPackAttempt requires explicit expectedAccepted",
            ));
        }
        let request: Apply = serde_json::from_value(payload.clone()).map_err(SdkError::invalid)?;
        let previous = self.owned_dev_attempt_receipt(&request.owner_id, &request.attempt_id)?;
        let attempt = self.dev_attempts.get(&request.attempt_id)?;
        if attempt
            .submission
            .as_ref()
            .is_some_and(|submission| submission != &payload)
        {
            return Err(SdkError::invalid(
                "attempt ID already binds a different apply payload",
            ));
        }
        if previous.status != "prepared" {
            return Ok(previous);
        }
        self.ensure_open()?;
        let source = attempt.source.clone();
        let mut options = attempt.options.clone();
        options.initial_host_layout = request.initial_host_layout;
        let id = decimal(&request.attempt_id, "attemptId")?;
        self.dev_attempts
            .attempts
            .get_mut(&id)
            .expect("issued attempt")
            .submission = Some(payload);
        let preflight = self
            .validate_expected_accepted(&request.expected_accepted)
            .and_then(|()| {
                if previous.expected_accepted != request.expected_accepted {
                    return Err(SdkError::new(
                        "ERR_CANCELLED",
                        "attempt expectedAccepted changed",
                    ));
                }
                let pack = crate::pack::VerifiedPack::load(PackSource::Directory(source.clone()))?;
                if pack.manifest.integrity.root != previous.target_root {
                    return Err(SdkError::pack("attempt pack changed after preparation"));
                }
                Ok(pack)
            });
        let mut receipt = previous;
        if let Ok(pack) = preflight {
            // Health may change while a prepared attempt waits for native
            // measurement. The receipt must describe the actual apply path.
            receipt.reload_kind = if receipt.operation == "load" {
                crate::DevReloadKind::Restart
            } else {
                self.classify_verified_dev_pack(&pack)
            };
            let attempt = self
                .dev_attempts
                .attempts
                .get_mut(&id)
                .expect("issued attempt");
            attempt.receipt.status = "applying".into();
            let result = if receipt.operation == "load" {
                self.load_verified(pack, options)
            } else {
                self.apply_verified_dev_pack(pack, options).map(|_| ())
            };
            receipt.accepted_pack_identity = self.accepted_pack_metadata();
            let published = receipt.accepted_pack_identity != receipt.expected_accepted
                && receipt
                    .accepted_pack_identity
                    .as_ref()
                    .is_some_and(|identity| identity.root == receipt.target_root);
            match result {
                Ok(()) => receipt.status = "accepted".into(),
                Err(error) if published => {
                    // Publication is irreversible. A failed observer/cleanup
                    // after that point must never promise the previous pack
                    // remains accepted or permit a retry to replay startup.
                    receipt.status = "accepted".into();
                    receipt
                        .observation_errors
                        .push(json!({"phase":"postCommit","error":error}));
                }
                Err(error) => {
                    receipt.status = "rejected".into();
                    receipt.error = Some(json!(error));
                }
            }
            match observe(self) {
                Ok(state) => receipt.state = Some(state),
                Err(error) => receipt
                    .observation_errors
                    .push(json!({"phase":"state","error":error})),
            }
        } else if let Err(error) = preflight {
            receipt.status = "rejected".into();
            receipt.accepted_pack_identity = self.accepted_pack_metadata();
            receipt.error = Some(json!(error));
        }
        self.dev_attempts.terminate(id, receipt.clone());
        self.publish_attempt_receipt(&receipt);
        Ok(receipt)
    }

    pub fn cancel_dev_pack_attempt(
        &mut self,
        owner_id: &str,
        id: &str,
    ) -> Result<DevPackAttemptReceipt, SdkError> {
        crate::require_full_distribution()?;
        self.check_owner()?;
        let mut receipt = self.owned_dev_attempt_receipt(owner_id, id)?;
        if receipt.status != "prepared" {
            return Ok(receipt);
        }
        receipt.status = "cancelled".into();
        receipt.accepted_pack_identity = self.accepted_pack_metadata();
        receipt.error = Some(
            json!({"code":"ERR_CANCELLED", "message":"Development attempt cancelled before submission."}),
        );
        self.dev_attempts
            .terminate(decimal(id, "attemptId")?, receipt.clone());
        self.publish_attempt_receipt(&receipt);
        Ok(receipt)
    }

    fn publish_attempt_receipt(&mut self, receipt: &DevPackAttemptReceipt) {
        self.push_event(json!({"type":"devPackAttempt", "receipt":receipt}));
    }

    pub(super) fn cancel_prepared_dev_attempts(&mut self) {
        let ids: Vec<_> = self
            .dev_attempts
            .attempts
            .iter()
            .filter(|(_, attempt)| attempt.receipt.status == "prepared")
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            let mut receipt = self.dev_attempts.attempts[&id].receipt.clone();
            receipt.status = "cancelled".into();
            receipt.accepted_pack_identity = self.accepted_pack_metadata();
            receipt.error = Some(
                json!({"code":"ERR_CANCELLED", "message":"Accepted pack ownership changed or closed."}),
            );
            self.dev_attempts.terminate(id, receipt.clone());
            self.publish_attempt_receipt(&receipt);
        }
    }
}
