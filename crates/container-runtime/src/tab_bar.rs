//! Session-owned dynamic system tab chrome. No host/user object owns this state.
use crate::chrome::TabBarChrome;
use crate::{BridgeError, BridgeErrorCode, CapabilitySupport, Session};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

pub(crate) const APIS: [&str; 5] = [
    "wx.setTabBarBadge",
    "wx.removeTabBarBadge",
    "wx.showTabBarRedDot",
    "wx.hideTabBarRedDot",
    "wx.setTabBarStyle",
];
pub(crate) fn is_api(name: &str) -> bool {
    APIS.contains(&name)
}

#[derive(Clone, Default)]
pub(crate) struct TabBarState {
    // One indicator per validated tab; maps can never grow beyond five entries.
    indicators: BTreeMap<usize, Indicator>,
    color: Option<String>,
    selected_color: Option<String>,
    background_color: Option<String>,
    border_style: Option<String>,
}
#[derive(Clone)]
enum Indicator {
    Badge(String),
    Dot,
}

impl TabBarState {
    pub(crate) fn project(&self, chrome: &mut TabBarChrome) {
        if let Some(value) = &self.color {
            chrome.color.clone_from(value);
        }
        if let Some(value) = &self.selected_color {
            chrome.selected_color.clone_from(value);
        }
        if let Some(value) = &self.background_color {
            chrome.background_color.clone_from(value);
        }
        if let Some(value) = &self.border_style {
            chrome.border_style.clone_from(value);
        }
        for (index, indicator) in &self.indicators {
            if let Some(item) = chrome.list.get_mut(*index) {
                match indicator {
                    Indicator::Badge(text) => item.badge_text = Some(text.clone()),
                    Indicator::Dot => item.red_dot = true,
                }
            }
        }
    }
    fn apply(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        chrome: &TabBarChrome,
    ) -> Result<(), BridgeError> {
        if chrome.custom || chrome.list.is_empty() {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "dynamic system tabBar requires a configured non-custom tabBar",
            ));
        }
        if name == "wx.setTabBarStyle" {
            // Validate the complete transaction before changing any live field.
            let color = optional_color(payload, "color")?;
            let selected_color = optional_color(payload, "selectedColor")?;
            let background_color = optional_color(payload, "backgroundColor")?;
            let border_style = match payload.get("borderStyle") {
                None => None,
                Some(Value::String(value)) if value == "black" || value == "white" => {
                    Some(value.clone())
                }
                _ => return Err(BridgeError::invalid("borderStyle must be black or white")),
            };
            if let Some(value) = color {
                self.color = Some(value);
            }
            if let Some(value) = selected_color {
                self.selected_color = Some(value);
            }
            if let Some(value) = background_color {
                self.background_color = Some(value);
            }
            if let Some(value) = border_style {
                self.border_style = Some(value);
            }
            return Ok(());
        }
        let index = payload
            .get("index")
            .and_then(Value::as_u64)
            .and_then(|index| usize::try_from(index).ok())
            .filter(|index| *index < chrome.list.len())
            .ok_or_else(|| BridgeError::invalid("index must identify a configured tabBar item"))?;
        match name {
            "wx.setTabBarBadge" => {
                let text = payload
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| BridgeError::invalid("text must be a string"))?;
                if text.contains('\0') {
                    return Err(BridgeError::new(
                        BridgeErrorCode::UnsupportedCapability,
                        "NUL tab badge text is unsupported",
                    ));
                }
                // Candidate policy follows JavaScript string length (UTF-16).
                // The pinned contract says >4 characters display literal ...;
                // exact Unicode/indicator interaction still needs a runtime oracle.
                let display = if text.encode_utf16().count() > 4 {
                    "..."
                } else {
                    text
                };
                self.indicators
                    .insert(index, Indicator::Badge(display.to_owned()));
            }
            "wx.showTabBarRedDot" => {
                self.indicators.insert(index, Indicator::Dot);
            }
            "wx.removeTabBarBadge" => {
                if matches!(self.indicators.get(&index), Some(Indicator::Badge(_))) {
                    self.indicators.remove(&index);
                }
            }
            "wx.hideTabBarRedDot" => {
                if matches!(self.indicators.get(&index), Some(Indicator::Dot)) {
                    self.indicators.remove(&index);
                }
            }
            _ => {
                return Err(BridgeError::new(
                    BridgeErrorCode::UnsupportedCapability,
                    "unsupported tabBar operation",
                ))
            }
        }
        Ok(())
    }
}
fn optional_color(payload: &Map<String, Value>, name: &str) -> Result<Option<String>, BridgeError> {
    let Some(value) = payload.get(name) else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .filter(|value| {
            (value.len() == 4 || value.len() == 7)
                && value.starts_with('#')
                && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        .ok_or_else(|| BridgeError::invalid(format!("{name} must be a hex color")))?;
    // Normalize shorthand so every existing native presenter receives #RRGGBB.
    Ok(Some(if value.len() == 4 {
        let mut full = String::from("#");
        for byte in value[1..].chars() {
            full.push(byte);
            full.push(byte);
        }
        full
    } else {
        value.to_owned()
    }))
}
impl Session {
    pub(super) fn tab_bar_api_result(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        deadline: Option<u64>,
        cancel: Option<&str>,
    ) -> Result<Value, BridgeError> {
        if self.app_service.lifecycle().state() == container_core::LifecycleState::Destroyed {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "tabBar session is retired",
            ));
        }
        if self.effective_capability(name) == CapabilitySupport::Unsupported {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "tabBar API is unsupported on this session",
            ));
        }
        if deadline.is_some_and(crate::deadline_expired) {
            return Err(BridgeError::new(
                BridgeErrorCode::Timeout,
                "tabBar request deadline expired",
            ));
        }
        if cancel.is_some_and(|token| self.is_cancelled(token)) {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "tabBar request cancelled",
            ));
        }
        let page = self
            .app_service
            .pages()
            .current()
            .ok_or_else(|| BridgeError::invalid("tabBar requires a current page"))?;
        // Resolve the verified catalog, even on a non-tab route. State belongs
        // to the session and must survive normal page pushes/pops/switches.
        let chrome = crate::chrome::resolve_page_chrome(
            &self.manifest,
            &self.render_blobs,
            &page.path,
            Some(page),
            Vec::new(),
            Some(self.config.session_id.clone()),
        )?;
        self.tab_bar_state.apply(name, payload, &chrome.tab_bar)?;
        Ok(json!({"errMsg":format!("{}:ok", name.trim_start_matches("wx."))}))
    }
}
