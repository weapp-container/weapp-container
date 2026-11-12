//! Modern View is an explicit execution profile, never a WXS helper variant.
use crate::{
    is_sha256, valid_wxs_module_name, valid_wxs_source_path, ContainerManifestV1, ManifestError,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const MODERN_MANIFEST_SCHEMA_VERSION: u32 = 2;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModernViewCompilation {
    pub compiler: String,
    pub version: String,
    pub abi: String,
    pub target: String,
    pub units: Vec<ModernViewUnit>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModernViewUnit {
    pub id: String,
    pub executable_sha256: String,
    pub source_map_sha256: String,
    pub sources: Vec<ModernViewSource>,
    pub documents: Vec<ModernViewDocument>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModernViewSource {
    pub path: String,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModernViewDocument {
    pub document_id: String,
    pub aliases: Vec<String>,
}

impl ModernViewCompilation {
    pub fn blob_hashes(&self) -> impl Iterator<Item = &str> {
        self.units.iter().flat_map(|unit| {
            std::iter::once(unit.executable_sha256.as_str())
                .chain(std::iter::once(unit.source_map_sha256.as_str()))
                .chain(unit.sources.iter().map(|source| source.sha256.as_str()))
        })
    }

    pub fn unit_for_document(&self, document: &str) -> Option<&ModernViewUnit> {
        self.units.iter().find(|unit| {
            unit.documents
                .iter()
                .any(|entry| entry.document_id == document)
        })
    }
}

impl ContainerManifestV1 {
    pub fn is_modern_document(&self, document: &str) -> bool {
        let document = document.strip_prefix("template:").unwrap_or(document);
        self.modern_view
            .as_ref()
            .is_some_and(|view| view.unit_for_document(document).is_some())
    }

    pub(crate) fn validate_modern_view(&self) -> Result<(), ManifestError> {
        let Some(view) = &self.modern_view else {
            return Ok(());
        };
        let invalid = |reason: String| ManifestError::InvalidField {
            field: "modernView",
            reason,
        };
        if view.compiler != "weapp-container-modern-view"
            || view.version != "1.0.0"
            || view.abi != "1.0"
            || view.target != "es2022"
            || view.units.is_empty()
        {
            return Err(invalid(
                "unsupported modern View compiler, version, ABI or target".into(),
            ));
        }
        let mut ids = BTreeSet::new();
        let mut documents = BTreeSet::new();
        for unit in &view.units {
            if !unit.id.strip_prefix("modern:").is_some_and(is_sha256)
                || !ids.insert(&unit.id)
                || unit.documents.is_empty()
                || unit.sources.is_empty()
            {
                return Err(invalid(format!(
                    "invalid or duplicate modern unit {}",
                    unit.id
                )));
            }
            for hash in std::iter::once(&unit.executable_sha256)
                .chain(std::iter::once(&unit.source_map_sha256))
                .chain(unit.sources.iter().map(|source| &source.sha256))
            {
                if !is_sha256(hash) {
                    return Err(invalid(format!("invalid modern blob hash {hash}")));
                }
            }
            let mut paths = BTreeSet::new();
            for source in &unit.sources {
                let path = source.path.strip_prefix("npm:").unwrap_or(&source.path);
                if !crate::valid_relative_path(path)
                    || path.contains('\\')
                    || path.chars().any(char::is_control)
                    || !paths.insert(&source.path)
                {
                    return Err(invalid(format!(
                        "invalid or duplicate modern source {}",
                        source.path
                    )));
                }
            }
            for document in &unit.documents {
                if !valid_wxs_source_path(&document.document_id, ".wxml")
                    || !documents.insert(&document.document_id)
                {
                    return Err(invalid(format!(
                        "invalid or duplicate modern document {}",
                        document.document_id
                    )));
                }
                let Some(template) = self
                    .templates
                    .iter()
                    .find(|template| template.id == format!("template:{}", document.document_id))
                else {
                    return Err(invalid(format!(
                        "undeclared modern document {}",
                        document.document_id
                    )));
                };
                let mut aliases = BTreeSet::new();
                if !template.wxs_modules.is_empty()
                    || document
                        .aliases
                        .iter()
                        .any(|alias| !valid_wxs_module_name(alias) || !aliases.insert(alias))
                {
                    return Err(invalid(format!(
                        "mixed WXS/modern declarations or invalid aliases in {}",
                        document.document_id
                    )));
                }
                if self.view_compilation.as_ref().is_some_and(|compiled| {
                    compiled
                        .documents
                        .iter()
                        .any(|entry| entry.document_id == document.document_id)
                }) {
                    return Err(invalid(format!(
                        "modern document {} also declares WXS compilation",
                        document.document_id
                    )));
                }
            }
        }
        Ok(())
    }
}
