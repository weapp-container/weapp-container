//! Independent AppService and View health. Observing a failure never runs guest
//! code, changes foreground state, or replaces the last diagnostic picture.

use crate::Session;
use container_bridge::BridgeError;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionFaultDomain {
    AppService,
    View,
    Navigation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionFault {
    pub domain: ExecutionFaultDomain,
    /// The original typed error, rather than a parsed ERR_ENGINE message.
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    pub requires_restart: bool,
    /// Trusted transaction facts (phase, committed shape and original cause).
    /// This never contains guest-controlled serialized heap state.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionHealth {
    pub schema_version: u32,
    pub app_service_fault: Option<ExecutionFault>,
    pub view_fault: Option<ExecutionFault>,
    pub navigation_fault: Option<ExecutionFault>,
    pub requires_restart: bool,
}

impl Session {
    /// Measurements only; observing them never executes or repairs a realm.
    pub fn view_execution_metrics(&self) -> crate::view_execution::ViewExecutionMetrics {
        self.view_execution.borrow().metrics()
    }

    /// The isolated View realm can be interrupted while AppService remains
    /// healthy. It cannot grant input or presentation authority in that state.
    pub fn view_execution_is_faulted(&self) -> bool {
        self.view_execution.borrow().is_faulted()
    }

    pub fn view_execution_fault(&self) -> Option<ExecutionFault> {
        let view = self.view_execution.borrow();
        view.fault().map(|error| ExecutionFault {
            domain: ExecutionFaultDomain::View,
            code: error.code.as_str().into(),
            message: error.message,
            stack: error.stack,
            requires_restart: true,
            details: view.first_fault().map(|witness| {
                serde_json::json!({
                    "schemaVersion": 1,
                    "sessionId": self.config.session_id,
                    "witness": witness,
                })
            }),
        })
    }

    /// A passive owner-thread observation. In particular, querying View health
    /// does not mark AppService hidden or stop its timers/host completions.
    pub fn execution_health(&self) -> ExecutionHealth {
        let app_service_fault = self
            .execution_fault()
            .map(|error| ExecutionFault {
                domain: ExecutionFaultDomain::AppService,
                code: error.code.as_str().into(),
                message: error.message.clone(),
                stack: None,
                requires_restart: true,
                details: None,
            })
            .or_else(|| {
                self.engine_execution_is_faulted().then(|| ExecutionFault {
                    domain: ExecutionFaultDomain::AppService,
                    code: "ERR_ENGINE".into(),
                    message: "AppService execution requires a new session".into(),
                    stack: None,
                    requires_restart: true,
                    details: None,
                })
            });
        let view_fault = self.view_execution_fault();
        let navigation_fault = self.navigation_fault().map(|details| ExecutionFault {
            domain: ExecutionFaultDomain::Navigation,
            code: details
                .pointer("/error/code")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("ERR_ENGINE")
                .into(),
            message: details
                .pointer("/error/message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("navigation requires session restart")
                .into(),
            stack: None,
            requires_restart: true,
            details: Some(details.clone()),
        });
        ExecutionHealth {
            schema_version: 1,
            requires_restart: app_service_fault.is_some()
                || view_fault.is_some()
                || navigation_fault.is_some(),
            app_service_fault,
            view_fault,
            navigation_fault,
        }
    }

    pub(crate) fn ensure_view_execution_healthy(&self) -> Result<(), BridgeError> {
        self.view_execution.borrow().ensure_healthy()
    }

    /// Retire only native authority, exactly once for a sticky View failure.
    /// Do not synthesize touchcancel or lifecycle hooks against an interrupted
    /// View graph. AppService timers and host completions remain independent.
    pub fn retire_faulted_view_authority(&mut self) -> bool {
        if !self.view_execution.borrow_mut().take_unretired_fault() {
            return false;
        }
        #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
        self.retire_native_queries(None, "native selector View requires a fresh session");
        self.invalidate_browser_presentation();
        self.touch_contacts.clear();
        self.ended_touch_contacts.clear();
        self.scrolling.retire_touch_positions();
        self.observer_frame_valid = false;
        self.observer_frame_page = None;
        self.presented_revision = None;
        self.pending_presentation = None;
        self.observer_observation_pending = false;
        true
    }
}
