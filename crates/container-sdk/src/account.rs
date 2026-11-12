//! Host credentials deliberately do not live in this module. The manager holds
//! only an opaque principal and a monotonic revocation epoch shared by owners.
use crate::{LoadOptions, SdkError};
use container_runtime::{HostAccount, TrustedApplication};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};

#[derive(Clone)]
pub struct HostAccountManager(Arc<Mutex<AccountState>>);

#[derive(Clone)]
pub(crate) struct AccountState {
    pub account: HostAccount,
    pub revision: u64,
    pub operation_id: String,
    pub launches: BTreeMap<String, LoadOptions>,
    application_revisions: BTreeMap<String, ApplicationRevocation>,
    scoped_application_revisions: BTreeMap<ApplicationAuthorizationScope, ApplicationRevocation>,
    pub storage_roots: BTreeSet<(PathBuf, String, String)>,
}

/// Pack/version changes preserve an application's authorization. Different
/// publishers and deployment environments never share logout revocation.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
struct ApplicationAuthorizationScope {
    host_app_id: String,
    tenant_id: String,
    publisher_id: String,
    app_id: String,
    environment: String,
}

impl From<&TrustedApplication> for ApplicationAuthorizationScope {
    fn from(application: &TrustedApplication) -> Self {
        Self {
            host_app_id: application.host_app_id.clone(),
            tenant_id: application.tenant_id.clone(),
            publisher_id: application.publisher_id.clone(),
            app_id: application.app_id.clone(),
            environment: application.environment.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ApplicationRevision {
    host: u64,
    scope: u64,
}

#[derive(Clone)]
struct ApplicationRevocation {
    revision: u64,
    sequence: u64,
    operation_id: String,
}

impl AccountState {
    pub(crate) fn application_revision(
        &self,
        application: &TrustedApplication,
    ) -> ApplicationRevision {
        ApplicationRevision {
            host: self
                .application_revisions
                .get(&application.app_id)
                .map(|value| value.revision)
                .unwrap_or(0),
            scope: self
                .scoped_application_revisions
                .get(&application.into())
                .map(|value| value.revision)
                .unwrap_or(0),
        }
    }

    fn application_operation_id(&self, application: &TrustedApplication) -> String {
        self.application_revisions
            .get(&application.app_id)
            .into_iter()
            .chain(self.scoped_application_revisions.get(&application.into()))
            .max_by_key(|value| value.sequence)
            .map(|value| value.operation_id.clone())
            .unwrap_or_else(|| self.operation_id.clone())
    }
}

type Registry = Mutex<BTreeMap<String, Weak<Mutex<AccountState>>>>;
static MANAGERS: OnceLock<Registry> = OnceLock::new();

impl HostAccountManager {
    pub fn new(account: HostAccount) -> Result<Self, SdkError> {
        validate_account(&account)?;
        Ok(Self(Arc::new(Mutex::new(AccountState {
            account,
            revision: 0,
            operation_id: "initial".into(),
            launches: BTreeMap::new(),
            application_revisions: BTreeMap::new(),
            scoped_application_revisions: BTreeMap::new(),
            storage_roots: BTreeSet::new(),
        }))))
    }

    /// Public bindings use a host/tenant domain to share revocation across all
    /// controllers, including controllers created by different UI toolkits.
    pub fn for_domain(
        host_app_id: &str,
        tenant_id: &str,
        account: HostAccount,
    ) -> Result<Self, SdkError> {
        if host_app_id.is_empty() || tenant_id.is_empty() {
            return Err(SdkError::invalid("account domain cannot be empty"));
        }
        validate_account(&account)?;
        let key = serde_json::to_string(&(host_app_id, tenant_id)).map_err(SdkError::invalid)?;
        let mut registry = MANAGERS
            .get_or_init(|| Mutex::new(BTreeMap::new()))
            .lock()
            .map_err(SdkError::invalid)?;
        registry.retain(|_, weak| weak.strong_count() > 0);
        if let Some(shared) = registry.get(&key).and_then(Weak::upgrade) {
            let manager = Self(shared);
            let current = manager.snapshot()?;
            if current.account.epoch != account.epoch
                || current.account.principal_id != account.principal_id
            {
                return Err(SdkError::new(
                    "ERR_ACCOUNT_CONFLICT",
                    "configure with the current domain account; switch the manager explicitly",
                ));
            }
            return Ok(manager);
        }
        let manager = Self::new(account)?;
        registry.insert(key, Arc::downgrade(&manager.0));
        Ok(manager)
    }

    pub fn account(&self) -> Result<HostAccount, SdkError> {
        Ok(self.snapshot()?.account)
    }

    pub(crate) fn record_storage_root(
        &self,
        root: &Path,
        application: &TrustedApplication,
    ) -> Result<(), SdkError> {
        self.0
            .lock()
            .map_err(SdkError::invalid)?
            .storage_roots
            .insert((
                root.to_owned(),
                application.host_app_id.clone(),
                application.tenant_id.clone(),
            ));
        Ok(())
    }

    pub fn delete_principal_data(&self, principal_id: &str) -> Result<usize, SdkError> {
        let state = self.0.lock().map_err(SdkError::invalid)?;
        if state.account.principal_id.as_deref() == Some(principal_id) {
            return Err(SdkError::new(
                "ERR_ACCOUNT_ACTIVE",
                "revoke/switch the host account before deleting its local data",
            ));
        }
        let directories = state
            .storage_roots
            .iter()
            .map(|(root, host, tenant)| {
                account_directory(root, host, tenant, &Some(principal_id.to_owned()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        crate::storage::delete_account_directories(&directories)
    }

    /// Explicit host-wide revocation of this app ID across its publishers and
    /// deployment environments. For a guest logout, use revoke_application_scope.
    pub fn revoke_application(&self, app_id: &str) -> Result<String, SdkError> {
        let mut state = self.0.lock().map_err(SdkError::invalid)?;
        let revision = state
            .application_revisions
            .get(app_id)
            .map_or(0, |value| value.revision)
            .checked_add(1)
            .ok_or_else(|| SdkError::invalid("application authorization revision exhausted"))?;
        let sequence = state
            .revision
            .checked_add(1)
            .ok_or_else(|| SdkError::invalid("account revision exhausted"))?;
        let operation_id = format!(
            "application-{}-{}-{revision}",
            container_ir::hex_digest(app_id.as_bytes()),
            state.account.epoch
        );
        state.application_revisions.insert(
            app_id.into(),
            ApplicationRevocation {
                revision,
                sequence,
                operation_id: operation_id.clone(),
            },
        );
        state.revision = sequence;
        state.launches.remove(app_id);
        Ok(operation_id)
    }

    /// The backend has revoked the calling application's authorization. A
    /// sibling version of the same installation scope is revoked too; other
    /// publishers/environments and the host login remain active.
    pub fn revoke_application_scope(
        &self,
        application: &TrustedApplication,
    ) -> Result<String, SdkError> {
        let scope = ApplicationAuthorizationScope::from(application);
        let scope_id =
            container_ir::hex_digest(&serde_json::to_vec(&scope).map_err(SdkError::invalid)?);
        let mut state = self.0.lock().map_err(SdkError::invalid)?;
        let revision = state
            .scoped_application_revisions
            .get(&scope)
            .map_or(0, |value| value.revision)
            .checked_add(1)
            .ok_or_else(|| SdkError::invalid("application authorization revision exhausted"))?;
        let sequence = state
            .revision
            .checked_add(1)
            .ok_or_else(|| SdkError::invalid("account revision exhausted"))?;
        let operation_id = format!(
            "application-scope-{scope_id}-{}-{revision}",
            state.account.epoch
        );
        state.scoped_application_revisions.insert(
            scope,
            ApplicationRevocation {
                revision,
                sequence,
                operation_id: operation_id.clone(),
            },
        );
        state.revision = sequence;
        Ok(operation_id)
    }

    /// Revocation commits before returning. Every attached owner's entry points
    /// compare this epoch before accepting input, work, presentation or results.
    /// Refreshing credentials for the same principal at the same epoch does not
    /// restart guests; the credentials themselves remain in the host/backend.
    pub fn switch_account(
        &self,
        account: HostAccount,
        launches: BTreeMap<String, LoadOptions>,
    ) -> Result<String, SdkError> {
        validate_account(&account)?;
        let mut state = self.0.lock().map_err(SdkError::invalid)?;
        if account.epoch == state.account.epoch
            && account.principal_id == state.account.principal_id
        {
            return Ok(state.operation_id.clone());
        }
        if account.epoch <= state.account.epoch {
            return Err(SdkError::new(
                "ERR_STALE_ACCOUNT_EPOCH",
                "account changes require a strictly greater epoch",
            ));
        }
        state.revision = state
            .revision
            .checked_add(1)
            .ok_or_else(|| SdkError::invalid("account revision exhausted"))?;
        state.operation_id = format!("account-{}-{}", account.epoch, state.revision);
        state.account = account;
        state.launches = launches;
        Ok(state.operation_id.clone())
    }

    pub(crate) fn snapshot(&self) -> Result<AccountState, SdkError> {
        self.0.lock().map(|s| s.clone()).map_err(SdkError::invalid)
    }
}

fn validate_account(account: &HostAccount) -> Result<(), SdkError> {
    if account.epoch == 0
        || account
            .principal_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 1024)
    {
        return Err(SdkError::invalid(
            "account epoch must be positive and principalId must be opaque/nonempty",
        ));
    }
    Ok(())
}

/// Version/pack root are excluded so an authorized upgrade retains its data.
/// JSON tuple framing prevents separator collisions; anonymous and a principal
/// named "anonymous" are different namespaces. No legacy namespace is read.
pub fn storage_namespace(
    application: &TrustedApplication,
    account: &HostAccount,
    installation_key: &str,
) -> Result<String, SdkError> {
    let scope = serde_json::to_vec(&(
        "weapp-account-v1",
        installation_key,
        &application.host_app_id,
        &application.tenant_id,
        &application.publisher_id,
        &application.app_id,
        &application.environment,
        &account.principal_id,
    ))
    .map_err(SdkError::invalid)?;
    Ok(format!("account-v1:{}", container_ir::hex_digest(&scope)))
}

fn account_directory(
    root: &Path,
    host_app_id: &str,
    tenant_id: &str,
    principal_id: &Option<String>,
) -> Result<PathBuf, SdkError> {
    let domain = container_ir::hex_digest(
        &serde_json::to_vec(&(host_app_id, tenant_id)).map_err(SdkError::invalid)?,
    );
    let principal =
        container_ir::hex_digest(&serde_json::to_vec(principal_id).map_err(SdkError::invalid)?);
    Ok(root.join("account-data-v1").join(domain).join(principal))
}
pub(crate) fn storage_directory(
    root: &Path,
    application: &TrustedApplication,
    account: &HostAccount,
) -> Result<PathBuf, SdkError> {
    account_directory(
        root,
        &application.host_app_id,
        &application.tenant_id,
        &account.principal_id,
    )
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AccountSwitchPhase {
    Revoking,
    StoppingResources,
    WaitingForSurface,
    FlushingStorage,
    Starting,
    AwaitingPresentation,
    Complete,
    Failed,
    Superseded,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSwitchReceipt {
    pub operation_id: String,
    #[serde(with = "container_runtime::host_wire_u64")]
    pub epoch: u64,
    pub phase: AccountSwitchPhase,
    pub session_id: Option<String>,
    pub error: Option<SdkError>,
}

pub(crate) struct PendingAccountSwitch {
    pub receipt: AccountSwitchReceipt,
    pub pack: Option<crate::pack::VerifiedPack>,
    pub options: LoadOptions,
    pub account: HostAccount,
    pub storage_error: Option<String>,
    pub application_revision: ApplicationRevision,
    pub cleanup_acknowledged: bool,
}

impl crate::ContainerSession {
    pub(crate) fn account_epoch_stale(&self) -> bool {
        self.account_manager.as_ref().is_some_and(|manager| {
            manager
                .account()
                .map(|account| {
                    self.config.host_services.as_ref().is_none_or(|services| {
                        account.epoch != services.account.epoch
                            || account.principal_id != services.account.principal_id
                    })
                })
                .unwrap_or(true)
        }) || self.account_manager.as_ref().is_some_and(|manager| {
            manager
                .snapshot()
                .map(|state| {
                    self.config.host_services.as_ref().is_some_and(|services| {
                        state.application_revision(&services.application)
                            != self.application_revision
                    })
                })
                .unwrap_or(true)
        })
    }
    pub(crate) fn identity_blocked(&self) -> bool {
        self.account_epoch_stale()
            || self
                .account_switch
                .as_ref()
                .is_some_and(|pending| pending.receipt.phase != AccountSwitchPhase::Complete)
    }

    pub fn bind_account_manager(&mut self, manager: HostAccountManager) -> Result<(), SdkError> {
        self.ensure_open()?;
        if self.active.is_some() {
            return Err(SdkError::invalid("bind account manager before load"));
        }
        let expected = &self
            .config
            .host_services
            .as_ref()
            .ok_or_else(|| SdkError::invalid("host services not configured"))?
            .account;
        let actual = manager.account()?;
        if actual.epoch != expected.epoch || actual.principal_id != expected.principal_id {
            return Err(SdkError::new(
                "ERR_ACCOUNT_CONFLICT",
                "manager account differs from configured account",
            ));
        }
        let state = manager.snapshot()?;
        self.application_revision = self
            .config
            .host_services
            .as_ref()
            .map(|services| state.application_revision(&services.application))
            .unwrap_or_default();
        self.account_manager = Some(manager);
        Ok(())
    }

    pub fn switch_account(
        &mut self,
        account: HostAccount,
        launches: BTreeMap<String, LoadOptions>,
    ) -> Result<AccountSwitchReceipt, SdkError> {
        self.ensure_lifecycle_open()?;
        self.account_manager
            .as_ref()
            .ok_or_else(|| SdkError::invalid("host services not configured"))?
            .switch_account(account, launches)?;
        self.poll_account_switch()?;
        Ok(self
            .account_switch_status(None)?
            .unwrap_or(AccountSwitchReceipt {
                operation_id: "initial".into(),
                epoch: self.config.host_services.as_ref().unwrap().account.epoch,
                phase: AccountSwitchPhase::Complete,
                session_id: self
                    .active
                    .as_ref()
                    .map(|a| a.session.config().session_id.clone()),
                error: None,
            }))
    }

    pub fn account_switch_status(
        &self,
        operation_id: Option<&str>,
    ) -> Result<Option<AccountSwitchReceipt>, SdkError> {
        self.check_owner()?;
        Ok(self
            .account_switch
            .as_ref()
            .map(|pending| &pending.receipt)
            .filter(|receipt| operation_id.is_none_or(|id| id == receipt.operation_id))
            .or_else(|| {
                self.account_receipts
                    .iter()
                    .rev()
                    .find(|receipt| operation_id.is_none_or(|id| id == receipt.operation_id))
            })
            .cloned())
    }

    pub fn retry_account_switch(&mut self, options: LoadOptions) -> Result<(), SdkError> {
        self.ensure_lifecycle_open()?;
        let pending = self
            .account_switch
            .as_mut()
            .ok_or_else(|| SdkError::invalid("no blocked account switch"))?;
        if pending.receipt.phase != AccountSwitchPhase::Failed {
            return Err(SdkError::invalid(
                "only failed account switches can be retried",
            ));
        }
        pending.receipt.error = None;
        pending.storage_error = None;
        pending.options = options;
        pending.receipt.phase = AccountSwitchPhase::FlushingStorage;
        self.poll_account_switch()
    }

    pub fn update_account_switch_launch(&mut self, options: LoadOptions) -> Result<(), SdkError> {
        self.ensure_lifecycle_open()?;
        let pending = self
            .account_switch
            .as_mut()
            .ok_or_else(|| SdkError::invalid("no pending account switch"))?;
        if matches!(
            pending.receipt.phase,
            AccountSwitchPhase::AwaitingPresentation
                | AccountSwitchPhase::Complete
                | AccountSwitchPhase::Failed
        ) {
            return Err(SdkError::invalid(
                "launch parameters are frozen after startup; retry a failed switch explicitly",
            ));
        }
        pending.options = options;
        self.poll_account_switch()
    }

    /// The trusted host confirms all old native subscriptions, devices, media
    /// and GPU work have stopped. JS cannot acknowledge its own revocation.
    pub fn acknowledge_account_cleanup(&mut self, operation_id: &str) -> Result<(), SdkError> {
        self.ensure_lifecycle_open()?;
        // The shared manager may have revoked the target since the last pump.
        // Compare the receipt with that target before accepting any old ACK.
        self.poll_account_switch()?;
        let pending = self
            .account_switch
            .as_mut()
            .filter(|pending| pending.receipt.operation_id == operation_id)
            .ok_or_else(|| {
                SdkError::new(
                    "ERR_CANCELLED",
                    "cleanup receipt belongs to a superseded operation",
                )
            })?;
        if self.surface.is_some() {
            return Err(SdkError::new(
                "ERR_SURFACE_ATTACHED",
                "drain and detach the old surface before acknowledging native cleanup",
            ));
        }
        pending.cleanup_acknowledged = true;
        self.poll_account_switch()
    }

    /// Cancellation never restores the revoked identity. Hosts may retry or
    /// close this blocked controller; submitted payments remain server-owned.
    pub fn cancel_account_switch(&mut self, operation_id: &str) -> Result<(), SdkError> {
        self.ensure_lifecycle_open()?;
        let pending = self
            .account_switch
            .as_ref()
            .filter(|p| p.receipt.operation_id == operation_id)
            .ok_or_else(|| SdkError::invalid("unknown live switch operation"))?;
        if pending.receipt.phase == AccountSwitchPhase::Complete {
            return Ok(());
        }
        self.fail_account_switch(SdkError::new(
            "ERR_CANCELLED",
            "account reload cancelled; revoked identity remains blocked",
        ));
        Ok(())
    }

    fn save_account_receipt(&mut self, receipt: AccountSwitchReceipt) {
        if self.account_receipts.len() >= 64 {
            self.account_receipts.pop_front();
        }
        self.account_receipts.push_back(receipt);
    }

    fn fail_account_switch(&mut self, error: SdkError) {
        if let Some(pending) = self.account_switch.as_mut() {
            pending.receipt.phase = AccountSwitchPhase::Failed;
            pending.receipt.error = Some(error);
            let receipt = pending.receipt.clone();
            self.push_event(serde_json::json!({"type":"accountSwitch","receipt":receipt}));
        }
    }

    pub(crate) fn poll_account_switch(&mut self) -> Result<(), SdkError> {
        let Some(manager) = self.account_manager.clone() else {
            return Ok(());
        };
        let state = manager.snapshot()?;
        let application_revision = self
            .config
            .host_services
            .as_ref()
            .map(|s| state.application_revision(&s.application))
            .unwrap_or_default();
        let target_changed = self
            .account_switch
            .as_ref()
            .map(|pending| {
                pending.account.epoch != state.account.epoch
                    || pending.application_revision != application_revision
            })
            .unwrap_or_else(|| {
                self.config.host_services.as_ref().is_some_and(|s| {
                    s.account.epoch != state.account.epoch
                        || s.account.principal_id != state.account.principal_id
                        || self.application_revision != application_revision
                })
            });
        if target_changed {
            let services = self
                .config
                .host_services
                .as_ref()
                .expect("manager requires services");
            let account_changed = services.account.epoch != state.account.epoch
                || services.account.principal_id != state.account.principal_id;
            let application_changed = self.application_revision != application_revision;
            let operation_id = if account_changed && application_changed {
                // One host-account request can acquire newer app revocations
                // before startup. Every composite target needs its own cleanup
                // incarnation, so an earlier hook/snapshot cannot authorize it.
                format!(
                    "{}-{}",
                    state.operation_id,
                    state.application_operation_id(&services.application)
                )
            } else if account_changed {
                state.operation_id.clone()
            } else {
                state.application_operation_id(&services.application)
            };
            let options = if account_changed || self.application_revision == application_revision {
                state
                    .launches
                    .get(&services.application.app_id)
                    .cloned()
                    .unwrap_or_default()
            } else {
                // App logout never reuses the launch/query of the prior host
                // account operation or removes another environment's launch.
                LoadOptions::default()
            };
            // Preserve only verified code. No old stack/query/JS object survives.
            let mut pack = self.active.as_ref().map(|a| a.pack.clone());
            let mut storage_error = None;
            if let Some(mut previous) = self.account_switch.take() {
                previous.receipt.phase = AccountSwitchPhase::Superseded;
                self.save_account_receipt(previous.receipt);
                if pack.is_none() {
                    pack = previous.pack;
                }
                storage_error = previous.storage_error;
            }
            if account_changed
                && application_changed
                && !self
                    .account_receipts
                    .iter()
                    .any(|receipt| receipt.operation_id == state.operation_id)
            {
                // The host may not have polled its account request before an
                // app revocation superseded it. Its original public operation
                // still has a queryable terminal, separate from current cleanup.
                self.save_account_receipt(AccountSwitchReceipt {
                    operation_id: state.operation_id.clone(),
                    epoch: state.account.epoch,
                    phase: AccountSwitchPhase::Superseded,
                    session_id: None,
                    error: None,
                });
            }
            self.account_switch = Some(PendingAccountSwitch {
                receipt: AccountSwitchReceipt {
                    operation_id,
                    epoch: state.account.epoch,
                    phase: AccountSwitchPhase::Revoking,
                    session_id: None,
                    error: None,
                },
                pack,
                options,
                account: state.account.clone(),
                storage_error,
                application_revision,
                cleanup_acknowledged: false,
            });
            // Host snapshots are replay configuration, not shared account data.
            // Keep only device-wide observations; arbitrary snapshots must be
            // refreshed explicitly under the new cleanup operation.
            if let Some(services) = self.config.host_services.as_mut() {
                for (name, value) in &mut services.sync_values {
                    if name == "weappContainer.identity.getState" {
                        *value = serde_json::json!({"hostLoggedIn":state.account.principal_id.is_some(),"appLoggedIn":false,"profileAuthorized":false,"phoneAuthorized":false});
                    } else if !matches!(
                        name.as_str(),
                        "wx.getAccountInfoSync"
                            | "wx.getSystemSetting"
                            | "wx.getDeviceInfo"
                            | "wx.getWindowInfo"
                            | "wx.getAppBaseInfo"
                            | "wx.getSystemInfoSync"
                            | "wx.getBatteryInfoSync"
                    ) {
                        *value = serde_json::Value::Null;
                    }
                }
            }
            // Drop queued effects before native consumers can obtain stale work.
            self.events.clear();
            self.queue_storage()?;
            self.cancel_prepared_dev_attempts();
            if let Some(active) = self.active.as_mut() {
                let cancellations = active.session.revoke_host_services();
                for request in cancellations {
                    if let container_runtime::HostRequest::Cancel { call_id } = request {
                        self.push_event(serde_json::json!({"type":"hostCallCancelled","callId":call_id,"reason":"account_revoked"}));
                    }
                }
            }
            self.begin_http_retirement();
            self.pending_host_apis.clear();
            self.snapshot_cache = None;
            self.observed_frame = None;
            self.observed_navigation = None;
            self.observed_chrome = None;
            self.host_layout_state.invalidate_for_account_switch();
            self.host_chrome = None;
            let receipt = self.account_switch.as_ref().unwrap().receipt.clone();
            self.push_event(serde_json::json!({"type":"accountSwitch","receipt":receipt,"account":state.account,"syncValues":self.config.host_services.as_ref().map(|services|&services.sync_values),"detachSurface":self.surface,"freshLayoutRequired":self.atomic_host_layout()}));
        }
        let Some(pending) = self.account_switch.as_ref() else {
            return Ok(());
        };
        if matches!(
            pending.receipt.phase,
            AccountSwitchPhase::Failed | AccountSwitchPhase::Complete
        ) {
            return Ok(());
        }
        if pending.receipt.phase == AccountSwitchPhase::AwaitingPresentation {
            if self
                .active
                .as_ref()
                .is_some_and(|a| a.session.is_current_frame_presented())
            {
                let mut pending = self.account_switch.take().unwrap();
                pending.receipt.phase = AccountSwitchPhase::Complete;
                let receipt = pending.receipt;
                self.push_event(serde_json::json!({"type":"accountSwitch","receipt":receipt}));
                self.save_account_receipt(receipt);
            }
            return Ok(());
        }
        if !pending.cleanup_acknowledged {
            self.account_switch.as_mut().unwrap().receipt.phase =
                AccountSwitchPhase::StoppingResources;
            return Ok(());
        }
        if self.surface.is_some() {
            self.account_switch.as_mut().unwrap().receipt.phase =
                AccountSwitchPhase::WaitingForSurface;
            return Ok(());
        }
        if !self.poll_http_retirement() {
            self.account_switch.as_mut().unwrap().receipt.phase =
                AccountSwitchPhase::StoppingResources;
            return Ok(());
        }
        // Device work and built-in network executors are drained before any
        // filesystem owner releases its lock.
        self.managed_file_scope.take();
        if let Some(storage) = &self.storage {
            if !storage.is_closing() {
                if let Err(error) = storage.begin_close() {
                    self.fail_account_switch(error);
                    return Ok(());
                }
            }
        }
        if let Some(mut active) = self.active.take() {
            // The physical host surface has drained and detached. Dispose the
            // frozen owner without entering revoked JS lifecycle hooks.
            let _ = active.session.retire_page_presenter("account-revoked");
        }
        if self.storage.as_ref().is_some_and(|s| !s.is_released()) {
            self.account_switch.as_mut().unwrap().receipt.phase =
                AccountSwitchPhase::FlushingStorage;
            return Ok(());
        }
        if let Some(error) = self
            .account_switch
            .as_ref()
            .and_then(|p| p.storage_error.clone())
        {
            self.fail_account_switch(SdkError::storage(error));
            return Ok(());
        }
        if let Some(error) = self.storage.as_ref().and_then(|s| s.last_error()) {
            self.fail_account_switch(SdkError::storage(error));
            return Ok(());
        }
        self.storage.take();
        // Atomic hosts must submit a fresh observation/layout for the new
        // surface owner; old layout proofs have been invalidated above.
        let options = self.account_switch.as_ref().unwrap().options.clone();
        if self.atomic_host_layout()
            && (options.initial_host_layout.is_none() || self.host_layout_state.pending.is_none())
        {
            self.account_switch.as_mut().unwrap().receipt.phase = AccountSwitchPhase::Starting;
            return Ok(());
        }
        let target = self.account_switch.as_ref().unwrap().account.clone();
        self.config.host_services.as_mut().unwrap().account = target;
        self.application_revision = self.account_switch.as_ref().unwrap().application_revision;
        let opened = (|| {
            if let (Some(root), Some(key), Some(services)) = (
                &self.config.storage_root,
                &self.config.storage_key,
                &self.config.host_services,
            ) {
                self.storage = Some(crate::storage::PersistentStorage::open(
                    &storage_directory(root, &services.application, &services.account)?,
                    &storage_namespace(&services.application, &services.account, key)?,
                )?);
            }
            self.account_switch.as_mut().unwrap().receipt.phase = AccountSwitchPhase::Starting;
            let pack = self.account_switch.as_ref().unwrap().pack.clone();
            self.identity_rebuilding = true;
            let loaded = pack
                .map(|pack| self.load_verified(pack, options))
                .unwrap_or(Ok(()));
            self.identity_rebuilding = false;
            loaded
        })();
        if let Err(error) = opened {
            self.fail_account_switch(error);
            return Ok(());
        }
        let session_id = self
            .active
            .as_ref()
            .map(|a| a.session.config().session_id.clone());
        let pending = self.account_switch.as_mut().unwrap();
        pending.receipt.session_id = session_id;
        pending.receipt.phase = AccountSwitchPhase::AwaitingPresentation;
        let receipt = pending.receipt.clone();
        self.push_event(serde_json::json!({"type":"accountSwitch","receipt":receipt,"account":self.config.host_services.as_ref().map(|s|&s.account)}));
        if self.active.is_none() {
            let mut pending = self.account_switch.take().unwrap();
            pending.receipt.phase = AccountSwitchPhase::Complete;
            self.save_account_receipt(pending.receipt);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn user(id: &str, epoch: u64) -> HostAccount {
        HostAccount {
            principal_id: Some(id.into()),
            epoch,
        }
    }
    #[test]
    fn domain_revokes_all_copies_and_latest_epoch_wins() {
        let manager = HostAccountManager::new(user("alice", 1)).unwrap();
        let other = manager.clone();
        manager
            .switch_account(user("bob", 3), BTreeMap::new())
            .unwrap();
        assert_eq!(
            other.account().unwrap().principal_id.as_deref(),
            Some("bob")
        );
        assert!(other
            .switch_account(user("alice", 2), BTreeMap::new())
            .is_err());
        let op = manager
            .switch_account(user("bob", 3), BTreeMap::new())
            .unwrap();
        assert_eq!(op, manager.snapshot().unwrap().operation_id);
    }
    #[test]
    fn namespaces_survive_upgrade_but_never_cross_principals() {
        let mut app = TrustedApplication {
            host_app_id: "host".into(),
            tenant_id: "tenant".into(),
            publisher_id: "publisher".into(),
            app_id: "app".into(),
            environment: "prod".into(),
            version: "1".into(),
            pack_root: "a".repeat(64),
        };
        let a = storage_namespace(&app, &user("alice", 1), "install").unwrap();
        app.version = "2".into();
        app.pack_root = "b".repeat(64);
        assert_eq!(
            a,
            storage_namespace(&app, &user("alice", 2), "install").unwrap()
        );
        assert_ne!(
            a,
            storage_namespace(&app, &user("bob", 3), "install").unwrap()
        );
        app.environment = "dev".into();
        assert_ne!(
            a,
            storage_namespace(&app, &user("alice", 3), "install").unwrap()
        );
    }
}
