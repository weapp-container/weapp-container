//! Cryptographic entropy is runtime-owned and never delegated to a mock provider.
use crate::{deadline_expired, provider::ProviderContext, Session};
use container_bridge::{BridgeError, BridgeErrorCode};
use container_ir::CapabilitySupport;
use serde_json::{json, Map, Value};

pub(super) const API: &str = "wx.getRandomValues";
const MAX_BYTES: usize = 1_048_576;

fn requested_length(options: &Map<String, Value>) -> Result<usize, BridgeError> {
    let length = options
        .get("length")
        .and_then(Value::as_f64)
        .filter(|length| {
            length.is_finite()
                && length.fract() == 0.0
                && *length >= 0.0
                && *length <= MAX_BYTES as f64
        })
        .ok_or_else(|| {
            BridgeError::invalid("length must be an integer between 0 and 1048576 bytes")
        })?;
    Ok(length as usize)
}

fn fill_and_encode(
    length: usize,
    fill: impl FnOnce(&mut [u8]) -> Result<(), getrandom::Error>,
) -> Result<Value, BridgeError> {
    let mut bytes = vec![0_u8; length];
    // getrandom uses the platform CSPRNG, or Web Crypto on wasm32-unknown-unknown.
    // An unavailable entropy source fails the call; unfilled bytes never escape.
    fill(&mut bytes).map_err(|_| {
        BridgeError::new(BridgeErrorCode::Engine, "secure random source unavailable")
    })?;
    Ok(json!({
        "randomValues": {"__weappBinary": {"type": "ArrayBuffer", "bytes": bytes}},
        "errMsg": "getRandomValues:ok",
    }))
}

impl Session {
    fn check_random_values_context(&self, context: &ProviderContext) -> Result<(), BridgeError> {
        if context
            .cancel_token
            .as_deref()
            .is_some_and(|token| self.is_cancelled(token))
        {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "getRandomValues request cancelled",
            ));
        }
        if context.deadline_ns.is_some_and(deadline_expired) {
            return Err(BridgeError::new(
                BridgeErrorCode::Timeout,
                "getRandomValues request deadline expired",
            ));
        }
        Ok(())
    }

    pub(super) fn random_values_api_result(
        &self,
        options: &Map<String, Value>,
        deadline: Option<u64>,
        cancel: Option<&str>,
    ) -> Result<Value, BridgeError> {
        if self.effective_capability(API) == CapabilitySupport::Unsupported {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "getRandomValues is unsupported on this session",
            ));
        }
        if self.app_service.lifecycle().state() == container_core::LifecycleState::Destroyed {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "getRandomValues session is retired",
            ));
        }
        let length = requested_length(options)?;
        let mut context = self.provider_context(options, 60_000)?;
        context.deadline_ns = match (context.deadline_ns, deadline) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        if let Some(cancel) = cancel {
            context.cancel_token = Some(cancel.to_owned());
        }
        self.check_random_values_context(&context)?;
        let result = fill_and_encode(length, getrandom::fill)?;
        self.check_random_values_context(&context)?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn length_requires_a_bounded_integer_without_coercion() {
        assert_eq!(
            requested_length(json!({"length": 0}).as_object().unwrap()),
            Ok(0)
        );
        assert_eq!(
            requested_length(json!({"length": 64.0}).as_object().unwrap()),
            Ok(64)
        );
        assert_eq!(
            requested_length(json!({"length": MAX_BYTES}).as_object().unwrap()),
            Ok(MAX_BYTES)
        );
        for options in [
            json!({}),
            json!({"length": null}),
            json!({"length": "16"}),
            json!({"length": true}),
            json!({"length": []}),
            json!({"length": {}}),
            json!({"length": -1}),
            json!({"length": 1.5}),
            json!({"length": MAX_BYTES + 1}),
            json!({"length": 1e100}),
        ] {
            assert_eq!(
                requested_length(options.as_object().unwrap())
                    .unwrap_err()
                    .code,
                BridgeErrorCode::InvalidRequest
            );
        }
    }

    #[test]
    fn platform_csprng_produces_exact_binary_lengths_including_web_crypto_chunk_edges() {
        for length in [0, 1, 16, 65_535, 65_536, 65_537, MAX_BYTES] {
            let result = fill_and_encode(length, getrandom::fill).unwrap();
            assert_eq!(result["errMsg"], "getRandomValues:ok");
            assert_eq!(
                result["randomValues"]["__weappBinary"]["type"],
                "ArrayBuffer"
            );
            let bytes = result["randomValues"]["__weappBinary"]["bytes"]
                .as_array()
                .unwrap();
            assert_eq!(bytes.len(), length);
            assert!(bytes
                .iter()
                .all(|byte| byte.as_u64().is_some_and(|byte| byte <= 255)));
        }
    }

    #[test]
    fn entropy_failure_never_returns_the_allocated_buffer() {
        let error = fill_and_encode(16, |bytes| {
            bytes[0] = 42;
            Err(getrandom::Error::UNSUPPORTED)
        })
        .unwrap_err();
        assert_eq!(error.code, BridgeErrorCode::Engine);
        assert_eq!(error.message, "secure random source unavailable");
    }
}
