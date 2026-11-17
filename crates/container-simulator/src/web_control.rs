//! Strict opt-in control framing and authentication. This module does not
//! register routes, enable control, select a ledger, bootstrap a preview or
//! authorize execution. The existing owner remains responsible for those steps.
//! The original owner constructs one trusted context before accepting requests;
//! retain it after stop so exact cleanup/replay/ACK remain possible.

use crate::browser_dev_control::{
    ControlRetirementReply, ControlRetirementRequest, FinalAckOutcome, MAX_CONTROL_REQUEST_BYTES,
    MAX_CONTROL_RETIREMENT_BYTES,
};
use crate::browser_dev_coordinator::{CoordinatorSnapshot, PreviewLease};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;

pub const MAX_CONTROL_HEADER_BYTES: usize = 16 * 1024;
pub const MAX_CONTROL_ACK_BYTES: usize = 2 * MAX_CONTROL_REQUEST_BYTES + 1024;
/// Observations do not enter the command ledger. Their fixed version request
/// and typed response are still independently bounded by the HTTP transport.
pub const MAX_CONTROL_OBSERVATION_REQUEST_BYTES: usize = 64;
const MAX_HEADERS: usize = 64;
const VERSION: &str = "1.0";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ControlHttpError {
    InvalidContext,
    InvalidFraming,
    UnsupportedMethod,
    UnknownEndpoint,
    Denied,
    TooLarge,
    Incomplete,
    InvalidAcknowledgement,
    InvalidRetirement,
    Unavailable,
}
type Result<T> = std::result::Result<T, ControlHttpError>;

/// Latched from the existing owner, NEVER derived from a request. This context
/// does not select/create a ledger. No Debug/Clone exposes or duplicates secret.
pub struct ControlHttpAuth {
    run_id: String,
    client_id: String,
    secret: String,
    host: String,
    origin: String,
    local_address: SocketAddr,
    is_http: bool,
}
impl ControlHttpAuth {
    pub fn new(
        run_id: String,
        client_id: String,
        secret: String,
        host: String,
        origin: String,
    ) -> Result<Self> {
        let id = |text: &str, limit| {
            !text.is_empty()
                && text.len() <= limit
                && text.as_bytes()[0].is_ascii_alphanumeric()
                && text
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        };
        let (local_address, host, is_http) = trusted_authority(&host, &origin)?;
        if !id(&run_id, 128)
            || !id(&client_id, 64)
            || secret.is_empty()
            || secret.len() > 4096
            || !secret.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
        {
            return Err(ControlHttpError::InvalidContext);
        }
        Ok(Self {
            run_id,
            client_id,
            secret,
            host,
            origin,
            local_address,
            is_http,
        })
    }
    pub fn run_id(&self) -> &str {
        &self.run_id
    }
    pub fn client_id(&self) -> &str {
        &self.client_id
    }
    /// The plain-HTTP surface must match the exact latched listening address.
    /// A TLS or proxy context cannot authorize this non-TLS surface.
    pub fn matches_local_http(&self, address: SocketAddr) -> bool {
        self.is_http && self.local_address == address
    }
    /// Exact original browser authority, never selected or normalized by GET.
    pub(crate) fn matches_dev_app_host(&self, host: &str) -> bool {
        self.host == host
    }

    /// Trusted startup only. This is the sole credential projection into an
    /// inert script element; never expose it through Debug, errors or logging.
    pub(crate) fn browser_dev_bootstrap_json(&self, preview: &PreviewLease) -> Result<String> {
        self.browser_dev_bootstrap_json_profile(preview, false)
    }

    /// Trusted startup advertises retirement only with the original owner's
    /// separate opt-in. Ordinary bootstrap retains its previous wire shape.
    pub(crate) fn browser_dev_bootstrap_json_with_retirement(
        &self,
        preview: &PreviewLease,
    ) -> Result<String> {
        self.browser_dev_bootstrap_json_profile(preview, true)
    }

    fn browser_dev_bootstrap_json_profile(
        &self,
        preview: &PreviewLease,
        retirement: bool,
    ) -> Result<String> {
        let preview_id = &preview.preview_id;
        if !self.is_http
            || !self.local_address.ip().is_loopback()
            || preview.version != VERSION
            || preview.run_id != self.run_id
            || preview.lease_revision.get() == 0
            || preview_id.is_empty()
            || preview_id.len() > 128
            || !preview_id.as_bytes()[0].is_ascii_alphanumeric()
            || !preview_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        {
            return Err(ControlHttpError::InvalidContext);
        }
        let mut value = serde_json::json!({
            "bootstrap": {
                "version": VERSION, "baseUrl": format!("{}/", self.origin),
                "runId": self.run_id, "clientId": self.client_id, "preview": preview
            },
            "secret": self.secret
        });
        if retirement {
            value["bootstrap"]["retirementVersion"] = serde_json::Value::String(VERSION.to_owned());
        }
        let json = serde_json::to_string(&value).map_err(|_| ControlHttpError::InvalidContext)?;
        Ok(json
            .replace('&', "\\u0026")
            .replace('<', "\\u003c")
            .replace('>', "\\u003e"))
    }

    fn authenticates(&self, headers: &BTreeMap<String, &str>) -> bool {
        headers.get("host") == Some(&self.host.as_str())
            && headers.get("origin") == Some(&self.origin.as_str())
            && headers.get("x-weapp-run-id") == Some(&self.run_id.as_str())
            && headers.get("x-weapp-client-id") == Some(&self.client_id.as_str())
            && headers.get("x-weapp-dev-secret") == Some(&self.secret.as_str())
    }
}

/// Normalize only the owner's trusted bind address to browser authority spelling.
/// Incoming headers are never normalized. Explicit default ports disappear from
/// browser Host/Origin, so the supplied Origin must already use that canonical
/// spelling. Hostname/TLS proxy configuration needs a separate trusted entry point.
fn trusted_authority(host: &str, origin: &str) -> Result<(SocketAddr, String, bool)> {
    let (scheme, default_port, is_http) = if origin.starts_with("http://") {
        ("http", 80, true)
    } else if origin.starts_with("https://") {
        ("https", 443, false)
    } else {
        return Err(ControlHttpError::InvalidContext);
    };
    let address = host
        .parse::<SocketAddr>()
        .ok()
        .filter(|address| address.port() != 0 && address.to_string() == host)
        .or_else(|| {
            host.parse::<Ipv4Addr>()
                .ok()
                .filter(|address| address.to_string() == host)
                .map(|address| SocketAddr::new(IpAddr::V4(address), default_port))
        })
        .or_else(|| {
            host.strip_prefix('[')
                .and_then(|value| value.strip_suffix(']'))
                .and_then(|value| value.parse::<Ipv6Addr>().ok())
                .filter(|address| format!("[{address}]") == host)
                .map(|address| SocketAddr::new(IpAddr::V6(address), default_port))
        })
        .ok_or(ControlHttpError::InvalidContext)?;
    // Browsers reject IPv6 zones and spell IPv4-mapped hosts differently from
    // Rust's SocketAddr Display. Fail unsupported trusted addresses explicitly
    // instead of latching an authority no browser can authenticate against.
    if let SocketAddr::V6(address) = address {
        if address.scope_id() != 0 || address.ip().to_ipv4_mapped().is_some() {
            return Err(ControlHttpError::InvalidContext);
        }
    }
    let authority = if address.port() == default_port {
        match address.ip() {
            IpAddr::V4(address) => address.to_string(),
            IpAddr::V6(address) => format!("[{address}]"),
        }
    } else {
        address.to_string()
    };
    if origin != format!("{scheme}://{authority}") {
        return Err(ControlHttpError::InvalidContext);
    }
    Ok((address, authority, is_http))
}

/// Own the original HTTP buffer once. Body access borrows its exact bytes; no
/// copied request cache or normalized/reencoded command is manufactured here.
pub struct RetainedControlBytes {
    wire: Vec<u8>,
    body_start: usize,
}
impl RetainedControlBytes {
    pub fn bytes(&self) -> &[u8] {
        &self.wire[self.body_start..]
    }
    /// Retained allocation, including headers and spare buffer capacity.
    pub fn retained_capacity(&self) -> usize {
        self.wire.capacity()
    }
}
impl std::fmt::Debug for RetainedControlBytes {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RetainedControlBytes")
            .field("body_bytes", &self.bytes().len())
            .finish_non_exhaustive()
    }
}
#[derive(Debug)]
pub enum WebControlRequest {
    Invoke(RetainedControlBytes),
    Replay(RetainedControlBytes),
    Acknowledge(ControlAcknowledgement),
    /// Negotiated prefix retirement, outside command/admission serials.
    Retire(ControlRetirementRequest),
    /// Authenticated read-only observation on the same original owner lane.
    /// No request serial, command admission, retained final, replay or ACK.
    Observe,
}
impl WebControlRequest {
    /// Heap bytes retained after parsing. Before parsing, the surface charges
    /// the original wire capacity; ACK parsing replaces that with these strings.
    pub fn retained_capacity(&self) -> usize {
        match self {
            Self::Invoke(bytes) | Self::Replay(bytes) => bytes.retained_capacity(),
            Self::Acknowledge(ack) => {
                ack.version.capacity()
                    + ack.original_request.capacity()
                    + ack.final_sha256.capacity()
            }
            Self::Retire(request) => request.version.capacity() + request.prefix_sha256.capacity(),
            Self::Observe => 0,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlAcknowledgement {
    version: String,
    original_request: String,
    final_sha256: String,
}
impl ControlAcknowledgement {
    pub fn original_request_bytes(&self) -> &[u8] {
        self.original_request.as_bytes()
    }
    pub fn final_sha256(&self) -> &str {
        &self.final_sha256
    }
}
impl std::fmt::Debug for ControlAcknowledgement {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ControlAcknowledgement")
            .field("original_request_bytes", &self.original_request.len())
            .field("final_sha256", &self.final_sha256)
            .finish_non_exhaustive()
    }
}

/// WebSurface moves this original ledger Arc into its PendingResponse
/// body and retain it until actual write completion/failure/deadline/teardown.
/// Only the HTTP header gets a new allocation/charge. Never queue_response(),
/// Vec::clone(), serde reencoding or Arc::new(final_bytes.to_vec()) for a final.
pub enum WebControlResponse {
    Final(Arc<Vec<u8>>),
    Acknowledged(ControlAcknowledgementReply),
    Retired(ControlRetirementReply),
    /// The original owner's typed snapshot, bounded again while encoding.
    /// It is not a ledger final and must be charged to HTTP response memory.
    Observation(Box<CoordinatorSnapshot>),
    Refused(ControlHttpError),
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlAcknowledgementReply {
    pub version: &'static str,
    pub request_id: String,
    pub final_sha256: String,
    /// Must come from the original ledger's acknowledge_final result. Neither
    /// this DTO, delivery nor a disconnect decides compaction or Worker close.
    pub outcome: FinalAckOutcome,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ControlFrameProgress {
    Incomplete,
    Complete,
}
#[derive(Clone, Copy)]
enum Endpoint {
    Invoke,
    Replay,
    Acknowledge,
    Retire,
    Observe,
}
struct CompleteFrame {
    endpoint: Endpoint,
    body_start: usize,
}

/// Incremental check. Authentication and declared-size limits run as soon as
/// the complete header exists, before waiting for body bytes. Complete means
/// framing/auth complete, NOT valid ledger command/ACK JSON or permission to run.
pub fn inspect_control_frame(auth: &ControlHttpAuth, wire: &[u8]) -> Result<ControlFrameProgress> {
    Ok(if complete_frame(auth, wire)?.is_some() {
        ControlFrameProgress::Complete
    } else {
        ControlFrameProgress::Incomplete
    })
}

pub fn parse_control_request(auth: &ControlHttpAuth, wire: Vec<u8>) -> Result<WebControlRequest> {
    let frame = complete_frame(auth, &wire)?.ok_or(ControlHttpError::Incomplete)?;
    match frame.endpoint {
        Endpoint::Invoke => Ok(WebControlRequest::Invoke(RetainedControlBytes {
            wire,
            body_start: frame.body_start,
        })),
        Endpoint::Replay => Ok(WebControlRequest::Replay(RetainedControlBytes {
            wire,
            body_start: frame.body_start,
        })),
        Endpoint::Acknowledge => {
            let ack: ControlAcknowledgement = serde_json::from_slice(&wire[frame.body_start..])
                .map_err(|_| ControlHttpError::InvalidAcknowledgement)?;
            if ack.version != VERSION
                || ack.original_request.is_empty()
                || ack.original_request.len() > MAX_CONTROL_REQUEST_BYTES
                || ack.final_sha256.len() != 64
                || !ack
                    .final_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(ControlHttpError::InvalidAcknowledgement);
            }
            // Original JSON command semantics and exact identity/canonical
            // matching remain exclusively in the existing ControlLedger.
            Ok(WebControlRequest::Acknowledge(ack))
        }
        Endpoint::Retire => {
            let request: ControlRetirementRequest =
                serde_json::from_slice(&wire[frame.body_start..])
                    .map_err(|_| ControlHttpError::InvalidRetirement)?;
            request
                .validate()
                .map_err(|_| ControlHttpError::InvalidRetirement)?;
            Ok(WebControlRequest::Retire(request))
        }
        Endpoint::Observe => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct ObservationRequest<'a> {
                #[serde(borrow)]
                version: &'a str,
            }
            let request: ObservationRequest<'_> = serde_json::from_slice(&wire[frame.body_start..])
                .map_err(|_| ControlHttpError::InvalidFraming)?;
            if request.version != VERSION {
                return Err(ControlHttpError::InvalidFraming);
            }
            Ok(WebControlRequest::Observe)
        }
    }
}

fn complete_frame(auth: &ControlHttpAuth, wire: &[u8]) -> Result<Option<CompleteFrame>> {
    let prefix = &wire[..wire.len().min(MAX_CONTROL_HEADER_BYTES)];
    let Some(header_end) = prefix.windows(4).position(|part| part == b"\r\n\r\n") else {
        return if wire.len() >= MAX_CONTROL_HEADER_BYTES {
            Err(ControlHttpError::TooLarge)
        } else {
            Ok(None)
        };
    };
    let body_start = header_end + 4;
    if body_start > MAX_CONTROL_HEADER_BYTES {
        return Err(ControlHttpError::TooLarge);
    }
    let header =
        std::str::from_utf8(&wire[..header_end]).map_err(|_| ControlHttpError::InvalidFraming)?;
    let mut lines = header.split("\r\n");
    let mut parts = lines.next().unwrap_or_default().split(' ');
    let (Some(method), Some(path), Some("HTTP/1.1"), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(ControlHttpError::InvalidFraming);
    };
    if method != "POST" {
        return Err(ControlHttpError::UnsupportedMethod);
    }
    if !path.starts_with('/')
        || path
            .bytes()
            .any(|byte| !byte.is_ascii_graphic() || b"%?#\\".contains(&byte))
    {
        return Err(ControlHttpError::InvalidFraming);
    }
    let endpoint = match path {
        "/__weapp/control/invoke" => Endpoint::Invoke,
        "/__weapp/control/replay" => Endpoint::Replay,
        "/__weapp/control/acknowledge" => Endpoint::Acknowledge,
        "/__weapp/control/retire" => Endpoint::Retire,
        "/__weapp/control/observe" => Endpoint::Observe,
        _ => return Err(ControlHttpError::UnknownEndpoint),
    };
    let mut headers = BTreeMap::new();
    for line in lines {
        let (name, value) = line
            .split_once(':')
            .ok_or(ControlHttpError::InvalidFraming)?;
        if headers.len() >= MAX_HEADERS
            || name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || !value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
            || headers
                .insert(name.to_ascii_lowercase(), value.trim_matches(' '))
                .is_some()
        {
            return Err(ControlHttpError::InvalidFraming);
        }
    }
    if ["transfer-encoding", "trailer", "expect", "upgrade"]
        .iter()
        .any(|name| headers.contains_key(*name))
    {
        return Err(ControlHttpError::InvalidFraming);
    }
    if !auth.authenticates(&headers) {
        return Err(ControlHttpError::Denied);
    }
    if !headers.get("content-type").is_some_and(|value| {
        value.eq_ignore_ascii_case("application/json")
            || value.eq_ignore_ascii_case("application/json; charset=utf-8")
    }) {
        return Err(ControlHttpError::InvalidFraming);
    }
    let text = headers
        .get("content-length")
        .ok_or(ControlHttpError::InvalidFraming)?;
    let length: usize = text.parse().map_err(|_| ControlHttpError::InvalidFraming)?;
    if length.to_string() != *text {
        return Err(ControlHttpError::InvalidFraming);
    }
    let limit = match endpoint {
        Endpoint::Acknowledge => MAX_CONTROL_ACK_BYTES,
        Endpoint::Observe => MAX_CONTROL_OBSERVATION_REQUEST_BYTES,
        Endpoint::Retire => MAX_CONTROL_RETIREMENT_BYTES,
        _ => MAX_CONTROL_REQUEST_BYTES,
    };
    if length > limit {
        return Err(ControlHttpError::TooLarge);
    }
    let total = body_start
        .checked_add(length)
        .ok_or(ControlHttpError::TooLarge)?;
    if wire.len() > total {
        return Err(ControlHttpError::InvalidFraming);
    }
    Ok((wire.len() == total).then_some(CompleteFrame {
        endpoint,
        body_start,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn browser_incompatible_ipv6_authorities_are_explicitly_refused() {
        for (host, origin) in [
            ("[fe80::1%1]:58730", "http://[fe80::1%1]:58730"),
            ("[fe80::1%1]:80", "http://[fe80::1]"),
            (
                "[::ffff:127.0.0.1]:58730",
                "http://[::ffff:127.0.0.1]:58730",
            ),
            ("[::ffff:127.0.0.1]:80", "http://[::ffff:127.0.0.1]"),
            ("[::ffff:127.0.0.1]", "http://[::ffff:127.0.0.1]"),
        ] {
            assert!(matches!(
                ControlHttpAuth::new(
                    "run".into(),
                    "client".into(),
                    "secret".into(),
                    host.into(),
                    origin.into()
                ),
                Err(ControlHttpError::InvalidContext)
            ));
        }
        assert!(ControlHttpAuth::new(
            "run".into(),
            "client".into(),
            "secret".into(),
            "[::1]:80".into(),
            "http://[::1]".into()
        )
        .unwrap()
        .matches_local_http("[::1]:80".parse().unwrap()));
    }

    fn auth() -> ControlHttpAuth {
        ControlHttpAuth::new(
            "run-test".into(),
            "client-test".into(),
            "secret-test".into(),
            "127.0.0.1:58730".into(),
            "http://127.0.0.1:58730".into(),
        )
        .unwrap()
    }
    fn wire(path: &str, body: &[u8], extra: &str) -> Vec<u8> {
        let mut bytes = format!("POST {path} HTTP/1.1\r\nHost: 127.0.0.1:58730\r\nOrigin: http://127.0.0.1:58730\r\nX-Weapp-Run-Id: run-test\r\nX-Weapp-Client-Id: client-test\r\nX-Weapp-Dev-Secret: secret-test\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra}\r\n", body.len()).into_bytes();
        bytes.extend_from_slice(body);
        bytes
    }
    fn rejected(bytes: Vec<u8>, expected: ControlHttpError) {
        assert!(matches!(parse_control_request(&auth(), bytes), Err(error) if error == expected));
    }
    #[test]
    fn invoke_and_replay_preserve_the_original_body_allocation_and_spelling() {
        let body = b" \n{\"payload\":{},\"requestId\":\"client-test:control-1\",\"command\":\"snapshot\",\"version\":\"1.0\"}\n";
        for path in ["/__weapp/control/invoke", "/__weapp/control/replay"] {
            let bytes = wire(path, body, "");
            let body_pointer = bytes.as_ptr().wrapping_add(bytes.len() - body.len());
            let request = parse_control_request(&auth(), bytes).unwrap();
            let (WebControlRequest::Invoke(retained) | WebControlRequest::Replay(retained)) =
                request
            else {
                panic!("wrong operation");
            };
            assert_eq!(retained.bytes(), body);
            assert_eq!(retained.bytes().as_ptr(), body_pointer);
        }
    }

    #[test]
    fn retirement_is_strict_authenticated_and_separate_from_command_admission() {
        let valid = json!({
            "version": "1.0", "lane": "normal", "previousThrough": "0",
            "throughSerial": "7", "prefixSha256": "a".repeat(64)
        });
        let bytes = serde_json::to_vec(&valid).unwrap();
        let request =
            parse_control_request(&auth(), wire("/__weapp/control/retire", &bytes, "")).unwrap();
        assert!(request.retained_capacity() <= MAX_CONTROL_RETIREMENT_BYTES);
        let WebControlRequest::Retire(request) = request else {
            panic!("expected retirement")
        };
        assert_eq!(request.lane, crate::browser_dev_control::Lane::Normal);
        assert_eq!(request.previous_through.get(), 0);
        assert_eq!(request.through_serial.get(), 7);
        assert_eq!(serde_json::to_value(request).unwrap(), valid);
        let source = String::from_utf8(wire("/__weapp/control/retire", &bytes, "")).unwrap();
        for (good, bad) in [
            (
                "X-Weapp-Dev-Secret: secret-test",
                "X-Weapp-Dev-Secret: wrong-secret",
            ),
            ("X-Weapp-Run-Id: run-test", "X-Weapp-Run-Id: other-run"),
            (
                "X-Weapp-Client-Id: client-test",
                "X-Weapp-Client-Id: other-client",
            ),
            (
                "Origin: http://127.0.0.1:58730",
                "Origin: http://elsewhere.example",
            ),
            ("Host: 127.0.0.1:58730", "Host: 127.0.0.1:58731"),
        ] {
            rejected(
                source.replace(good, bad).into_bytes(),
                ControlHttpError::Denied,
            );
        }
    }

    #[test]
    fn retirement_rejects_noncanonical_unknown_duplicate_and_oversized_fields() {
        let valid = json!({
            "version": "1.0", "lane": "normal", "previousThrough": "0",
            "throughSerial": "7", "prefixSha256": "a".repeat(64)
        });
        for (key, value) in [
            ("version", json!("2.0")),
            ("lane", json!("control")),
            ("previousThrough", json!("01")),
            ("previousThrough", json!("7")),
            ("throughSerial", json!(0)),
            ("throughSerial", json!("0")),
            ("throughSerial", json!("18446744073709551616")),
            ("prefixSha256", json!("A".repeat(64))),
            ("prefixSha256", json!("a".repeat(63))),
            ("requestId", json!("client-test:control-1")),
        ] {
            let mut bad = valid.clone();
            bad[key] = value;
            rejected(
                wire(
                    "/__weapp/control/retire",
                    &serde_json::to_vec(&bad).unwrap(),
                    "",
                ),
                ControlHttpError::InvalidRetirement,
            );
        }
        let duplicate = format!(
            r#"{{"version":"1.0","lane":"normal","previousThrough":"0","throughSerial":"7","throughSerial":"8","prefixSha256":"{}"}}"#,
            "a".repeat(64)
        );
        rejected(
            wire("/__weapp/control/retire", duplicate.as_bytes(), ""),
            ControlHttpError::InvalidRetirement,
        );
        let oversized = wire(
            "/__weapp/control/retire",
            &vec![b' '; MAX_CONTROL_RETIREMENT_BYTES + 1],
            "",
        );
        let body_start = oversized
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
            .unwrap()
            + 4;
        assert_eq!(
            inspect_control_frame(&auth(), &oversized[..body_start]),
            Err(ControlHttpError::TooLarge)
        );
    }

    #[test]
    fn retirement_bootstrap_is_explicit_and_preserves_ordinary_shape() {
        let preview = PreviewLease {
            version: "1.0".into(),
            run_id: "run-test".into(),
            preview_id: "preview-test".into(),
            lease_revision: crate::browser_dev_coordinator::WireU64::new(1),
        };
        let ordinary: serde_json::Value =
            serde_json::from_str(&auth().browser_dev_bootstrap_json(&preview).unwrap()).unwrap();
        let negotiated: serde_json::Value = serde_json::from_str(
            &auth()
                .browser_dev_bootstrap_json_with_retirement(&preview)
                .unwrap(),
        )
        .unwrap();
        assert!(ordinary["bootstrap"].get("retirementVersion").is_none());
        assert_eq!(negotiated["bootstrap"]["retirementVersion"], "1.0");
        let mut stripped = negotiated;
        stripped["bootstrap"]
            .as_object_mut()
            .unwrap()
            .remove("retirementVersion");
        assert_eq!(stripped, ordinary);
        assert!(ordinary.get("retirementVersion").is_none());
    }

    #[test]
    fn observation_is_versioned_authenticated_and_retains_no_command_bytes() {
        let body = br#"{ "version" : "1.0" }"#;
        let request =
            parse_control_request(&auth(), wire("/__weapp/control/observe", body, "")).unwrap();
        assert!(matches!(request, WebControlRequest::Observe));
        assert_eq!(request.retained_capacity(), 0);
        let source = String::from_utf8(wire("/__weapp/control/observe", body, "")).unwrap();
        for (good, bad) in [
            ("Host: 127.0.0.1:58730", "Host: other.invalid"),
            ("Origin: http://127.0.0.1:58730", "Origin: null"),
            ("X-Weapp-Run-Id: run-test", "X-Weapp-Run-Id: other-run"),
            (
                "X-Weapp-Client-Id: client-test",
                "X-Weapp-Client-Id: other-client",
            ),
            (
                "X-Weapp-Dev-Secret: secret-test",
                "X-Weapp-Dev-Secret: wrong-secret",
            ),
        ] {
            rejected(
                source.replace(good, bad).into_bytes(),
                ControlHttpError::Denied,
            );
        }
    }
    #[test]
    fn observation_rejects_mutation_fields_duplicates_versions_and_oversize() {
        for body in [
            "{}",
            r#"{"version":"2.0"}"#,
            r#"{"version":"1.0","command":"stop"}"#,
            r#"{"version":"1.0","requestId":"client-test:control-1"}"#,
            r#"{"version":"1.0","version":"1.0"}"#,
            r#"{"version":"1.0"}{}"#,
        ] {
            rejected(
                wire("/__weapp/control/observe", body.as_bytes(), ""),
                ControlHttpError::InvalidFraming,
            );
        }
        let oversized = String::from_utf8(wire("/__weapp/control/observe", b"", ""))
            .unwrap()
            .replace(
                "Content-Length: 0",
                &format!(
                    "Content-Length: {}",
                    MAX_CONTROL_OBSERVATION_REQUEST_BYTES + 1
                ),
            );
        // Reject the declared bound before waiting for any request body.
        rejected(oversized.into_bytes(), ControlHttpError::TooLarge);
        let good = wire("/__weapp/control/observe", br#"{"version":"1.0"}"#, "");
        assert_eq!(
            inspect_control_frame(&auth(), &good[..good.len() - 1]),
            Ok(ControlFrameProgress::Incomplete)
        );
        rejected(
            String::from_utf8(good)
                .unwrap()
                .replacen("POST ", "GET ", 1)
                .into_bytes(),
            ControlHttpError::UnsupportedMethod,
        );
    }
    #[test]
    fn fragments_require_complete_framing_without_mutating_auth_or_admitting_work() {
        let bytes = wire("/__weapp/control/invoke", b"{}", "");
        for length in [0, 1, 30, bytes.len() - 1] {
            assert_eq!(
                inspect_control_frame(&auth(), &bytes[..length]),
                Ok(ControlFrameProgress::Incomplete)
            );
            rejected(bytes[..length].to_vec(), ControlHttpError::Incomplete);
        }
        assert_eq!(
            inspect_control_frame(&auth(), &bytes),
            Ok(ControlFrameProgress::Complete)
        );
    }
    #[test]
    fn rejects_duplicate_headers_including_case_changes() {
        for duplicate in [
            "host: 127.0.0.1:58730\r\n",
            "CONTENT-LENGTH: 2\r\n",
            "Origin: http://127.0.0.1:58730\r\n",
            "X-WEAPP-DEV-SECRET: secret-test\r\n",
            "Content-Type: application/json\r\n",
        ] {
            rejected(
                wire("/__weapp/control/invoke", b"{}", duplicate),
                ControlHttpError::InvalidFraming,
            );
        }
    }
    #[test]
    fn rejects_transfer_coding_upgrade_expect_folding_and_invalid_header_bytes() {
        for extra in [
            "Transfer-Encoding: chunked\r\n",
            "Transfer-Encoding: identity\r\n",
            "Trailer: X-End\r\n",
            "Expect: 100-continue\r\n",
            "Upgrade: websocket\r\n",
            " folded: value\r\n",
            "X-Other: bad\tvalue\r\n",
            "X-Other: bad\nvalue\r\n",
        ] {
            rejected(
                wire("/__weapp/control/invoke", b"{}", extra),
                ControlHttpError::InvalidFraming,
            );
        }
    }
    #[test]
    fn content_length_is_bounded_canonical_and_exact() {
        let source = String::from_utf8(wire("/__weapp/control/invoke", b"{}", "")).unwrap();
        for invalid in ["02", "+2", "2,2", "184467440737095516160"] {
            rejected(
                source
                    .replace("Content-Length: 2", &format!("Content-Length: {invalid}"))
                    .into_bytes(),
                ControlHttpError::InvalidFraming,
            );
        }
        let mut trailing = source.into_bytes();
        trailing.extend_from_slice(b"POST /other HTTP/1.1\r\n\r\n");
        rejected(trailing, ControlHttpError::InvalidFraming);
        let oversize = format!("Content-Length: {}", MAX_CONTROL_REQUEST_BYTES + 1);
        let header = String::from_utf8(wire("/__weapp/control/invoke", b"", ""))
            .unwrap()
            .replace("Content-Length: 0", &oversize);
        rejected(header.into_bytes(), ControlHttpError::TooLarge); // before waiting for body
        assert!(parse_control_request(
            &auth(),
            wire(
                "/__weapp/control/invoke",
                &vec![b'x'; MAX_CONTROL_REQUEST_BYTES],
                ""
            )
        )
        .is_ok());
    }
    #[test]
    fn endpoint_spelling_and_method_are_never_normalized() {
        for path in [
            "/__weapp/control/invoke?x=1",
            "/__weapp/control/%69nvoke",
            "/__weapp/control/invoke#x",
            "http://127.0.0.1:58730/__weapp/control/invoke",
            "/__weapp\\control/invoke",
        ] {
            rejected(wire(path, b"{}", ""), ControlHttpError::InvalidFraming);
        }
        rejected(
            wire("/__weapp/control/unknown", b"{}", ""),
            ControlHttpError::UnknownEndpoint,
        );
        let get = String::from_utf8(wire("/__weapp/control/invoke", b"{}", ""))
            .unwrap()
            .replacen("POST ", "GET ", 1);
        rejected(get.into_bytes(), ControlHttpError::UnsupportedMethod);
    }
    #[test]
    fn all_trusted_identity_fields_must_match_and_errors_do_not_echo_secrets() {
        let source = String::from_utf8(wire("/__weapp/control/invoke", b"{}", "")).unwrap();
        for (good, bad) in [
            ("Host: 127.0.0.1:58730", "Host: evil.invalid"),
            ("Origin: http://127.0.0.1:58730", "Origin: null"),
            ("X-Weapp-Run-Id: run-test", "X-Weapp-Run-Id: other-run"),
            (
                "X-Weapp-Client-Id: client-test",
                "X-Weapp-Client-Id: other-client",
            ),
            (
                "X-Weapp-Dev-Secret: secret-test",
                "X-Weapp-Dev-Secret: wrong-secret",
            ),
        ] {
            rejected(
                source.replace(good, bad).into_bytes(),
                ControlHttpError::Denied,
            );
            rejected(
                source.replace(&format!("{good}\r\n"), "").into_bytes(),
                ControlHttpError::Denied,
            );
        }
        assert!(!format!("{:?}", ControlHttpError::Denied).contains("secret-test"));
    }
    #[test]
    fn acknowledgement_preserves_original_request_and_exposes_no_mutation_authority() {
        let original = " {\"version\":\"1.0\",\"requestId\":\"client-test:control-1\",\"command\":\"snapshot\",\"payload\":{}}\n";
        let value =
            json!({"version":"1.0","originalRequest":original,"finalSha256":"a".repeat(64)});
        let bytes = serde_json::to_vec(&value).unwrap();
        let WebControlRequest::Acknowledge(ack) =
            parse_control_request(&auth(), wire("/__weapp/control/acknowledge", &bytes, ""))
                .unwrap()
        else {
            panic!("not ACK");
        };
        assert_eq!(ack.original_request_bytes(), original.as_bytes());
        assert_eq!(ack.final_sha256(), "a".repeat(64));
    }
    #[test]
    fn acknowledgement_rejects_unknown_duplicate_and_invalid_fields() {
        let good = json!({"version":"1.0","originalRequest":"{}","finalSha256":"a".repeat(64)});
        for (key, value) in [
            ("version", json!("2.0")),
            ("extra", json!(true)),
            ("finalSha256", json!("A".repeat(64))),
            ("finalSha256", json!("a".repeat(63))),
            ("originalRequest", json!("")),
            (
                "originalRequest",
                json!("x".repeat(MAX_CONTROL_REQUEST_BYTES + 1)),
            ),
        ] {
            let mut invalid = good.clone();
            invalid[key] = value;
            rejected(
                wire(
                    "/__weapp/control/acknowledge",
                    &serde_json::to_vec(&invalid).unwrap(),
                    "",
                ),
                ControlHttpError::InvalidAcknowledgement,
            );
        }
        let duplicate = format!("{{\"version\":\"1.0\",\"version\":\"1.0\",\"originalRequest\":\"{{}}\",\"finalSha256\":\"{}\"}}", "a".repeat(64));
        rejected(
            wire("/__weapp/control/acknowledge", duplicate.as_bytes(), ""),
            ControlHttpError::InvalidAcknowledgement,
        );
    }
    #[test]
    fn acknowledgement_escaped_body_has_an_independent_bound() {
        let original = "\\".repeat(MAX_CONTROL_REQUEST_BYTES);
        let ack = serde_json::to_vec(
            &json!({"version":"1.0","originalRequest":original,"finalSha256":"a".repeat(64)}),
        )
        .unwrap();
        assert!(ack.len() > MAX_CONTROL_REQUEST_BYTES && ack.len() <= MAX_CONTROL_ACK_BYTES);
        assert!(
            parse_control_request(&auth(), wire("/__weapp/control/acknowledge", &ack, "")).is_ok()
        );
        let header = String::from_utf8(wire("/__weapp/control/acknowledge", b"", ""))
            .unwrap()
            .replace(
                "Content-Length: 0",
                &format!("Content-Length: {}", MAX_CONTROL_ACK_BYTES + 1),
            );
        rejected(header.into_bytes(), ControlHttpError::TooLarge);
    }
    #[test]
    fn incomplete_header_is_bounded_and_content_type_is_checked() {
        rejected(
            vec![b'a'; MAX_CONTROL_HEADER_BYTES + 1],
            ControlHttpError::TooLarge,
        );
        let source = String::from_utf8(wire("/__weapp/control/invoke", b"{}", "")).unwrap();
        rejected(
            source
                .replace("application/json", "text/plain")
                .into_bytes(),
            ControlHttpError::InvalidFraming,
        );
        assert!(parse_control_request(
            &auth(),
            source
                .replace("application/json", "application/json; charset=utf-8")
                .into_bytes()
        )
        .is_ok());
    }
    #[test]
    fn trusted_context_requires_canonical_bound_host_and_identifiers() {
        for (run, client, secret, host, origin) in [
            (
                "",
                "client",
                "secret",
                "127.0.0.1:58730",
                "http://127.0.0.1:58730",
            ),
            (
                "run",
                "bad/client",
                "secret",
                "127.0.0.1:58730",
                "http://127.0.0.1:58730",
            ),
            (
                "run",
                "client",
                "bad secret",
                "127.0.0.1:58730",
                "http://127.0.0.1:58730",
            ),
            (
                "run",
                "client",
                "secret",
                "127.0.0.1:0",
                "http://127.0.0.1:0",
            ),
            (
                "run",
                "client",
                "secret",
                "127.0.0.1:58730",
                "http://evil.invalid",
            ),
        ] {
            assert!(matches!(
                ControlHttpAuth::new(
                    run.into(),
                    client.into(),
                    secret.into(),
                    host.into(),
                    origin.into()
                ),
                Err(ControlHttpError::InvalidContext)
            ));
        }
        assert!(ControlHttpAuth::new(
            "run".into(),
            "client".into(),
            "secret".into(),
            "[::1]:58730".into(),
            "http://[::1]:58730".into()
        )
        .is_ok());
    }

    #[test]
    fn default_ports_use_browser_canonical_authority_for_ipv4_and_ipv6() {
        for (host, origin, browser_host, address, is_http) in [
            (
                "127.0.0.1:80",
                "http://127.0.0.1",
                "127.0.0.1",
                "127.0.0.1:80",
                true,
            ),
            (
                "127.0.0.1",
                "http://127.0.0.1",
                "127.0.0.1",
                "127.0.0.1:80",
                true,
            ),
            ("[::1]:80", "http://[::1]", "[::1]", "[::1]:80", true),
            ("[::1]", "http://[::1]", "[::1]", "[::1]:80", true),
            (
                "127.0.0.1:443",
                "https://127.0.0.1",
                "127.0.0.1",
                "127.0.0.1:443",
                false,
            ),
            (
                "127.0.0.1",
                "https://127.0.0.1",
                "127.0.0.1",
                "127.0.0.1:443",
                false,
            ),
            ("[::1]:443", "https://[::1]", "[::1]", "[::1]:443", false),
            ("[::1]", "https://[::1]", "[::1]", "[::1]:443", false),
            (
                "127.0.0.1:443",
                "http://127.0.0.1:443",
                "127.0.0.1:443",
                "127.0.0.1:443",
                true,
            ),
            (
                "[::1]:443",
                "http://[::1]:443",
                "[::1]:443",
                "[::1]:443",
                true,
            ),
            (
                "127.0.0.1:80",
                "https://127.0.0.1:80",
                "127.0.0.1:80",
                "127.0.0.1:80",
                false,
            ),
            (
                "[::1]:80",
                "https://[::1]:80",
                "[::1]:80",
                "[::1]:80",
                false,
            ),
        ] {
            let context = ControlHttpAuth::new(
                "run-test".into(),
                "client-test".into(),
                "secret-test".into(),
                host.into(),
                origin.into(),
            )
            .unwrap();
            let bytes = String::from_utf8(wire("/__weapp/control/invoke", b"{}", ""))
                .unwrap()
                .replace("Host: 127.0.0.1:58730", &format!("Host: {browser_host}"))
                .replace(
                    "Origin: http://127.0.0.1:58730",
                    &format!("Origin: {origin}"),
                );
            assert!(
                parse_control_request(&context, bytes.into_bytes()).is_ok(),
                "{host} {origin}"
            );
            assert_eq!(
                context.matches_local_http(address.parse().unwrap()),
                is_http
            );
            assert!(!context.matches_local_http("127.0.0.2:80".parse().unwrap()));
            assert!(!context.matches_local_http("[::1]:58730".parse().unwrap()));
        }
    }

    #[test]
    fn default_port_aliases_are_rejected_in_requests_and_trusted_origins() {
        for (host, origin, explicit_origin) in [
            ("127.0.0.1:80", "http://127.0.0.1", "http://127.0.0.1:80"),
            ("[::1]:80", "http://[::1]", "http://[::1]:80"),
            (
                "127.0.0.1:443",
                "https://127.0.0.1",
                "https://127.0.0.1:443",
            ),
            ("[::1]:443", "https://[::1]", "https://[::1]:443"),
        ] {
            assert!(matches!(
                ControlHttpAuth::new(
                    "run-test".into(),
                    "client-test".into(),
                    "secret-test".into(),
                    host.into(),
                    explicit_origin.into()
                ),
                Err(ControlHttpError::InvalidContext)
            ));
            let context = ControlHttpAuth::new(
                "run-test".into(),
                "client-test".into(),
                "secret-test".into(),
                host.into(),
                origin.into(),
            )
            .unwrap();
            let canonical = String::from_utf8(wire("/__weapp/control/invoke", b"{}", ""))
                .unwrap()
                .replace("Host: 127.0.0.1:58730", &format!("Host: {}", context.host))
                .replace(
                    "Origin: http://127.0.0.1:58730",
                    &format!("Origin: {origin}"),
                );
            for invalid in [
                canonical.replace(
                    &format!("Host: {}\r\n", context.host),
                    &format!("Host: {host}\r\n"),
                ),
                canonical.replace(
                    &format!("Origin: {origin}\r\n"),
                    &format!("Origin: {explicit_origin}\r\n"),
                ),
            ] {
                assert!(matches!(
                    parse_control_request(&context, invalid.into_bytes()),
                    Err(ControlHttpError::Denied)
                ));
            }
        }
        for (host, origin) in [
            ("127.0.0.1:443", "http://127.0.0.1"),
            ("[::1]:80", "https://[::1]"),
            ("127.000.000.001:80", "http://127.0.0.1"),
            ("[0:0:0:0:0:0:0:1]:80", "http://[::1]"),
            ("::1", "http://[::1]"),
            ("localhost:80", "http://localhost"),
        ] {
            assert!(matches!(
                ControlHttpAuth::new(
                    "run-test".into(),
                    "client-test".into(),
                    "secret-test".into(),
                    host.into(),
                    origin.into()
                ),
                Err(ControlHttpError::InvalidContext)
            ));
        }
    }

    #[test]
    fn plain_http_surface_requires_the_exact_latched_socket_and_scheme() {
        let context = auth();
        assert!(context.matches_local_http("127.0.0.1:58730".parse().unwrap()));
        for address in [
            "127.0.0.1:58731",
            "127.0.0.2:58730",
            "[::ffff:127.0.0.1]:58730",
            "[::1]:58730",
        ] {
            assert!(!context.matches_local_http(address.parse().unwrap()));
        }
        let tls = ControlHttpAuth::new(
            "run-test".into(),
            "client-test".into(),
            "secret-test".into(),
            "127.0.0.1:58730".into(),
            "https://127.0.0.1:58730".into(),
        )
        .unwrap();
        assert!(!tls.matches_local_http("127.0.0.1:58730".parse().unwrap()));
    }

    #[test]
    fn retained_capacity_accounts_for_the_original_wire_or_ack_owned_strings() {
        let mut bytes = wire("/__weapp/control/invoke", b"{}", "");
        bytes.reserve_exact(8192);
        let capacity = bytes.capacity();
        let request = parse_control_request(&auth(), bytes).unwrap();
        assert_eq!(request.retained_capacity(), capacity);
        let WebControlRequest::Invoke(retained) = request else {
            panic!("not invoke");
        };
        assert_eq!(retained.retained_capacity(), capacity);

        let original = " {\"requestId\":\"client-test:control-1\"}\n";
        let value =
            json!({"version":"1.0","originalRequest":original,"finalSha256":"a".repeat(64)});
        let body = serde_json::to_vec(&value).unwrap();
        let request =
            parse_control_request(&auth(), wire("/__weapp/control/acknowledge", &body, ""))
                .unwrap();
        let retained_capacity = request.retained_capacity();
        let WebControlRequest::Acknowledge(ack) = request else {
            panic!("not ACK");
        };
        assert_eq!(
            retained_capacity,
            ack.version.capacity() + ack.original_request.capacity() + ack.final_sha256.capacity()
        );
        assert!(retained_capacity >= "1.0".len() + original.len() + 64);
    }
}
