use crate::SdkError;
use container_ir::{hex_digest, ContainerManifestV1};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

/// An already downloaded, unpacked portable pack. Fetching and installing
/// application updates is a host concern; executable URLs are not accepted.
#[derive(Clone, Debug)]
pub enum PackSource {
    Directory(PathBuf),
}

impl From<PathBuf> for PackSource {
    fn from(path: PathBuf) -> Self {
        Self::Directory(path)
    }
}

#[derive(Clone)]
pub(crate) struct VerifiedPack {
    pub manifest: ContainerManifestV1,
    pub blobs: BTreeMap<String, Vec<u8>>,
}

impl VerifiedPack {
    pub fn load(source: PackSource) -> Result<Self, SdkError> {
        let PackSource::Directory(root) = source;
        let root = root.canonicalize().map_err(SdkError::pack)?;
        let manifest: ContainerManifestV1 =
            serde_json::from_slice(&read(&root, "manifest.json")?).map_err(SdkError::pack)?;
        manifest.validate().map_err(SdkError::pack)?;
        manifest.verify_integrity().map_err(SdkError::pack)?;
        if !container_runtime::showcase_pack_allowed(&manifest.integrity.root) {
            return Err(SdkError::new(
                "ERR_UNTRUSTED_APPLICATION",
                "pack is not part of this showcase distribution",
            ));
        }
        let mut pointers = BTreeSet::new();
        if let Some(modern) = &manifest.modern_view {
            pointers.extend(modern.blob_hashes().map(|hash| format!("sha256:{hash}")));
        }
        if let Some(compiled) = &manifest.view_compilation {
            pointers.extend(
                compiled
                    .modules
                    .iter()
                    .map(|m| format!("sha256:{}", m.executable_sha256)),
            );
            pointers.extend(
                compiled
                    .documents
                    .iter()
                    .flat_map(|d| &d.expressions)
                    .map(|e| format!("sha256:{}", e.executable_sha256)),
            );
        }
        pointers.extend(manifest.templates.iter().map(|t| t.wxml_ast.clone()));
        pointers.extend(manifest.styles.iter().map(|s| s.wxss_ir.clone()));
        pointers.extend(
            manifest
                .modules
                .iter()
                .map(|m| format!("sha256:{}", m.sha256)),
        );
        pointers.extend(
            manifest
                .view_scripts
                .iter()
                .map(|m| format!("sha256:{}", m.sha256)),
        );
        pointers.extend(
            manifest
                .assets
                .iter()
                .map(|a| format!("sha256:{}", a.sha256)),
        );
        let mut blobs = BTreeMap::new();
        for pointer in pointers {
            let hash = pointer
                .strip_prefix("sha256:")
                .filter(|hash| container_ir::is_sha256(hash))
                .ok_or_else(|| SdkError::pack(format!("invalid blob reference {pointer}")))?;
            let bytes = read(&root, &format!("blobs/sha256/{hash}"))?;
            if hex_digest(&bytes) != hash {
                return Err(SdkError::pack(format!("blob digest mismatch: {pointer}")));
            }
            blobs.insert(pointer, bytes);
        }
        for asset in &manifest.assets {
            if blobs[&format!("sha256:{}", asset.sha256)].len() as u64 != asset.size {
                return Err(SdkError::pack(format!(
                    "asset size mismatch: {}",
                    asset.path
                )));
            }
        }
        Ok(Self { manifest, blobs })
    }

    pub fn route(&self, requested: Option<&str>) -> Result<String, SdkError> {
        let path = requested
            .or_else(|| self.manifest.routes.first().map(|r| r.path.as_str()))
            .ok_or_else(|| SdkError::pack("pack has no route"))?;
        if !self.manifest.routes.iter().any(|r| r.path == path) {
            return Err(SdkError::invalid(format!("unknown route: {path}")));
        }
        Ok(path.to_owned())
    }

    pub fn template(&self, route: &str) -> Result<String, SdkError> {
        let id = format!("template:{route}.wxml");
        self.manifest
            .templates
            .iter()
            .find(|t| t.id == id)
            .map(|t| t.id.clone())
            .ok_or_else(|| SdkError::pack(format!("route has no WXML template: {route}")))
    }

    pub fn modules(&self) -> Value {
        json!(self
            .manifest
            .modules
            .iter()
            .map(|m| json!({"id":m.id,
            "bytes":self.blobs[&format!("sha256:{}",m.sha256)]}))
            .collect::<Vec<_>>())
    }

    pub fn blobs(&self) -> Value {
        json!(self.blobs)
    }
}

fn read(root: &Path, relative: &str) -> Result<Vec<u8>, SdkError> {
    let path = root.join(relative).canonicalize().map_err(SdkError::pack)?;
    if !path.starts_with(root) || !path.is_file() {
        return Err(SdkError::pack(format!(
            "missing or unsafe pack file: {relative}"
        )));
    }
    fs::read(path).map_err(SdkError::pack)
}
