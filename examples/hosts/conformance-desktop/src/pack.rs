//! Immutable pack input, independent from engine construction and window ownership.
use container_ir::{hex_digest, ContainerManifestV1};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Debug)]
pub struct Pack {
    pub manifest: ContainerManifestV1,
    pub manifest_bytes: Vec<u8>,
    blobs: BTreeMap<String, Vec<u8>>,
}

impl Pack {
    pub fn read(root: &Path) -> Result<Self> {
        if fs::symlink_metadata(root)?.file_type().is_symlink() || !root.is_dir() {
            return Err("pack must be a real directory".into());
        }
        let manifest_path = root.join("manifest.json");
        if !fs::symlink_metadata(&manifest_path)?.file_type().is_file() {
            return Err("manifest must be a regular file".into());
        }
        let manifest_bytes = fs::read(manifest_path)?;
        let manifest: ContainerManifestV1 = serde_json::from_slice(&manifest_bytes)?;
        manifest.verify_integrity()?;
        let mut blobs = BTreeMap::new();
        for pointer in declared_blobs(&manifest) {
            let hash = pointer
                .strip_prefix("sha256:")
                .ok_or("invalid blob pointer")?;
            if !container_ir::is_sha256(hash) {
                return Err("invalid blob digest".into());
            }
            let mut path = root.to_owned();
            for part in ["blobs", "sha256", hash] {
                path.push(part);
                if fs::symlink_metadata(&path)?.file_type().is_symlink() {
                    return Err("pack blob paths must not contain symlinks".into());
                }
            }
            if !fs::symlink_metadata(&path)?.file_type().is_file() {
                return Err("pack blob must be a regular file".into());
            }
            let bytes = fs::read(path)?;
            if hex_digest(&bytes) != hash {
                return Err(format!("pack blob digest mismatch: {pointer}").into());
            }
            blobs.insert(pointer, bytes);
        }
        Ok(Self {
            manifest,
            manifest_bytes,
            blobs,
        })
    }

    pub fn route(&self, requested: &str) -> Result<String> {
        let route = requested.trim_start_matches('/');
        self.manifest
            .routes
            .iter()
            .find(|entry| entry.path == route)
            .map(|entry| entry.path.clone())
            .ok_or_else(|| format!("route is absent from pack: {requested}").into())
    }

    pub fn initial_route(&self) -> Result<String> {
        self.manifest
            .routes
            .first()
            .map(|entry| entry.path.clone())
            .ok_or_else(|| "pack has no routes".into())
    }

    pub fn template(&self, route: &str) -> Result<String> {
        let id = format!("template:{route}.wxml");
        if self.manifest.templates.iter().any(|entry| entry.id == id) {
            Ok(id)
        } else {
            Err(format!("route has no exact template: {route}").into())
        }
    }

    pub fn init(&self) -> Result<Value> {
        let modules = self
            .manifest
            .modules
            .iter()
            .map(|module| {
                let pointer = format!("sha256:{}", module.sha256);
                let bytes = self
                    .blobs
                    .get(&pointer)
                    .ok_or("verified module is absent")?;
                Ok(json!({"id":module.id,"bytes":bytes}))
            })
            .collect::<Result<Vec<_>>>()?;
        let blobs: Map<String, Value> = self
            .blobs
            .iter()
            .map(|(pointer, bytes)| (pointer.clone(), json!(bytes)))
            .collect();
        Ok(json!({"manifest":self.manifest,"modules":modules,"blobs":blobs,"launchOptions":{}}))
    }
}

fn declared_blobs(manifest: &ContainerManifestV1) -> BTreeSet<String> {
    let mut result = BTreeSet::new();
    if let Some(modern) = &manifest.modern_view {
        result.extend(modern.blob_hashes().map(|hash| format!("sha256:{hash}")));
    }
    if let Some(compilation) = &manifest.view_compilation {
        result.extend(
            compilation
                .modules
                .iter()
                .map(|module| format!("sha256:{}", module.executable_sha256)),
        );
        result.extend(
            compilation
                .documents
                .iter()
                .flat_map(|document| &document.expressions)
                .map(|expression| format!("sha256:{}", expression.executable_sha256)),
        );
    }
    result.extend(
        manifest
            .templates
            .iter()
            .map(|entry| entry.wxml_ast.clone()),
    );
    result.extend(manifest.styles.iter().map(|entry| entry.wxss_ir.clone()));
    result.extend(
        manifest
            .modules
            .iter()
            .map(|entry| format!("sha256:{}", entry.sha256)),
    );
    result.extend(
        manifest
            .view_scripts
            .iter()
            .map(|entry| format!("sha256:{}", entry.sha256)),
    );
    result.extend(
        manifest
            .assets
            .iter()
            .map(|entry| format!("sha256:{}", entry.sha256)),
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../conformance/recipes/fixtures/issue1058")
    }

    #[test]
    fn real_fixture_has_exact_route_template_and_complete_module_bytes() {
        let pack = Pack::read(&fixture()).unwrap();
        assert_eq!(pack.initial_route().unwrap(), "pages/home/index");
        assert_eq!(
            pack.route("/pages/boundary/index").unwrap(),
            "pages/boundary/index"
        );
        assert!(pack.route("/pages/missing/index").is_err());
        assert_eq!(
            pack.template("pages/home/index").unwrap(),
            "template:pages/home/index.wxml"
        );
        assert!(pack.template("pages/missing/index").is_err());
        let init = pack.init().unwrap();
        assert_eq!(
            init["modules"].as_array().unwrap().len(),
            pack.manifest.modules.len()
        );
        assert!(init["modules"]
            .as_array()
            .unwrap()
            .iter()
            .all(|module| !module["bytes"].as_array().unwrap().is_empty()));
        assert_eq!(
            init["blobs"].as_object().unwrap().len(),
            declared_blobs(&pack.manifest).len()
        );
    }

    #[test]
    fn rejects_changed_content_even_when_blob_name_is_unchanged() {
        let source = Pack::read(&fixture()).unwrap();
        let root =
            std::env::temp_dir().join(format!("weapp-conformance-pack-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let result = (|| -> Result<()> {
            fs::write(root.join("manifest.json"), &source.manifest_bytes)?;
            fs::create_dir_all(root.join("blobs/sha256"))?;
            for (pointer, bytes) in &source.blobs {
                fs::write(
                    root.join("blobs/sha256")
                        .join(pointer.trim_start_matches("sha256:")),
                    bytes,
                )?;
            }
            let first = source
                .blobs
                .keys()
                .next()
                .unwrap()
                .trim_start_matches("sha256:");
            fs::write(root.join("blobs/sha256").join(first), b"changed")?;
            assert!(Pack::read(&root)
                .unwrap_err()
                .to_string()
                .contains("digest mismatch"));
            Ok(())
        })();
        fs::remove_dir_all(root).unwrap();
        result.unwrap();
    }
}
