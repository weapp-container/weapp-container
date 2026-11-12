//! Authoritative host chrome derived from verified portable configuration.
//! Hosts render this observation; they do not independently interpret app JSON.
use crate::{BridgeError, BridgeErrorCode, MenuButtonRect, Session};
use container_core::PageEntry;
use container_ir::{ContainerManifestV1, ModuleFormat};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromePage {
    pub id: u64,
    pub route: String,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageChrome {
    pub schema_version: u32,
    pub session_id: Option<String>,
    pub page: Option<ChromePage>,
    pub stack: Vec<ChromePage>,
    pub can_go_back: bool,
    pub navigation_style: String,
    pub title: String,
    pub background_color: String,
    pub front_color: String,
    pub tab_bar: TabBarChrome,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabBarChrome {
    pub visible: bool,
    pub custom: bool,
    pub color: String,
    pub selected_color: String,
    pub background_color: String,
    pub border_style: String,
    pub selected_index: Option<usize>,
    pub list: Vec<TabBarItem>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabBarItem {
    pub page_path: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_icon_path: Option<String>,
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub badge_text: Option<String>,
    #[serde(default, skip_deserializing, skip_serializing_if = "is_false")]
    pub red_dot: bool,
}

pub(crate) fn configuration_json(
    manifest: &ContainerManifestV1,
    blobs: &BTreeMap<String, Vec<u8>>,
    path: &str,
) -> Result<Option<Value>, BridgeError> {
    let module_id = format!("module:{path}");
    let hash = manifest
        .modules
        .iter()
        .find(|module| module.format == ModuleFormat::Json && module.id == module_id)
        .map(|module| module.sha256.as_str())
        .or_else(|| {
            manifest
                .assets
                .iter()
                .find(|asset| asset.path == path)
                .map(|asset| asset.sha256.as_str())
        });
    let Some(hash) = hash else { return Ok(None) };
    let bytes = blobs
        .get(&format!("sha256:{hash}"))
        .or_else(|| blobs.get(hash))
        .ok_or_else(|| invalid(format!("missing {path} configuration blob")))?;
    if bytes.len() > 256 * 1024 || container_ir::hex_digest(bytes) != hash {
        return Err(invalid(format!(
            "invalid {path} configuration size or digest"
        )));
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| invalid(format!("invalid {path} configuration: {error}")))?;
    if !value.is_object() {
        return Err(invalid(format!("{path} configuration must be an object")));
    }
    Ok(Some(value))
}
fn is_false(value: &bool) -> bool {
    !value
}
fn invalid(message: impl Into<String>) -> BridgeError {
    BridgeError::new(BridgeErrorCode::InvalidManifest, message)
}
fn color(value: Option<&Value>, default: &str) -> String {
    value
        .and_then(Value::as_str)
        .filter(|color| {
            color.len() == 7
                && color.starts_with('#')
                && color[1..].bytes().all(|b| b.is_ascii_hexdigit())
        })
        .unwrap_or(default)
        .to_owned()
}

/// Resolve a route before executing guest code, or merge its page-instance state
/// after navigation. Input blobs must belong to the validated manifest.
pub fn resolve_page_chrome(
    manifest: &ContainerManifestV1,
    blobs: &BTreeMap<String, Vec<u8>>,
    route: &str,
    page: Option<&PageEntry>,
    stack: Vec<ChromePage>,
    session_id: Option<String>,
) -> Result<PageChrome, BridgeError> {
    ResolvedChromeCatalog::load(manifest, blobs)?.resolve(manifest, route, page, stack, session_id)
}

pub(crate) struct ResolvedChromeCatalog {
    app: Value,
    pages: BTreeMap<String, Value>,
}
impl ResolvedChromeCatalog {
    pub(crate) fn load(
        manifest: &ContainerManifestV1,
        blobs: &BTreeMap<String, Vec<u8>>,
    ) -> Result<Self, BridgeError> {
        let app = configuration_json(manifest, blobs, &manifest.app.app_json)?.unwrap_or_default();
        let pages = manifest
            .routes
            .iter()
            .map(|route| {
                let path = route
                    .config
                    .clone()
                    .unwrap_or_else(|| format!("{}.json", route.path));
                configuration_json(manifest, blobs, &path)
                    .map(|config| (route.path.clone(), config.unwrap_or_default()))
            })
            .collect::<Result<_, _>>()?;
        Ok(Self { app, pages })
    }
    pub(crate) fn page_configuration(&self, path: &str) -> Value {
        self.pages
            .get(path)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}))
    }
    pub(crate) fn subpackage_roots(&self) -> Vec<String> {
        self.app
            .get("subPackages")
            .or_else(|| self.app.get("subpackages"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|package| package.get("root").and_then(Value::as_str))
            .map(|root| root.trim_matches('/').to_owned())
            .filter(|root| !root.is_empty())
            .collect()
    }
    fn resolve(
        &self,
        manifest: &ContainerManifestV1,
        route: &str,
        page: Option<&PageEntry>,
        stack: Vec<ChromePage>,
        session_id: Option<String>,
    ) -> Result<PageChrome, BridgeError> {
        let app = &self.app;
        let empty = Value::Null;
        let page_config = self.pages.get(route).unwrap_or(&empty);
        let property = |name: &str| {
            page_config
                .get(name)
                .or_else(|| app.get("window").and_then(|window| window.get(name)))
        };
        let custom = property("navigationStyle").and_then(Value::as_str) == Some("custom");
        let mut title = property("navigationBarTitleText")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let mut background_color = color(property("navigationBarBackgroundColor"), "#ffffff");
        let mut front_color = match property("navigationBarTextStyle").and_then(Value::as_str) {
            Some("white") => "#ffffff",
            _ => "#000000",
        }
        .to_owned();
        if let Some(page) = page {
            if page.navigation_bar_title_set || !page.navigation_bar_title.is_empty() {
                title = page.navigation_bar_title.clone();
            }
            if let Some(colors) = &page.navigation_bar_color {
                background_color = colors.background_color.clone();
                front_color = colors.front_color.clone();
            }
        }
        let tab = app.get("tabBar");
        let list: Vec<TabBarItem> = tab
            .and_then(|tab| tab.get("list"))
            .map(|value| serde_json::from_value(value.clone()))
            .transpose()
            .map_err(|error| invalid(format!("invalid tabBar list: {error}")))?
            .unwrap_or_default();
        if list.len() > 5
            || list.iter().any(|item| {
                !manifest
                    .routes
                    .iter()
                    .any(|route| route.path == item.page_path)
            })
        {
            return Err(invalid(
                "tabBar references an invalid route or exceeds five items",
            ));
        }
        let selected_index = list.iter().position(|item| item.page_path == route);
        let custom_tab = tab
            .and_then(|tab| tab.get("custom"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(PageChrome {
            schema_version: 1,
            session_id,
            page: page.map(|page| ChromePage {
                id: page.id.0,
                route: page.path.clone(),
            }),
            can_go_back: stack.len() > 1,
            stack,
            navigation_style: if custom { "custom" } else { "default" }.into(),
            title,
            background_color,
            front_color,
            tab_bar: TabBarChrome {
                visible: selected_index.is_some() && !custom_tab,
                custom: custom_tab,
                color: color(tab.and_then(|tab| tab.get("color")), "#000000"),
                selected_color: color(tab.and_then(|tab| tab.get("selectedColor")), "#000000"),
                background_color: color(tab.and_then(|tab| tab.get("backgroundColor")), "#ffffff"),
                border_style: tab
                    .and_then(|tab| tab.get("borderStyle"))
                    .and_then(Value::as_str)
                    .unwrap_or("black")
                    .into(),
                selected_index,
                list,
            },
        })
    }
}

impl Session {
    pub(super) fn has_custom_tab_bar(&self) -> bool {
        let mut catalog = self.chrome_catalog.borrow_mut();
        if catalog.is_none() {
            let Ok(loaded) = ResolvedChromeCatalog::load(&self.manifest, &self.render_blobs) else {
                return false;
            };
            *catalog = Some(loaded);
        }
        catalog
            .as_ref()
            .and_then(|catalog| catalog.app.get("tabBar"))
            .and_then(|tab_bar| tab_bar.get("custom"))
            .and_then(Value::as_bool)
            == Some(true)
    }

    pub fn page_chrome(&self) -> Result<Option<PageChrome>, BridgeError> {
        let Some(page) = self.app_service.pages().current() else {
            return Ok(None);
        };
        let stack = self
            .app_service
            .pages()
            .iter()
            .map(|page| ChromePage {
                id: page.id.0,
                route: page.path.clone(),
            })
            .collect();
        let mut catalog = self.chrome_catalog.borrow_mut();
        if catalog.is_none() {
            *catalog = Some(ResolvedChromeCatalog::load(
                &self.manifest,
                &self.render_blobs,
            )?);
        }
        let mut chrome = catalog
            .as_ref()
            .expect("initialized chrome catalog")
            .resolve(
                &self.manifest,
                &page.path,
                Some(page),
                stack,
                Some(self.config.session_id.clone()),
            )?;
        self.tab_bar_state.project(&mut chrome.tab_bar);
        Ok(Some(chrome))
    }

    /// Publish actual host capsule geometry without altering display/safe-area
    /// observations or input origins. Installation is atomic across JS realms.
    pub fn notify_menu_button_rect(&mut self, rect: MenuButtonRect) -> Result<(), BridgeError> {
        if [
            rect.left,
            rect.right,
            rect.top,
            rect.bottom,
            rect.width,
            rect.height,
        ]
        .iter()
        .any(|value| !value.is_finite())
            || rect.width <= 0.
            || rect.height <= 0.
            || (rect.right - rect.left - rect.width).abs() > 1e-6
            || (rect.bottom - rect.top - rect.height).abs() > 1e-6
        {
            return Err(BridgeError::invalid("invalid menu button geometry"));
        }
        self.with_engine_host_turn(None, |session| session.install_menu_button_rect(rect))
    }

    fn install_menu_button_rect(&mut self, rect: MenuButtonRect) -> Result<(), BridgeError> {
        if self.config.host.menu_button_rect.as_ref() == Some(&rect) {
            return Ok(());
        }
        let previous = self.config.host.menu_button_rect.clone();
        self.mark_engine_host_environment_dirty()?;
        self.config.host.menu_button_rect = Some(rect);
        if let Err(error) = self.prepare_engine_environment() {
            self.config.host.menu_button_rect = previous;
            self.mark_engine_host_environment_dirty()?;
            self.ensure_engine_execution_healthy()?;
            self.ensure_engine_environment_current()?;
            return Err(error);
        }
        Ok(())
    }
}
