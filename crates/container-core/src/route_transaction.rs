//! Owner-thread synchronous rewrite authority, independent of an engine borrow.
use std::{cell::RefCell, rc::Rc};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteRewriteError {
    pub code: String,
    pub message: String,
}

impl RouteRewriteError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

pub type RouteRewriteValidator = Box<dyn FnMut(&str, bool) -> Result<(), RouteRewriteError>>;

#[derive(Default)]
pub struct RouteRewriteSlot {
    validator: RefCell<Option<RouteRewriteValidator>>,
}

pub struct RouteRewriteLease {
    slot: Rc<RouteRewriteSlot>,
}

impl RouteRewriteSlot {
    /// The guard outlives one retained before dispatch and closes before jobs.
    /// It owns no Session reference, so a native callback cannot recursively
    /// acquire the Session/engine that is already executing the listener.
    pub fn begin(
        self: &Rc<Self>,
        validator: RouteRewriteValidator,
    ) -> Result<RouteRewriteLease, RouteRewriteError> {
        let mut active = self
            .validator
            .try_borrow_mut()
            .map_err(|_| RouteRewriteError::new("ERR_INVALID_STATE", "route validator is busy"))?;
        if active.is_some() {
            return Err(RouteRewriteError::new(
                "ERR_INVALID_STATE",
                "route validator is already active",
            ));
        }
        *active = Some(validator);
        Ok(RouteRewriteLease { slot: self.clone() })
    }

    pub fn invoke_json(&self, url: &str, preserve_query: bool) -> String {
        let result = (|| {
            let mut active = self.validator.try_borrow_mut().map_err(|_| {
                RouteRewriteError::new("ERR_INVALID_STATE", "route validator is busy")
            })?;
            let validator = active.as_mut().ok_or_else(|| {
                RouteRewriteError::new("ERR_INVALID_STATE", "no native route event is active")
            })?;
            validator(url, preserve_query)
        })();
        match result {
            Ok(()) => serde_json::json!({"ok":true,"errMsg":"rewriteRoute:ok"}),
            Err(error) => serde_json::json!({"ok":false,"code":error.code,
                "errMsg":format!("rewriteRoute:fail {}",error.message)}),
        }
        .to_string()
    }
}

impl Drop for RouteRewriteLease {
    fn drop(&mut self) {
        // There is no asynchronous owner or guest callback at this boundary.
        // All normal and exceptional engine exits close the host capability.
        let _ = self.slot.validator.borrow_mut().take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lease_is_exclusive_and_drop_closes_the_validator() {
        let slot = Rc::new(RouteRewriteSlot::default());
        assert!(slot
            .invoke_json("/outside", false)
            .contains("no native route"));
        let seen = Rc::new(RefCell::new(Vec::new()));
        let calls = seen.clone();
        let lease = slot
            .begin(Box::new(move |url, preserve| {
                calls.borrow_mut().push((url.to_owned(), preserve));
                Ok(())
            }))
            .unwrap();
        assert!(slot.begin(Box::new(|_, _| Ok(()))).is_err());
        assert!(slot
            .invoke_json("/inside", true)
            .contains("rewriteRoute:ok"));
        drop(lease);
        assert!(slot.invoke_json("/late", false).contains("no native route"));
        assert_eq!(*seen.borrow(), vec![("/inside".to_owned(), true)]);
    }
}
