//! App-wide notifications use native retained dispatch, not writable globals.
use super::*;

#[derive(Default)]
pub(super) struct LifecycleNotifications {
    sequence: u64,
    route: Option<String>,
    departing: Vec<Value>,
}

impl Session {
    pub(super) fn retire_lifecycle_notifications(&mut self) -> Result<(), BridgeError> {
        self.buffer_urls.retire();
        self.performance_lifetime.retire();
        self.tab_bar_state = crate::tab_bar::TabBarState::default();
        #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
        {
            self.private_selectors = Default::default();
        }
        self.lifecycle_notifications.route = None;
        self.lifecycle_notifications.departing.clear();
        *self.observers.borrow_mut() = observers::ObserverRegistry::default();
        self.observer_observation_pending = false;
        let result = self
            .dispatch_lifecycle_notification("retire", &Value::Null)
            .map(|_| ());
        self.forget_retired_owned_canvas_requests();
        result
    }

    pub(super) fn dispatch_lifecycle_notification(
        &mut self,
        name: &str,
        payload: &Value,
    ) -> Result<bool, BridgeError> {
        #[cfg(not(any(feature = "quickjs-native", feature = "v8-native")))]
        let _ = (name, payload);
        if !self.engine_provider_available() {
            return Ok(false);
        }
        self.ensure_engine_environment_current()?;
        match self.config.engine {
            EngineKind::Quickjs => {
                #[cfg(feature = "quickjs-native")]
                {
                    self.quickjs_engine
                        .as_mut()
                        .ok_or_else(|| {
                            BridgeError::new(
                                BridgeErrorCode::Engine,
                                "QuickJS provider unavailable",
                            )
                        })?
                        .dispatch_lifecycle_notification(name, payload)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })
                }
                #[cfg(not(feature = "quickjs-native"))]
                Ok(false)
            }
            EngineKind::V8 => {
                #[cfg(feature = "v8-native")]
                {
                    self.v8_engine
                        .as_mut()
                        .ok_or_else(|| {
                            BridgeError::new(BridgeErrorCode::Engine, "V8 provider unavailable")
                        })?
                        .dispatch_lifecycle_notification(name, payload)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })
                }
                #[cfg(not(feature = "v8-native"))]
                Ok(false)
            }
        }
    }

    fn next_route_notification_id(&mut self) -> Result<String, BridgeError> {
        self.lifecycle_notifications.sequence = self
            .lifecycle_notifications
            .sequence
            .checked_add(1)
            .ok_or_else(|| BridgeError::invalid("route notification identity exhausted"))?;
        Ok(format!("route:{}", self.lifecycle_notifications.sequence))
    }

    pub(super) fn with_route_notifications<T>(
        &mut self,
        action: impl FnOnce(&mut Self) -> Result<T, BridgeError>,
    ) -> Result<T, BridgeError> {
        let owns_route = self.lifecycle_notifications.route.is_none();
        if owns_route {
            self.lifecycle_notifications.route = Some(self.next_route_notification_id()?);
        }
        let result = action(self);
        if !owns_route {
            return result;
        }
        let id = self
            .lifecycle_notifications
            .route
            .take()
            .expect("owned route identity");
        let notification_result = self.finish_unload_attempt(&id);
        match result {
            Err(error) => Err(error),
            Ok(value) => notification_result.map(|()| value),
        }
    }

    pub(super) fn with_route_event_id<T>(
        &mut self,
        id: String,
        action: impl FnOnce(&mut Self) -> Result<T, BridgeError>,
    ) -> Result<T, BridgeError> {
        let previous = self.lifecycle_notifications.route.replace(id.clone());
        let result = action(self);
        let flushed = self.finish_unload_attempt(&id);
        self.lifecycle_notifications.route = previous;
        match result {
            Err(error) => Err(error),
            Ok(value) => flushed.map(|()| value),
        }
    }

    fn finish_unload_attempt(&mut self, route_id: &str) -> Result<(), BridgeError> {
        // Retired pages still receive after, including partial failed commits.
        // A live page has not unloaded: cancel only this attempt's private
        // record so a subsequent route can start a fresh correlated pair.
        let flushed = self.flush_unload_notifications();
        let pending = std::mem::take(&mut self.lifecycle_notifications.departing);
        let mut cleanup_error = None;
        for payload in pending {
            if payload["routeEventId"].as_str() == Some(route_id) {
                if let Err(error) =
                    self.dispatch_lifecycle_notification("cancelPageUnload", &payload)
                {
                    cleanup_error.get_or_insert(error);
                }
            } else {
                self.lifecycle_notifications.departing.push(payload);
            }
        }
        flushed.and_then(|()| cleanup_error.map_or(Ok(()), Err))
    }

    pub(super) fn flush_unload_notifications(&mut self) -> Result<(), BridgeError> {
        if self.lifecycle_notifications.departing.is_empty() {
            return Ok(());
        }
        self.sync_current_pages()?;
        let departing = std::mem::take(&mut self.lifecycle_notifications.departing);
        let mut notification_error = None;
        for payload in departing {
            let id = payload["pageId"]
                .as_str()
                .and_then(|id| id.parse::<u64>().ok())
                .map(PageId);
            if id.is_some_and(|id| {
                self.app_service.pages().get(id).is_some()
                    || self.cached_tabs.values().any(|page| page.id == id)
            }) {
                // A failed structural commit did not unload this page. Keep
                // its notification pending rather than publish a false after.
                self.lifecycle_notifications.departing.push(payload);
                continue;
            }
            if let Err(error) = self.dispatch_lifecycle_notification("afterPageUnload", &payload) {
                notification_error.get_or_insert(error);
            }
        }
        notification_error.map_or(Ok(()), Err)
    }

    pub(super) fn before_page_unload(&mut self, id: PageId) -> Result<Option<Value>, BridgeError> {
        let Some(route_event_id) = self.lifecycle_notifications.route.clone() else {
            return Ok(None);
        };
        let path = self
            .app_service
            .pages()
            .get(id)
            .or_else(|| self.cached_tabs.values().find(|page| page.id == id))
            .map(|page| page.path.clone())
            .ok_or_else(|| BridgeError::invalid("unload notification requires a live page"))?;
        let payload = json!({"pageId":id.0.to_string(),"path":path,"routeEventId":route_event_id});
        let started = self.dispatch_lifecycle_notification("beforePageUnload", &payload)?;
        if started {
            // Track before immediately. Hook/component cleanup can fail before
            // after_page_unload is reached, and must still release this attempt.
            self.lifecycle_notifications.departing.push(payload.clone());
        }
        Ok(started.then_some(payload))
    }

    pub(super) fn after_page_unload(&mut self, payload: Option<Value>) -> Result<(), BridgeError> {
        let Some(payload) = payload else {
            return Ok(());
        };
        if self.lifecycle_notifications.route.is_some() {
            if !self.lifecycle_notifications.departing.contains(&payload) {
                self.lifecycle_notifications.departing.push(payload);
            }
        } else {
            self.dispatch_lifecycle_notification("afterPageUnload", &payload)?;
        }
        Ok(())
    }
}
