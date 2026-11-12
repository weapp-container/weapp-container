use crate::{clock_now_ns, SdkError};
use container_runtime::{ProviderError, ProviderErrorCode};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE, SET_COOKIE},
    Client, Method, Url,
};
use serde_json::{json, Map, Value};
use std::{
    collections::BTreeMap,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};

const MAX_BODY: usize = 8 * 1024 * 1024;
pub(crate) struct Completion {
    pub call_id: String,
    pub result: Result<Value, ProviderError>,
}
#[derive(Debug)]
enum Command {
    Start {
        call_id: String,
        payload: Value,
        deadline_ns: Option<u64>,
    },
    #[cfg(test)]
    HoldWorker {
        release: mpsc::Receiver<()>,
        started: mpsc::Sender<()>,
    },
    #[cfg(test)]
    HoldDispatch {
        release: mpsc::Receiver<()>,
        started: mpsc::Sender<()>,
    },
}
struct Job {
    abort: Option<tokio::task::AbortHandle>,
    cancelled: bool,
    result: Option<Result<Value, ProviderError>>,
}
struct Shared {
    accepting: bool,
    jobs: BTreeMap<String, Job>,
}

/// One runtime owner, one client/connection pool and one executor. Cancellation
/// is not a drain receipt: only an exited worker proves that request futures,
/// pooled connections and the executor's internal network tasks were dropped.
pub(crate) struct HttpService {
    sender: Option<tokio::sync::mpsc::Sender<Command>>,
    shared: Arc<Mutex<Shared>>,
    worker: Option<thread::JoinHandle<()>>,
    retained: Arc<Mutex<Vec<Box<dyn Send>>>>,
}

impl HttpService {
    pub fn new() -> Result<Self, SdkError> {
        let (sender, mut incoming) = tokio::sync::mpsc::channel(128);
        let shared = Arc::new(Mutex::new(Shared {
            accepting: true,
            jobs: BTreeMap::new(),
        }));
        let pending = shared.clone();
        let retained = Arc::new(Mutex::new(Vec::<Box<dyn Send>>::new()));
        let worker_retained = retained.clone();
        let (ready, ready_result) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("weapp-http".into())
            .spawn(move || {
                // Last field of a revoked controller may disappear on the UI
                // thread. Keep its leases until this executor actually exits.
                let retained = worker_retained;
                let setup = (|| {
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()?;
                    let builder = Client::builder()
                        .redirect(reqwest::redirect::Policy::limited(10))
                        .connect_timeout(Duration::from_secs(15));
                    // Local TCP tests must observe this client's connections,
                    // rather than an inherited development-environment proxy.
                    #[cfg(test)]
                    let builder = builder.no_proxy();
                    let client = builder.build().map_err(std::io::Error::other)?;
                    Ok::<_, std::io::Error>((runtime, client))
                })();
                let (runtime, client) = match setup {
                    Ok(value) => {
                        let _ = ready.send(Ok(()));
                        value
                    }
                    Err(error) => {
                        let _ = ready.send(Err(error.to_string()));
                        return;
                    }
                };
                runtime.block_on(async move {
                    let mut tasks = tokio::task::JoinSet::new();
                    let mut task_calls = BTreeMap::new();
                    loop {
                        tokio::select! {
                            command = incoming.recv() => {
                                let (call_id, payload, deadline_ns) = match command {
                                    Some(Command::Start { call_id, payload, deadline_ns }) => (call_id, payload, deadline_ns),
                                    #[cfg(test)]
                                    Some(Command::HoldWorker { release, started }) => {
                                        tokio::task::spawn_blocking(move || {
                                            let _ = started.send(());
                                            let _ = release.recv();
                                        });
                                        continue;
                                    }
                                    #[cfg(test)]
                                    Some(Command::HoldDispatch { release, started }) => {
                                        let _ = started.send(());
                                        let _ = release.recv();
                                        continue;
                                    }
                                    None => break,
                                };
                                let mut state = pending.lock().unwrap_or_else(|p| p.into_inner());
                                if !state.accepting || state.jobs.get(&call_id).is_none_or(|job| job.cancelled) {
                                    state.jobs.remove(&call_id);
                                    continue;
                                }
                                let client = client.clone();
                                let task = tasks.spawn(async move {
                                    request(&client, payload, deadline_ns).await
                                });
                                task_calls.insert(task.id(), call_id.clone());
                                state.jobs.get_mut(&call_id).unwrap().abort = Some(task);
                            }
                            completed = tasks.join_next_with_id(), if !tasks.is_empty() => {
                                let completed = completed.unwrap();
                                let task_id = match &completed {
                                    Ok((id, _)) => *id,
                                    Err(error) => error.id(),
                                };
                                let call_id = task_calls.remove(&task_id).unwrap();
                                let mut state = pending.lock().unwrap_or_else(|p| p.into_inner());
                                if let Some(job) = state.jobs.get_mut(&call_id) {
                                    if job.cancelled {
                                        state.jobs.remove(&call_id);
                                    } else {
                                        job.abort = None;
                                        job.result = Some(match completed {
                                            Ok((_, result)) => result,
                                            Err(error) => Err(ProviderError::invalid(format!("HTTP worker failed: {error}"))),
                                        });
                                    }
                                }
                            }
                        }
                    }
                    // JoinSet owns the tasks all the way through cancellation.
                    // Dropping AbortHandles alone does not prove their futures
                    // have stopped touching the network.
                    tasks.abort_all();
                    while tasks.join_next().await.is_some() {}
                    pending.lock().unwrap_or_else(|p| p.into_inner()).jobs.clear();
                });
                // Dropping the dedicated runtime also drains blocking DNS and
                // destroys reqwest's internal connection tasks on this worker.
                drop(runtime);
                drop(retained);
            })
            .map_err(|e| SdkError::new("ERR_NETWORK", e))?;
        ready_result
            .recv()
            .map_err(|e| SdkError::new("ERR_NETWORK", e))?
            .map_err(|e| SdkError::new("ERR_NETWORK", e))?;
        Ok(Self {
            sender: Some(sender),
            shared,
            worker: Some(worker),
            retained,
        })
    }

    pub fn start(
        &self,
        call_id: String,
        payload: Value,
        deadline_ns: Option<u64>,
    ) -> Result<(), SdkError> {
        if serde_json::to_vec(&payload)
            .map_err(SdkError::invalid)?
            .len()
            > MAX_BODY
        {
            return Err(SdkError::invalid("HTTP request payload exceeds 8 MiB"));
        }
        let mut state = self
            .shared
            .lock()
            .map_err(|e| SdkError::new("ERR_NETWORK", e))?;
        let sender = self
            .sender
            .as_ref()
            .filter(|_| state.accepting)
            .ok_or_else(|| SdkError::new("ERR_NETWORK", "HTTP worker closed"))?;
        if state.jobs.len() >= 64 {
            return Err(SdkError::new("ERR_NETWORK", "HTTP queue is full"));
        }
        if state.jobs.contains_key(&call_id) {
            return Err(SdkError::new("ERR_NETWORK", "duplicate HTTP call id"));
        }
        state.jobs.insert(
            call_id.clone(),
            Job {
                abort: None,
                cancelled: false,
                result: None,
            },
        );
        if let Err(error) = sender.try_send(Command::Start {
            call_id: call_id.clone(),
            payload,
            deadline_ns,
        }) {
            state.jobs.remove(&call_id);
            return Err(SdkError::new("ERR_NETWORK", error));
        }
        Ok(())
    }
    pub fn cancel(&self, call_id: &str) {
        let mut state = self.shared.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(job) = state.jobs.get_mut(call_id) {
            job.cancelled = true;
            if let Some(task) = &job.abort {
                task.abort();
            } else if job.result.is_some() {
                // A result exists only after the JoinSet observed termination.
                state.jobs.remove(call_id);
            }
        }
    }
    pub fn take_results(&self) -> Vec<Completion> {
        let mut state = self.shared.lock().unwrap_or_else(|p| p.into_inner());
        let ids: Vec<_> = state
            .jobs
            .iter()
            .filter(|(_, job)| !job.cancelled && job.result.is_some())
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .map(|call_id| Completion {
                result: state.jobs.remove(&call_id).unwrap().result.unwrap(),
                call_id,
            })
            .collect()
    }
    pub fn begin_shutdown(&mut self) {
        let mut state = self.shared.lock().unwrap_or_else(|p| p.into_inner());
        state.accepting = false;
        for job in state.jobs.values_mut() {
            job.cancelled = true;
            if let Some(task) = &job.abort {
                task.abort();
            }
        }
        self.sender.take();
    }
    /// Polling never waits on a live worker, including blocking DNS teardown.
    pub fn poll_drained(&mut self) -> bool {
        if self
            .worker
            .as_ref()
            .is_some_and(|worker| worker.is_finished())
        {
            let _ = self.worker.take().unwrap().join();
        }
        self.worker.is_none()
    }
    /// Used only by the SDK's explicitly synchronous final barrier.
    pub fn wait_drained(&mut self) {
        self.begin_shutdown();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
    pub fn retain_until_drained(&mut self, value: impl Send + 'static) {
        self.retained
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(Box::new(value));
    }
    #[cfg(test)]
    pub fn hold_dispatch(&self, release: mpsc::Receiver<()>) -> mpsc::Receiver<()> {
        let (started, ready) = mpsc::channel();
        self.sender
            .as_ref()
            .unwrap()
            .try_send(Command::HoldDispatch { release, started })
            .unwrap();
        ready
    }
    #[cfg(test)]
    pub fn hold_worker(&self, release: mpsc::Receiver<()>) -> mpsc::Receiver<()> {
        // A real executor-owned blocking task models a DNS resolver or an OS
        // transport teardown which cannot complete just because abort was sent.
        // Runtime destruction must wait for it, away from the UI owner thread.
        let (started, ready) = mpsc::channel();
        self.sender
            .as_ref()
            .unwrap()
            .try_send(Command::HoldWorker { release, started })
            .unwrap();
        ready
    }
}

impl Drop for HttpService {
    fn drop(&mut self) {
        self.begin_shutdown();
        // The worker owns its executor and retained leases. Destruction stays
        // nonblocking; normal lifecycle completion uses poll_drained instead.
    }
}

fn network_error(error: reqwest::Error) -> ProviderError {
    if error.is_timeout() {
        ProviderError::timeout(error.to_string())
    } else {
        ProviderError {
            code: ProviderErrorCode::InvalidRequest,
            message: format!("request failed: {error}"),
            retryable: error.is_connect(),
        }
    }
}

async fn request(
    client: &Client,
    payload: Value,
    deadline_ns: Option<u64>,
) -> Result<Value, ProviderError> {
    let body = payload
        .as_object()
        .ok_or_else(|| ProviderError::invalid("request payload must be an object"))?;
    let binary = match body
        .get("responseType")
        .and_then(Value::as_str)
        .unwrap_or("text")
    {
        "arraybuffer" => true,
        "text" => false,
        _ => {
            return Err(ProviderError::invalid(
                "responseType must be text or arraybuffer",
            ))
        }
    };
    let json_response = match body
        .get("dataType")
        .and_then(Value::as_str)
        .unwrap_or("json")
    {
        "json" => true,
        "text" => false,
        _ => return Err(ProviderError::invalid("dataType must be json or text")),
    };
    let url = body
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| ProviderError::invalid("request requires url"))?;
    let url = Url::parse(url).map_err(|e| ProviderError::invalid(e.to_string()))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ProviderError::invalid(
            "request supports HTTP(S) URLs without embedded credentials",
        ));
    }
    let timeout_ms = body
        .get("timeout")
        .and_then(Value::as_u64)
        .unwrap_or(60_000);
    if timeout_ms == 0 {
        return Err(ProviderError::invalid("request timeout must be positive"));
    }
    let mut timeout = Duration::from_millis(timeout_ms);
    if let Some(deadline) = deadline_ns {
        let remaining = deadline
            .checked_sub(clock_now_ns())
            .ok_or_else(|| ProviderError::timeout("request deadline expired"))?;
        timeout = timeout.min(Duration::from_nanos(remaining));
    }
    let method = body
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("GET")
        .to_ascii_uppercase();
    let method =
        Method::from_bytes(method.as_bytes()).map_err(|e| ProviderError::invalid(e.to_string()))?;
    let mut headers = HeaderMap::new();
    if let Some(value) = body.get("header") {
        let values = value
            .as_object()
            .ok_or_else(|| ProviderError::invalid("header must be an object"))?;
        for (name, value) in values {
            let value = value
                .as_str()
                .ok_or_else(|| ProviderError::invalid("header values must be strings"))?;
            headers.insert(
                HeaderName::from_bytes(name.as_bytes())
                    .map_err(|e| ProviderError::invalid(e.to_string()))?,
                HeaderValue::from_str(value).map_err(|e| ProviderError::invalid(e.to_string()))?,
            );
        }
    }
    let form = headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/x-www-form-urlencoded"));
    let has_content_type = headers.contains_key(CONTENT_TYPE);
    let mut request = client
        .request(method.clone(), url)
        .headers(headers)
        .timeout(timeout);
    if let Some(data) = body.get("data") {
        if body.get("dataEncoding").and_then(Value::as_str) == Some("bytes") {
            let bytes = data
                .as_array()
                .ok_or_else(|| ProviderError::invalid("binary request data must be a byte array"))?
                .iter()
                .map(|v| {
                    v.as_u64()
                        .filter(|v| *v <= 255)
                        .map(|v| v as u8)
                        .ok_or_else(|| ProviderError::invalid("invalid request byte"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            if bytes.len() > MAX_BODY {
                return Err(ProviderError::invalid("request body exceeds 8 MiB"));
            }
            request = request.body(bytes);
        } else if (method == Method::GET || method == Method::HEAD || form) && data.is_object() {
            let fields: BTreeMap<String, String> = data
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        match v {
                            Value::String(s) => s.clone(),
                            _ => v.to_string(),
                        },
                    )
                })
                .collect();
            request = if method == Method::GET || method == Method::HEAD {
                request.query(&fields)
            } else {
                request.form(&fields)
            };
        } else if let Some(text) = data.as_str() {
            if text.len() > MAX_BODY {
                return Err(ProviderError::invalid("request body exceeds 8 MiB"));
            }
            request = request.body(text.to_owned());
        } else if !data.is_null() {
            let bytes =
                serde_json::to_vec(data).map_err(|e| ProviderError::invalid(e.to_string()))?;
            if bytes.len() > MAX_BODY {
                return Err(ProviderError::invalid("request body exceeds 8 MiB"));
            }
            if !has_content_type {
                request = request.header(CONTENT_TYPE, "application/json");
            }
            request = request.body(bytes);
        }
    }
    let mut response = request.send().await.map_err(network_error)?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BODY as u64)
    {
        return Err(ProviderError::invalid("response body exceeds 8 MiB"));
    }
    let status = response.status().as_u16();
    let mut headers = Map::new();
    for (name, value) in response.headers() {
        let text = value.to_str().unwrap_or_default();
        headers
            .entry(name.as_str())
            .and_modify(|v| *v = json!(format!("{}, {}", v.as_str().unwrap_or_default(), text)))
            .or_insert(json!(text));
    }
    let cookies: Vec<String> = response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok().map(str::to_owned))
        .collect();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len().saturating_add(chunk.len()) > MAX_BODY {
            return Err(ProviderError::invalid("response body exceeds 8 MiB"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let data = if binary {
        json!(bytes)
    } else {
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if json_response {
            serde_json::from_str(&text).unwrap_or(json!(text))
        } else {
            json!(text)
        }
    };
    let mut result = json!({"statusCode":status,"header":headers,"cookies":cookies,"data":data,"errMsg":"request:ok"});
    if binary {
        result["dataEncoding"] = json!("bytes");
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn job_and_transport_queues_remain_bounded_until_cancelled_tasks_are_joined() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let mut service = HttpService::new().unwrap();
        for index in 0..64 {
            service
                .start(index.to_string(), json!({"url":url}), None)
                .unwrap();
        }
        assert!(service
            .start("overflow".into(), json!({"url":url}), None)
            .is_err());
        assert_eq!(service.shared.lock().unwrap().jobs.len(), 64);
        for index in 0..64 {
            service.cancel(&index.to_string());
        }
        // A cancelling future still consumes capacity until the executor
        // observes its exit. Rapid cancellation cannot detach unbounded work.
        for index in 0..1000 {
            let id = format!("rapid-{index}");
            let result = service.start(id.clone(), json!({"url":url}), None);
            service.cancel(&id);
            assert!(service.shared.lock().unwrap().jobs.len() <= 64);
            if result.is_err() {
                break;
            }
        }
        service.wait_drained();
        assert!(service.shared.lock().unwrap().jobs.is_empty());
        assert!(service.take_results().is_empty());
        assert!(service
            .start("late".into(), json!({"url":url}), None)
            .is_err());
    }
}
