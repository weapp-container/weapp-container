//! Owned runtime input minted only by its actual captured aggregate entry.
//! Pins, paths and caller-made receipts cannot construct this capability.

use super::{AccessError, ChargedRuntime, NamespaceCharge, NamespaceId};
use crate::browser_dev_artifact_job::ArtifactFiles;
use crate::browser_dev_coordinator::RuntimePins;
use crate::browser_dev_runtime_receipt::{
    RuntimeBody, RuntimeBundleRenderer, StaticRuntimeReceipt,
};
use std::path::PathBuf;
use std::sync::Arc;

/// Owns the SAME original receipt and namespace charge as the store. No raw
/// receipt/files/charge Arc, Weak, Clone or Deserialize escape is provided.
/// The owned lease may move into an artifact consumer stored beside runtime.
#[must_use = "retain the actual runtime input through artifact consumer retirement"]
#[derive(Debug)]
pub(crate) struct RuntimeInputLease {
    // Declaration order: all actual bytes/files references drop before charge.
    receipt: Arc<StaticRuntimeReceipt>,
    worker: Arc<RuntimeBody>,
    admission: Arc<RuntimeBody>,
    config: Option<Arc<RuntimeBody>>,
    charge: Arc<NamespaceCharge>,
}

/// Validation-only borrowed view. RuntimeBody itself would expose its legacy
/// public owned_files() Arc escape and bypass the shared managed quota.
#[derive(Debug)]
pub(crate) struct RuntimeInputBody<'lease> {
    body: &'lease RuntimeBody,
}

impl RuntimeInputBody<'_> {
    pub(crate) fn bytes(&self) -> &[u8] {
        self.body.bytes()
    }
}

impl RuntimeInputLease {
    // Only the parent serialized store can name ChargedRuntime. The quota
    // check and this mint happen during the same exclusive store operation.
    pub(super) fn from_captured(runtime: &ChargedRuntime) -> Result<Self, AccessError> {
        let worker = runtime
            .receipt
            .resource("runtime-worker.mjs")
            .ok_or(AccessError::NotCaptured)?;
        let admission = runtime
            .receipt
            .resource("worker-admission-loader.mjs")
            .ok_or(AccessError::NotCaptured)?;
        let config = match runtime.receipt.renderer() {
            RuntimeBundleRenderer::Software => None,
            RuntimeBundleRenderer::Canvaskit => Some(
                runtime
                    .receipt
                    .resource("runtime-config.json")
                    .ok_or(AccessError::NotCaptured)?,
            ),
        };
        // The verified receipt establishes these identities. Compare the
        // actual owners again, never equivalent-looking directory metadata.
        if !Arc::ptr_eq(worker.owned_files(), admission.owned_files())
            || config
                .as_ref()
                .is_some_and(|body| !Arc::ptr_eq(worker.owned_files(), body.owned_files()))
        {
            return Err(AccessError::NotCaptured);
        }
        Ok(Self {
            receipt: runtime.receipt.clone(),
            worker,
            admission,
            config,
            charge: runtime.charge.clone(),
        })
    }

    pub(crate) fn namespace(&self) -> NamespaceId {
        self.charge.reservation.id
    }

    pub(crate) fn pins(&self) -> &RuntimePins {
        self.receipt.pins()
    }

    pub(crate) fn renderer(&self) -> RuntimeBundleRenderer {
        self.receipt.renderer()
    }

    pub(crate) fn raw_bundle(&self) -> &[u8] {
        self.receipt.raw_bundle()
    }

    /// Derived from the original RuntimeBody's actual ArtifactFiles. This
    /// metadata grants no permission to access files after the lease drops.
    pub(crate) fn directory(&self) -> PathBuf {
        self.worker.owned_files().output()
    }

    pub(crate) fn same_files(&self, files: &Arc<ArtifactFiles>) -> bool {
        Arc::ptr_eq(self.worker.owned_files(), files)
    }

    /// Fixed validation frontier. Borrowed bodies cannot outlive this lease
    /// or expose detached bytes/files/charge ownership to their consumer.
    pub(crate) fn resource(&self, path: &str) -> Option<RuntimeInputBody<'_>> {
        let body = match path {
            "runtime-worker.mjs" => Some(self.worker.as_ref()),
            "worker-admission-loader.mjs" => Some(self.admission.as_ref()),
            "runtime-config.json" => self.config.as_deref(),
            _ => None,
        }?;
        Some(RuntimeInputBody { body })
    }
}
