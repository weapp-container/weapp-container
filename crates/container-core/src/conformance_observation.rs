//! Opt-in native conformance transport. This is not a bridge or wx API.
//!
//! Receiver bindings prove private engine identity only. A Session adapter must
//! additionally bind its current PageId, route, lifetime, budget and delivery.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConformanceReceiverBinding {
    pub page_id: String,
    pub token: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ConformanceGuestRequest {
    Acquire {
        page_id: String,
    },
    Begin {
        binding: ConformanceReceiverBinding,
        invocation_id: String,
        method: String,
        args: Vec<Value>,
    },
    Poll {
        binding: ConformanceReceiverBinding,
        ticket: String,
    },
    Cancel {
        ticket: String,
    },
    ReadData {
        binding: ConformanceReceiverBinding,
        scope_id: Option<String>,
        path: String,
    },
    RuntimeLogs {
        reset: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ConformanceGuestValue {
    Undefined,
    Json { value: Value },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ConformanceThrownValue {
    Undefined,
    Json { value: Value },
    Uninspectable { value_type: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ConformanceGuestObservation {
    Acquired {
        binding: ConformanceReceiverBinding,
    },
    Data {
        value: ConformanceGuestValue,
        #[serde(rename = "receiverToken")]
        receiver_token: String,
    },
    RuntimeLogs {
        generation: u64,
        #[serde(rename = "resetCursor")]
        reset_cursor: u64,
        #[serde(rename = "startCursor")]
        start_cursor: u64,
        #[serde(rename = "endCursor")]
        end_cursor: u64,
        entries: Vec<ConformanceRuntimeLogEntry>,
        complete: bool,
        overflow: bool,
    },
    Begun {
        ticket: String,
    },
    Pending {
        ticket: String,
    },
    Fulfilled {
        ticket: String,
        value: ConformanceGuestValue,
    },
    Threw {
        ticket: String,
        reason: ConformanceThrownValue,
    },
    Rejected {
        ticket: String,
        reason: ConformanceThrownValue,
    },
    SerializationFailed {
        ticket: String,
        code: String,
    },
    Unsupported {
        ticket: String,
        code: String,
    },
    Revoked {
        ticket: String,
    },
    Cancelled {
        ticket: String,
    },
}

/// Native-only interval; independent from guest-writable diagnostic queues.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ConformanceExceptionRequest {
    Begin {
        max_events: u32,
        max_message_bytes: u32,
    },
    End {
        token: String,
        start_cursor: u64,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConformanceExceptionEvent {
    pub cursor: u64,
    pub message: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ConformanceExceptionObservation {
    Begun {
        token: String,
        start_cursor: u64,
    },
    Ended {
        token: String,
        start_cursor: u64,
        end_cursor: u64,
        events: Vec<ConformanceExceptionEvent>,
        complete: bool,
        overflow: bool,
    },
}

/// Private journal entries retain the complete source level and order.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConformanceRuntimeLogEntry {
    pub cursor: u64,
    pub level: String,
    pub text: String,
}
