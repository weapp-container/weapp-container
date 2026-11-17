//! Strict, immutable resource HTTP projection. This module never opens a file,
//! creates a runtime, or grants publication/Worker/presenter authority.

use crate::browser_dev_coordinator::WireU64;
use crate::dev::{BrowserRuntimeResource, BrowserStageResource};

pub(super) const MAX_RESOURCE_HEADER_BYTES: usize = 16 * 1024;
const MAX_RESOURCE_PATH_BYTES: usize = 2048;

/// A canonical URL identity. The owner must still match retained immutable
/// identities before consulting its original allowlisted resource store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WebResourceTarget {
    Runtime {
        bundle_sha256: String,
        path: String,
    },
    Pack {
        run_id: String,
        site_id: WireU64,
        path: String,
    },
    Site {
        run_id: String,
        site_id: WireU64,
    },
}

impl WebResourceTarget {
    pub(super) fn content_type(&self) -> &'static str {
        match self {
            Self::Site { .. } => "application/json",
            Self::Pack { path, .. } => {
                if path.ends_with(".json") {
                    "application/json"
                } else {
                    "application/octet-stream"
                }
            }
            Self::Runtime { path, .. } => match path.rsplit('.').next() {
                Some("js" | "mjs") => "text/javascript; charset=utf-8",
                Some("json") => "application/json",
                Some("wasm") => "application/wasm",
                Some("css") => "text/css; charset=utf-8",
                Some("ttf") => "font/ttf",
                Some("woff2") => "font/woff2",
                Some("txt") => "text/plain; charset=utf-8",
                _ => "application/octet-stream",
            },
        }
    }

    pub(super) fn accepts(&self, body: &WebResourceBody) -> bool {
        matches!(
            (self, body),
            (Self::Runtime { .. }, WebResourceBody::Runtime(_))
                | (
                    Self::Pack { .. } | Self::Site { .. },
                    WebResourceBody::Stage(_)
                )
        )
    }
}

/// Owns the original non-Clone store borrower through the actual HTTP write.
/// Its payload keeps the SAME runtime/stage charge; HTTP adds only a header.
#[derive(Debug)]
pub enum WebResourceBody {
    Runtime(BrowserRuntimeResource),
    Stage(BrowserStageResource),
}

impl WebResourceBody {
    pub(super) fn bytes(&self) -> &[u8] {
        match self {
            Self::Runtime(body) => body.bytes(),
            Self::Stage(body) => body.bytes(),
        }
    }
}

/// Fixed public outcomes keep internal errors and filesystem paths off HTTP.
/// Log a full lookup failure locally before returning `Unavailable`.
#[derive(Debug)]
pub enum WebResourceResolution {
    Found(WebResourceBody),
    NotFound,
    Denied,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ResourceRequestError {
    BadRequest,
    MethodNotAllowed,
    NotFound,
    Denied,
    TooLarge,
    Unavailable,
}

impl ResourceRequestError {
    pub(super) fn status(self) -> u16 {
        match self {
            Self::BadRequest => 400,
            Self::MethodNotAllowed => 405,
            Self::NotFound => 404,
            Self::Denied => 403,
            Self::TooLarge => 413,
            Self::Unavailable => 503,
        }
    }

    pub(super) fn body(self) -> &'static [u8] {
        match self {
            Self::BadRequest => br#"{"error":"invalid resource request"}"#,
            Self::MethodNotAllowed => br#"{"error":"resource requires GET"}"#,
            Self::NotFound => br#"{"error":"resource not found"}"#,
            Self::Denied => br#"{"error":"resource denied"}"#,
            Self::TooLarge => br#"{"error":"resource request too large"}"#,
            Self::Unavailable => br#"{"error":"resource unavailable"}"#,
        }
    }
}

/// Parse the ORIGINAL header bytes, before legacy query/framing handling.
/// `trailing_bytes` counts all bytes already received after CRLF CRLF; no GET
/// body or pipelined request may be silently discarded. Later TCP bytes are
/// not predicted: every response closes its one request connection.
pub(super) fn parse_request(
    headers: &[u8],
    trailing_bytes: usize,
) -> Result<WebResourceTarget, ResourceRequestError> {
    parse_target(parse_get_request(headers, trailing_bytes)?.target)
}

/// Borrow the validated request spelling without interpreting any endpoint.
/// Resource and opt-in development UI routing share this one framing parser.
pub(super) struct ParsedGetRequest<'a> {
    pub(super) target: &'a str,
    pub(super) host: &'a str,
}

pub(super) fn parse_get_request(
    headers: &[u8],
    trailing_bytes: usize,
) -> Result<ParsedGetRequest<'_>, ResourceRequestError> {
    use ResourceRequestError::{BadRequest, MethodNotAllowed};
    if headers.len().saturating_add(4) > MAX_RESOURCE_HEADER_BYTES || trailing_bytes != 0 {
        return Err(BadRequest);
    }
    let text = std::str::from_utf8(headers).map_err(|_| BadRequest)?;
    if !text.is_ascii() {
        return Err(BadRequest);
    }
    let mut lines = text.split("\r\n");
    let first = lines.next().ok_or(BadRequest)?;
    let mut words = first.split(' ');
    let method = words.next().ok_or(BadRequest)?;
    let target = words.next().ok_or(BadRequest)?;
    if words.next() != Some("HTTP/1.1") || words.next().is_some() {
        return Err(BadRequest);
    }
    if method != "GET" {
        return Err(MethodNotAllowed);
    }
    let mut host = None;
    let mut content_length = false;
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(BadRequest)?;
        if name.is_empty() || !name.bytes().all(header_name_byte) {
            return Err(BadRequest);
        }
        if !value
            .bytes()
            .all(|b| b == b'\t' || (b' '..=b'~').contains(&b))
        {
            return Err(BadRequest);
        }
        let value = value.trim_matches([' ', '\t']);
        if name.eq_ignore_ascii_case("host") {
            if host.is_some()
                || value.is_empty()
                || value
                    .bytes()
                    .any(|b| b.is_ascii_whitespace() || b"/\\@?#,".contains(&b))
            {
                return Err(BadRequest);
            }
            host = Some(value);
        } else if name.eq_ignore_ascii_case("content-length") {
            if content_length || value != "0" {
                return Err(BadRequest);
            }
            content_length = true;
        } else if name.eq_ignore_ascii_case("transfer-encoding")
            || name.eq_ignore_ascii_case("expect")
            || name.eq_ignore_ascii_case("upgrade")
        {
            return Err(BadRequest);
        }
    }
    Ok(ParsedGetRequest {
        target,
        host: host.ok_or(BadRequest)?,
    })
}

fn header_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte)
}

fn canonical_path(path: &str) -> bool {
    !path.is_empty()
        && path.split('/').all(|segment| {
            !segment.is_empty()
                && !matches!(segment, "." | "..")
                && segment
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-~:@".contains(&b))
        })
}

fn run_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}

fn site_id(value: &str) -> Option<WireU64> {
    let id = value.parse::<u64>().ok()?;
    (id != 0 && id.to_string() == value).then(|| WireU64::new(id))
}

pub(super) fn parse_target(target: &str) -> Result<WebResourceTarget, ResourceRequestError> {
    use ResourceRequestError::{BadRequest, NotFound};
    if !target.starts_with('/')
        || target.len() > MAX_RESOURCE_PATH_BYTES + 256
        || !canonical_path(&target[1..])
    {
        return Err(BadRequest);
    }
    if let Some(rest) = target.strip_prefix("/__weapp/runtime/") {
        let (bundle, path) = rest.split_once('/').ok_or(BadRequest)?;
        if !container_ir::is_sha256(bundle)
            || path.len() > MAX_RESOURCE_PATH_BYTES
            || !canonical_path(path)
        {
            return Err(BadRequest);
        }
        return Ok(WebResourceTarget::Runtime {
            bundle_sha256: bundle.to_owned(),
            path: path.to_owned(),
        });
    }
    let (site, rest) = if let Some(rest) = target.strip_prefix("/__weapp/pack/") {
        (false, rest)
    } else if let Some(rest) = target.strip_prefix("/__weapp/site/") {
        (true, rest)
    } else {
        return Err(NotFound);
    };
    let mut parts = rest.splitn(3, '/');
    let run = parts.next().ok_or(BadRequest)?;
    let id = site_id(parts.next().ok_or(BadRequest)?).ok_or(BadRequest)?;
    let path = parts.next().ok_or(BadRequest)?;
    if !run_id(run) || path.len() > MAX_RESOURCE_PATH_BYTES || !canonical_path(path) {
        return Err(BadRequest);
    }
    if site {
        if path != "site.json" {
            return Err(NotFound);
        }
        return Ok(WebResourceTarget::Site {
            run_id: run.to_owned(),
            site_id: id,
        });
    }
    let allowed = matches!(
        path,
        "pack-index.json" | "worker-product-config.json" | "portable-pack/manifest.json"
    ) || path
        .strip_prefix("portable-pack/blobs/sha256/")
        .is_some_and(container_ir::is_sha256);
    if !allowed {
        return Err(NotFound);
    }
    Ok(WebResourceTarget::Pack {
        run_id: run.to_owned(),
        site_id: id,
        path: path.to_owned(),
    })
}

/// Resource-only responses intentionally have no wildcard CORS. The fixed
/// status/MIME arguments never contain a request-provided header value.
pub(super) fn response_header(status: u16, mime: &'static str, length: usize) -> Vec<u8> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        503 => "Service Unavailable",
        _ => "Response",
    };
    let allow = if status == 405 { "Allow: GET\r\n" } else { "" };
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {length}\r\nConnection: close\r\nCache-Control: no-store\r\nCross-Origin-Resource-Policy: same-origin\r\nX-Content-Type-Options: nosniff\r\n{allow}\r\n"
    ).into_bytes()
}
