//! Image projection uses opaque lease identity, never package-hash authority.
use super::*;
use container_ir::{Asset, ViewNode};

fn render(message: impl Into<String>) -> BridgeError {
    BridgeError::new(BridgeErrorCode::Render, message)
}

pub(super) fn project(
    store: &container_core::BufferUrlStore,
    document: &mut container_ir::ViewDocument,
) -> Result<(), BridgeError> {
    let mut dynamic = BTreeMap::new();
    let mut pending: Vec<_> = document.nodes.iter_mut().collect();
    while let Some(node) = pending.pop() {
        if let ViewNode::Element {
            tag,
            attrs,
            typed_attrs,
            children,
            ..
        } = node
        {
            pending.extend(children);
            if tag != "image" {
                continue;
            }
            let source = typed_attrs
                .get("src")
                .and_then(Value::as_str)
                .or_else(|| attrs.get("src").map(String::as_str));
            let Some(source) = source.filter(|source| source.starts_with("wxbuffer:")) else {
                continue;
            };
            let path = container_core::BufferUrlStore::resource_path(source)
                .ok_or_else(|| render("invalid BufferURL image source"))?;
            let bytes = store.resolve(source).map_err(render)?;
            let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                "image/png"
            } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
                "image/jpeg"
            } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
                "image/webp"
            } else {
                return Err(render(
                    "BufferURL image must contain PNG, JPEG or WebP bytes",
                ));
            };
            let asset = Asset {
                path: path.clone(),
                sha256: container_ir::hex_digest(&bytes),
                mime: mime.into(),
                size: bytes.len() as u64,
            };
            if document.resources.iter().any(|asset| asset.path == path) {
                return Err(render(
                    "BufferURL image descriptor collides with a package asset",
                ));
            }
            dynamic.insert(path.clone(), asset);
            let source = format!("/{path}");
            attrs.insert("src".into(), source.clone());
            typed_attrs.insert("src".into(), Value::String(source));
        }
    }
    document.resources.extend(dynamic.into_values());
    document
        .validate()
        .map_err(|error| render(error.to_string()))
}
