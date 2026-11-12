use super::*;
use std::collections::BTreeSet;

impl ContainerManifestV1 {
    /// App, current route and recursively declared component styles, in
    /// manifest cascade order. Unrelated pages never enter this set.
    /// This selects resources; component style isolation is a View concern.
    pub fn route_style_ids(&self, path: &str) -> Result<Vec<String>, ManifestError> {
        let route = self
            .routes
            .iter()
            .find(|route| route.path == path.trim_start_matches('/'))
            .ok_or_else(|| ManifestError::InvalidField {
                field: "route",
                reason: format!("unknown style route: {path}"),
            })?;
        let records = self
            .components
            .iter()
            .map(|record| (record.owner.as_str(), record))
            .collect::<BTreeMap<_, _>>();
        let mut owners = BTreeSet::new();
        let mut pending = vec![
            self.app.app_json.clone(),
            route
                .config
                .clone()
                .unwrap_or_else(|| format!("{}.json", route.path)),
        ];
        while let Some(owner) = pending.pop() {
            if !owners.insert(owner.clone()) {
                continue;
            }
            if let Some(record) = records.get(owner.as_str()) {
                for target in record.using_components.values() {
                    if target.is_empty()
                        || target.starts_with('/')
                        || target.contains('\\')
                        || target
                            .split('/')
                            .any(|segment| segment == ".." || segment == "." || segment.is_empty())
                    {
                        return Err(ManifestError::InvalidField {
                            field: "components.usingComponents",
                            reason: format!(
                                "style graph requires normalized relative paths: {target}"
                            ),
                        });
                    }
                    pending.push(format!("{target}.json"));
                }
            }
        }
        let reachable = owners
            .iter()
            .map(|owner| {
                format!(
                    "style:{}.wxss",
                    owner.strip_suffix(".json").unwrap_or(owner)
                )
            })
            .collect::<BTreeSet<_>>();
        Ok(self
            .styles
            .iter()
            .filter(|style| style.scope == StyleScope::App || reachable.contains(&style.id))
            .map(|style| style.id.clone())
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> ContainerManifestV1 {
        let mut manifest = ContainerManifestV1::default();
        manifest.app.app_json = "app.json".into();
        for path in ["pages/first/index", "pages/other/index"] {
            manifest.routes.push(Route {
                id: path.into(),
                path: path.into(),
                kind: RouteKind::Page,
                config: None,
                entry_module: format!("module:{path}.js"),
            });
        }
        for (owner, components) in [
            ("app.json", vec![("global", "components/global/index")]),
            (
                "pages/first/index.json",
                vec![("card", "components/card/index")],
            ),
            (
                "components/card/index.json",
                vec![("nested", "components/leaf/index")],
            ),
            (
                "components/leaf/index.json",
                vec![("recursive", "components/card/index")],
            ),
            (
                "pages/other/index.json",
                vec![("other", "components/other/index")],
            ),
        ] {
            manifest.components.push(Component {
                id: format!("components:{owner}"),
                owner: owner.into(),
                using_components: components
                    .into_iter()
                    .map(|(name, target)| (name.into(), target.into()))
                    .collect(),
                multiple_slots: None,
            });
        }
        for (path, scope) in [
            ("app", StyleScope::App),
            ("pages/first/index", StyleScope::Page),
            ("components/card/index", StyleScope::Component),
            ("components/leaf/index", StyleScope::Component),
            ("pages/other/index", StyleScope::Page),
            ("components/other/index", StyleScope::Component),
            ("components/global/index", StyleScope::Component),
        ] {
            manifest.styles.push(Style {
                id: format!("style:{path}.wxss"),
                scope,
                wxss_ir: String::new(),
            });
        }
        manifest
    }

    #[test]
    fn route_graph_preserves_cascade_order_without_unrelated_page_or_component_styles() {
        let manifest = fixture();
        assert_eq!(
            manifest.route_style_ids("/pages/first/index").unwrap(),
            [
                "style:app.wxss",
                "style:pages/first/index.wxss",
                "style:components/card/index.wxss",
                "style:components/leaf/index.wxss",
                "style:components/global/index.wxss"
            ]
        );
        assert_eq!(
            manifest.route_style_ids("pages/other/index").unwrap(),
            [
                "style:app.wxss",
                "style:pages/other/index.wxss",
                "style:components/other/index.wxss",
                "style:components/global/index.wxss"
            ]
        );
        assert!(manifest.route_style_ids("missing").is_err());
    }

    #[test]
    fn unsafe_component_style_edges_are_rejected_instead_of_traversed() {
        for invalid in ["../escape", "/root", "a/./b", "a//b", "a\\b", ""] {
            let mut manifest = fixture();
            manifest.components[1]
                .using_components
                .insert("bad".into(), invalid.into());
            assert!(
                manifest.route_style_ids("pages/first/index").is_err(),
                "{invalid}"
            );
        }
    }
}
