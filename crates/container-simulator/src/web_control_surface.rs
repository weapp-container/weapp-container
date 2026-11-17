//! Owner-lane projection of strict control HTTP. No owner, ledger or Worker is
//! created here; only the caller's one existing owner may resolve these requests.

use super::*;
use crate::browser_dev_control::{MAX_CONTROL_FINAL_BYTES, MAX_CONTROL_RETIREMENT_BYTES};
use crate::web_control::{
    inspect_control_frame, parse_control_request, ControlFrameProgress, ControlHttpAuth,
    ControlHttpError, WebControlRequest, WebControlResponse, MAX_CONTROL_ACK_BYTES,
    MAX_CONTROL_HEADER_BYTES,
};

pub(super) const MAX_CONTROL_WIRE_BYTES: usize = MAX_CONTROL_HEADER_BYTES + MAX_CONTROL_ACK_BYTES;
// Admission reserves the original wire allocation, ACK decode scratch and
// retained strings. The reservation is deliberately conservative, not heap RSS.
// The existing 64-connection cap bounds these reservations, including partial
// headers. A final payload remains charged to the caller's ORIGINAL ledger.
const CONTROL_REQUEST_RESERVATION: usize = 4 * MAX_CONTROL_WIRE_BYTES;
const MAX_ACK_REPLY_BYTES: usize = 4096;

pub(super) struct PendingControlRequest {
    pub(super) stream: TcpStream,
    pub(super) request: WebControlRequest,
    pub(super) accepted_at: Instant,
}

/// Counts actual sockets on this surface, never browser/Worker resources.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WebSurfaceDrainStatus {
    pub accepting: bool,
    pub reading: usize,
    pub owner_resources: usize,
    pub owner_controls: usize,
    pub writing: usize,
    pub event_streams: usize,
    /// Conservative reservation for partial/queued control transport requests,
    /// including transient ACK decode space. This is not a process RSS measure.
    pub control_request_reserved_bytes: usize,
}

impl WebSurfaceDrainStatus {
    /// The listener stays bound until WebSurface is dropped. A drained surface
    /// proves only that its accepted sockets have gone, not delivery or close.
    pub fn is_drained(self) -> bool {
        !self.accepting
            && self.reading == 0
            && self.owner_resources == 0
            && self.owner_controls == 0
            && self.writing == 0
            && self.event_streams == 0
    }
}

pub(super) fn is_control_namespace(wire: &[u8]) -> bool {
    // Classification only: never normalize this into a permitted endpoint.
    // Include absolute/malformed targets and unsupported methods so they cannot
    // acquire a wildcard OPTIONS response from the legacy simulator router.
    // A split "/__weapp/run" may still become the valid "/runtime/" GET
    // namespace. Do not infer an unknown target from a partial request line.
    let Some(line_end) = wire.iter().position(|byte| *byte == b'\n') else {
        return false;
    };
    let first_line = &wire[..line_end];
    let Some(start) = find_bytes(first_line, b"/__weapp") else {
        return false;
    };
    let target = &first_line[start..];
    // Only the three existing immutable resource namespaces may enter the GET
    // parser. Unknown/escaped control spellings remain strictly reserved too.
    ![
        b"/__weapp/runtime/".as_slice(),
        b"/__weapp/pack/",
        b"/__weapp/site/",
    ]
    .iter()
    .any(|prefix| target.starts_with(prefix))
}

impl WebSurface {
    /// Opt in ONCE, before accepting any sockets, on the resource-only surface.
    /// The trusted local owner supplies the elected identities and secret; no
    /// URL/body/header chooses a ledger. The context survives stop/cleanup.
    pub fn enable_control(&mut self, auth: ControlHttpAuth) -> Result<(), ControlHttpError> {
        if !self.resource_only
            || !self.accepting
            || self.has_accepted
            || self.control_auth.is_some()
            || !auth.matches_local_http(self.addr)
            || self.drain_status().reading != 0
            || !self.pending_resource_requests.is_empty()
            || !self.pending_control_requests.is_empty()
            || !self.pending_responses.is_empty()
            || !self.clients.is_empty()
        {
            return Err(ControlHttpError::InvalidContext);
        }
        self.control_auth = Some(auth);
        Ok(())
    }

    /// Resolve authenticated requests synchronously on the original owner's
    /// thread. Invoke/replay pass exact wire body bytes. ACK must call the
    /// original ledger's acknowledge_final DIRECTLY, without a lookup borrower.
    /// A resolver response is not a successful Worker close or present receipt.
    pub fn resolve_control_requests(
        &mut self,
        mut resolve: impl FnMut(&ControlHttpAuth, &WebControlRequest) -> WebControlResponse,
    ) -> io::Result<usize> {
        let mut resolved = 0;
        while let Some(pending) = self.pending_control_requests.pop_front() {
            if pending.accepted_at.elapsed() >= HTTP_DEADLINE {
                continue;
            }
            let response = resolve(
                self.control_auth
                    .as_ref()
                    .expect("only authenticated requests queue"),
                &pending.request,
            );
            resolved += 1;
            // Never refresh the acceptance deadline after synchronous work.
            if pending.accepted_at.elapsed() >= HTTP_DEADLINE {
                drop(response);
                continue;
            }
            let result = match response {
                WebControlResponse::Final(bytes) if bytes.len() <= MAX_CONTROL_FINAL_BYTES => {
                    self.queue_control_body(&pending.stream, bytes, pending.accepted_at)
                }
                WebControlResponse::Final(_) => self.queue_control_error(
                    &pending.stream,
                    ControlHttpError::Unavailable,
                    pending.accepted_at,
                ),
                WebControlResponse::Acknowledged(receipt) => {
                    // Bound the writer itself; an invalid owner reply cannot
                    // create a large temporary JSON allocation before rejection.
                    let mut bytes = [0_u8; MAX_ACK_REPLY_BYTES];
                    let mut writer = io::Cursor::new(bytes.as_mut_slice());
                    match serde_json::to_writer(&mut writer, &receipt) {
                        Ok(()) => {
                            let length = writer.position() as usize;
                            self.queue_control_small(
                                &pending.stream,
                                200,
                                &bytes[..length],
                                pending.accepted_at,
                            )
                        }
                        Err(_) => self.queue_control_error(
                            &pending.stream,
                            ControlHttpError::Unavailable,
                            pending.accepted_at,
                        ),
                    }
                }
                WebControlResponse::Retired(receipt) => {
                    let mut bytes = [0_u8; MAX_CONTROL_RETIREMENT_BYTES];
                    let mut writer = io::Cursor::new(bytes.as_mut_slice());
                    match serde_json::to_writer(&mut writer, &receipt) {
                        Ok(()) => {
                            let length = writer.position() as usize;
                            self.queue_control_small(
                                &pending.stream,
                                200,
                                &bytes[..length],
                                pending.accepted_at,
                            )
                        }
                        Err(_) => self.queue_control_error(
                            &pending.stream,
                            ControlHttpError::Unavailable,
                            pending.accepted_at,
                        ),
                    }
                }
                WebControlResponse::Observation(snapshot) => {
                    // A read-only projection has no original ledger payload
                    // charge. Bound encoding BEFORE allocation can grow, and
                    // enqueue it through the shared HTTP response budget rather
                    // than the special uncharged Arc-final borrower path.
                    let mut bytes = vec![0_u8; MAX_CONTROL_FINAL_BYTES];
                    let mut writer = io::Cursor::new(bytes.as_mut_slice());
                    match serde_json::to_writer(&mut writer, &snapshot) {
                        Ok(()) => {
                            let length = writer.position() as usize;
                            self.queue_control_small(
                                &pending.stream,
                                200,
                                &bytes[..length],
                                pending.accepted_at,
                            )
                        }
                        Err(_) => self.queue_control_error(
                            &pending.stream,
                            ControlHttpError::Unavailable,
                            pending.accepted_at,
                        ),
                    }
                }
                WebControlResponse::Refused(error) => {
                    self.queue_control_error(&pending.stream, error, pending.accepted_at)
                }
            };
            match result {
                Err(error) if is_client_disconnect(&error) => {}
                Err(error) => return Err(error),
                Ok(()) => {}
            }
        }
        Ok(resolved)
    }

    /// Stop accepting new sockets. Existing reads, owner requests and writes
    /// retain their original deadlines and can still be resolved/polled. The
    /// listener's port is released by dropping this exact surface after drain.
    pub fn stop_admission(&mut self) {
        self.accepting = false;
    }

    pub fn drain_status(&self) -> WebSurfaceDrainStatus {
        WebSurfaceDrainStatus {
            accepting: self.accepting,
            reading: self.pending_requests.len(),
            owner_resources: self.pending_resource_requests.len(),
            owner_controls: self.pending_control_requests.len(),
            writing: self.pending_responses.len(),
            event_streams: self.clients.len(),
            control_request_reserved_bytes: if self.control_auth.is_some() {
                (self.pending_requests.len() + self.pending_control_requests.len())
                    * CONTROL_REQUEST_RESERVATION
            } else {
                0
            },
        }
    }

    pub(super) fn process_control_request(
        &mut self,
        mut pending: PendingRequest,
    ) -> io::Result<Option<PendingRequest>> {
        let Some(auth) = self.control_auth.as_ref() else {
            self.queue_control_error(
                &pending.stream,
                ControlHttpError::Denied,
                pending.accepted_at,
            )?;
            return Ok(None);
        };
        let mut chunk = [0_u8; 8192];
        loop {
            match inspect_control_frame(auth, &pending.buffer) {
                Ok(ControlFrameProgress::Complete) => {
                    match parse_control_request(auth, pending.buffer) {
                        Ok(request) => {
                            self.pending_control_requests
                                .push_back(PendingControlRequest {
                                    stream: pending.stream,
                                    request,
                                    accepted_at: pending.accepted_at,
                                })
                        }
                        Err(error) => {
                            self.queue_control_error(&pending.stream, error, pending.accepted_at)?
                        }
                    }
                    return Ok(None);
                }
                Err(error) => {
                    self.queue_control_error(&pending.stream, error, pending.accepted_at)?;
                    return Ok(None);
                }
                Ok(ControlFrameProgress::Incomplete) => {}
            }
            match pending.stream.read(&mut chunk) {
                Ok(0) => return Ok(None),
                Ok(length) => {
                    if pending.buffer.len().saturating_add(length) > MAX_CONTROL_WIRE_BYTES {
                        self.queue_control_error(
                            &pending.stream,
                            ControlHttpError::TooLarge,
                            pending.accepted_at,
                        )?;
                        return Ok(None);
                    }
                    pending.buffer.extend_from_slice(&chunk[..length]);
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => return Ok(Some(pending)),
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
    }

    fn queue_control_body(
        &mut self,
        stream: &TcpStream,
        bytes: Arc<Vec<u8>>,
        accepted_at: Instant,
    ) -> io::Result<()> {
        let header = Arc::new(control_header(200, bytes.len()));
        {
            let mut shared = self
                .shared
                .lock()
                .map_err(|_| io::Error::other("Web surface unavailable"))?;
            if shared.ensure_frame_capacity(0, 0, header.len()).is_err() {
                drop(shared);
                drop(bytes);
                return self.queue_control_error(
                    stream,
                    ControlHttpError::Unavailable,
                    accepted_at,
                );
            }
            // Do not track/copy/reencode the final: its sole charge and Arc
            // originate in ControlLedger, and ACK must see this actual borrower.
            shared.track_response(&header);
        }
        let stream = stream.try_clone()?;
        stream.set_nonblocking(true)?;
        self.pending_responses.push(PendingResponse {
            stream,
            header: Some(header),
            header_offset: 0,
            body: ResponseBody::Control(bytes),
            offset: 0,
            queued_at: accepted_at,
        });
        Ok(())
    }

    fn queue_control_small(
        &mut self,
        stream: &TcpStream,
        status: u16,
        body: &[u8],
        accepted_at: Instant,
    ) -> io::Result<()> {
        let mut bytes = control_header(status, body.len());
        bytes.extend_from_slice(body);
        if self
            .shared
            .lock()
            .map_err(|_| io::Error::other("Web surface unavailable"))?
            .ensure_frame_capacity(0, 0, bytes.len())
            .is_err()
        {
            return Ok(());
        }
        self.queue_shared_response_bytes_at(stream, Arc::new(bytes), accepted_at)
    }

    fn queue_control_error(
        &mut self,
        stream: &TcpStream,
        error: ControlHttpError,
        accepted_at: Instant,
    ) -> io::Result<()> {
        let (status, body): (u16, &[u8]) = match error {
            ControlHttpError::Denied => (403, br#"{"error":"control denied"}"#),
            ControlHttpError::UnsupportedMethod => (405, br#"{"error":"control requires POST"}"#),
            ControlHttpError::UnknownEndpoint => {
                (404, br#"{"error":"control endpoint not found"}"#)
            }
            ControlHttpError::TooLarge => (413, br#"{"error":"control request too large"}"#),
            ControlHttpError::Unavailable => (503, br#"{"error":"control unavailable"}"#),
            _ => (400, br#"{"error":"invalid control request"}"#),
        };
        self.queue_control_small(stream, status, body, accepted_at)
    }
}

fn control_header(status: u16, length: usize) -> Vec<u8> {
    // Resource headers already have same-origin/CORP/nosniff/no-store and no
    // wildcard CORS. Their 405 Allow is GET, so replace that one fixed field.
    String::from_utf8(resources::response_header(
        status,
        "application/json",
        length,
    ))
    .expect("fixed ASCII HTTP header")
    .replace("Allow: GET\r\n", "Allow: POST\r\n")
    .into_bytes()
}
