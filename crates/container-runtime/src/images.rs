//! Manifest-authorized static images. A candidate frame owns its cache changes
//! until renderer publication, so failed decoding never replaces live pixels.

use super::{lookup_render_blob, RenderResources};
use container_bridge::{BridgeError, BridgeErrorCode};
use container_ir::{ContainerManifestV1, ViewDocument, ViewNode};
use container_render_skia::{
    ImageMode, ImageResource, LayoutLength, RenderImage, RenderNode, MAX_FRAME_IMAGES,
    MAX_FRAME_IMAGE_BYTES, MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS,
};
use image::{ImageFormat, ImageReader, Limits};
use std::{collections::BTreeMap, io::Cursor, str::FromStr, sync::Arc};

const MAX_ENCODED_BYTES: usize = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES: usize = 64;
const MAX_CACHE_BYTES: usize = 128 * 1024 * 1024;

#[derive(Clone)]
struct CacheEntry {
    image: Arc<ImageResource>,
    touched: u64,
}

/// Cloning is bounded metadata and Arc handles; decoded pixels stay shared.
#[derive(Clone, Default)]
pub(super) struct ImageCache {
    entries: BTreeMap<String, CacheEntry>,
    bytes: usize,
    clock: u64,
}

impl ImageCache {
    fn get(&mut self, key: &str) -> Option<Arc<ImageResource>> {
        self.clock = self.clock.saturating_add(1);
        self.entries.get_mut(key).map(|entry| {
            entry.touched = self.clock;
            Arc::clone(&entry.image)
        })
    }

    fn insert(&mut self, key: String, image: Arc<ImageResource>) {
        self.clock = self.clock.saturating_add(1);
        if let Some(old) = self.entries.insert(
            key,
            CacheEntry {
                image: Arc::clone(&image),
                touched: self.clock,
            },
        ) {
            self.bytes -= old.image.pixels.len();
        }
        self.bytes += image.pixels.len();
        while self.entries.len() > MAX_CACHE_ENTRIES || self.bytes > MAX_CACHE_BYTES {
            let key = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.touched)
                .map(|(key, _)| key.clone())
                .expect("nonempty over-budget cache");
            self.bytes -= self.entries.remove(&key).unwrap().image.pixels.len();
        }
    }

    /// All authorization is rechecked for every use, including cache hits.
    pub(super) fn prepare(
        &mut self,
        manifest: &ContainerManifestV1,
        blobs: &RenderResources,
        root: &mut RenderNode,
        document: &ViewDocument,
        buffer_urls: &container_core::BufferUrlStore,
    ) -> Result<BTreeMap<String, Arc<ImageResource>>, BridgeError> {
        // Borrow origins from the same evaluated document used to materialize
        // this frame. No AST path/public id or physical ancestry authorizes a
        // relative URL, including cache hits and projected slot content.
        let mut origins = BTreeMap::new();
        let mut pending: Vec<_> = document.nodes.iter().collect();
        while let Some(node) = pending.pop() {
            if let ViewNode::Element { tag, children, .. } = node {
                if tag == "image" {
                    origins.insert(node.occurrence_id(), node.ownership().document_id.as_str());
                }
                pending.extend(children);
            }
        }
        let mut resources = BTreeMap::new();
        let mut total_bytes = 0usize;
        self.visit(
            manifest,
            blobs,
            root,
            &origins,
            buffer_urls,
            &mut resources,
            &mut total_bytes,
        )?;
        Ok(resources)
    }

    #[allow(clippy::too_many_arguments)]
    fn visit(
        &mut self,
        manifest: &ContainerManifestV1,
        blobs: &RenderResources,
        node: &mut RenderNode,
        origins: &BTreeMap<&str, &str>,
        buffer_urls: &container_core::BufferUrlStore,
        resources: &mut BTreeMap<String, Arc<ImageResource>>,
        total_bytes: &mut usize,
    ) -> Result<(), BridgeError> {
        if node.tag.as_deref() == Some("image") {
            validate_attributes(node)?;
            let mode = ImageMode::from_str(
                node.attributes
                    .get("mode")
                    .map(String::as_str)
                    .unwrap_or("scaleToFill"),
            )
            .map_err(|_| unsupported("image mode is not supported"))?;
            let source = node.attributes.get("src").map(String::as_str).unwrap_or("");
            let resource = if source.is_empty() {
                None
            } else {
                let lexical = node
                    .event_identity
                    .as_deref()
                    .and_then(|identity| origins.get(identity))
                    .copied()
                    .ok_or_else(|| render("image occurrence has no evaluated View origin"))?;
                let path = resolve_path(lexical, source)?;
                let dynamic_url = container_core::BufferUrlStore::resource_url(&path);
                let lease = dynamic_url
                    .as_ref()
                    .map(|url| buffer_urls.resolve(url).map_err(render))
                    .transpose()?;
                let (key, bytes, expected_hash, expected_size) = if let Some(bytes) = &lease {
                    // Lease authorization always precedes both per-frame and
                    // Session decoded cache lookup, even for identical bytes.
                    (
                        format!("buffer:{}", dynamic_url.as_ref().unwrap()),
                        bytes.as_ref(),
                        container_ir::hex_digest(bytes),
                        bytes.len() as u64,
                    )
                } else {
                    let asset = manifest
                        .assets
                        .iter()
                        .find(|asset| asset.path == path)
                        .ok_or_else(|| {
                            render(format!(
                                "image asset {path} is not declared in the manifest"
                            ))
                        })?;
                    let key = format!("sha256:{}", asset.sha256);
                    let bytes = lookup_render_blob(blobs, &key)?;
                    (key, bytes, asset.sha256.clone(), asset.size)
                };
                if bytes.len() > MAX_ENCODED_BYTES {
                    return Err(render(format!(
                        "image {path} exceeds the 8 MiB encoded byte limit"
                    )));
                }
                if u64::try_from(bytes.len()).ok() != Some(expected_size) {
                    return Err(render(format!(
                        "image asset {path} size or SHA-256 mismatch"
                    )));
                }
                // Path/size authorization is per use. This frame's immutable
                // blob borrow needs only one digest per content key, while
                // every session-cache hit still requires a fresh digest.
                if !resources.contains_key(&key) {
                    if container_ir::hex_digest(bytes) != expected_hash {
                        return Err(render(format!(
                            "image asset {path} size or SHA-256 mismatch"
                        )));
                    }
                    if resources.len() >= MAX_FRAME_IMAGES {
                        return Err(render("frame image resource count exceeds limit"));
                    }
                    let remaining = MAX_FRAME_IMAGE_BYTES - *total_bytes;
                    let image = match self.get(&key) {
                        Some(image) if image.pixels.len() <= remaining => image,
                        Some(_) => return Err(render("frame image byte budget exceeded")),
                        None => {
                            let image = Arc::new(decode(bytes, remaining)?);
                            self.insert(key.clone(), Arc::clone(&image));
                            image
                        }
                    };
                    *total_bytes += image.pixels.len();
                    resources.insert(key.clone(), image);
                }
                let image = &resources[&key];
                let dimensions = (image.width, image.height);
                node.image = Some(RenderImage {
                    resource: key,
                    mode,
                });
                Some(dimensions)
            };
            if resource.is_none() {
                node.image = None;
            }
            let style = node.style.get_or_insert_with(Default::default);
            let flow = style.flow.get_or_insert_with(Default::default);
            if matches!(flow.width, LayoutLength::Auto) {
                flow.width = LayoutLength::Px(300.0);
            }
            if matches!(flow.height, LayoutLength::Auto) {
                flow.height = LayoutLength::Px(225.0);
            }
            if let Some((width, height)) = resource {
                match mode {
                    ImageMode::WidthFix => {
                        flow.height = LayoutLength::Auto;
                        flow.aspect_ratio = Some(width as f32 / height as f32);
                    }
                    ImageMode::HeightFix => {
                        flow.width = LayoutLength::Auto;
                        flow.aspect_ratio = Some(width as f32 / height as f32);
                    }
                    _ => {}
                }
            }
        }
        for child in &mut node.children {
            self.visit(
                manifest,
                blobs,
                child,
                origins,
                buffer_urls,
                resources,
                total_bytes,
            )?;
        }
        Ok(())
    }
}

fn validate_attributes(node: &RenderNode) -> Result<(), BridgeError> {
    for (name, value) in &node.attributes {
        let event = name
            .strip_prefix("capture-")
            .unwrap_or(name)
            .strip_prefix("mut-")
            .unwrap_or_else(|| name.strip_prefix("capture-").unwrap_or(name));
        let event = event
            .strip_prefix("bind")
            .or_else(|| event.strip_prefix("catch"))
            .map(|event| event.trim_start_matches(':'));
        if matches!(event, Some("load" | "error")) {
            return Err(unsupported(format!(
                "image {name} lifecycle is not implemented"
            )));
        }
        if matches!(
            name.as_str(),
            "lazy-load" | "show-menu-by-longpress" | "show-menu" | "fade-show"
        ) && value != "false"
        {
            return Err(unsupported(format!("image {name} is not implemented")));
        }
    }
    if !node.children.is_empty() {
        return Err(unsupported("image children are not supported"));
    }
    Ok(())
}

pub(super) fn resolve_path(template: &str, source: &str) -> Result<String, BridgeError> {
    // Only the URL path addresses the blob. A query/fragment may itself
    // contain URLs or escapes and must never become a filesystem path.
    let source = source.split(['?', '#']).next().unwrap_or("");
    if source.starts_with("//")
        || source.contains(':')
        || source.contains('\\')
        || source.chars().any(char::is_control)
    {
        return Err(unsupported(
            "image src must reference a package-local asset",
        ));
    }
    // Percent escapes have URI semantics, not host filesystem semantics.
    let mut decoded = Vec::with_capacity(source.len());
    let mut input = source.as_bytes().iter().copied();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let high = input.next().and_then(hex_digit);
            let low = input.next().and_then(hex_digit);
            let (Some(high), Some(low)) = (high, low) else {
                return Err(render("image src contains invalid percent encoding"));
            };
            decoded.push(high * 16 + low);
        } else {
            decoded.push(byte);
        }
    }
    let source = std::str::from_utf8(&decoded).map_err(|_| render("image src is not UTF-8"))?;
    if source.is_empty()
        || source.starts_with("//")
        || source.contains([':', '\\'])
        || source.chars().any(char::is_control)
    {
        return Err(unsupported(
            "image src must reference a package-local asset",
        ));
    }
    let template = template.strip_prefix("template:").unwrap_or(template);
    let mut parts: Vec<&str> = if source.starts_with('/') {
        Vec::new()
    } else {
        template
            .rsplit_once('/')
            .map_or_else(Vec::new, |(parent, _)| parent.split('/').collect())
    };
    for part in source.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(render("image src escapes the package root"));
                }
            }
            part => parts.push(part),
        }
    }
    if parts.is_empty() {
        return Err(render("image src does not identify an asset"));
    }
    Ok(parts.join("/"))
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn decode(bytes: &[u8], remaining: usize) -> Result<ImageResource, BridgeError> {
    let format = image::guess_format(bytes).map_err(|_| {
        if std::str::from_utf8(bytes).is_ok_and(|text| text.contains("<svg")) {
            unsupported("SVG images are not implemented")
        } else {
            render("image bytes do not identify a supported image")
        }
    })?;
    match format {
        ImageFormat::Png if has_png_chunk(bytes, b"acTL")? => {
            return Err(unsupported("animated PNG images are not implemented"));
        }
        ImageFormat::WebP if has_animated_webp(bytes)? => {
            return Err(unsupported("animated WebP images are not implemented"));
        }
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP => {}
        _ => {
            return Err(unsupported(
                "only static PNG, JPEG and WebP images are implemented",
            ))
        }
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    // Codec allocation accounting is best effort. The strict header and
    // final RGBA checks below bound our resource size, not decoder scratch
    // memory or whole-process peak RSS.
    limits.max_alloc = Some(MAX_IMAGE_BYTES as u64);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits.clone());
    let (width, height) = reader
        .into_dimensions()
        .map_err(|e| render(format!("image header: {e}")))?;
    let pixels = (width as usize)
        .checked_mul(height as usize)
        .filter(|pixels| *pixels > 0 && *pixels <= MAX_IMAGE_PIXELS)
        .filter(|_| width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION)
        .ok_or_else(|| render("image dimensions exceed the decoded image limit"))?;
    let size = pixels
        .checked_mul(4)
        .filter(|size| *size <= remaining)
        .ok_or_else(|| render("frame image byte budget exceeded"))?;
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let pixels = reader
        .decode()
        .map_err(|e| render(format!("image decode: {e}")))?
        .into_rgba8()
        .into_raw();
    if pixels.len() != size {
        return Err(render("decoded image byte length differs from its header"));
    }
    Ok(ImageResource {
        width,
        height,
        pixels,
    })
}

fn has_png_chunk(bytes: &[u8], wanted: &[u8; 4]) -> Result<bool, BridgeError> {
    let mut offset = 8usize;
    while offset < bytes.len() {
        let header = bytes
            .get(offset..offset.saturating_add(8))
            .ok_or_else(|| render("truncated PNG chunk"))?;
        let length = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
        let end = offset
            .checked_add(12)
            .and_then(|start| start.checked_add(length))
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| render("invalid PNG chunk length"))?;
        if &header[4..8] == wanted {
            return Ok(true);
        }
        offset = end;
    }
    Ok(false)
}

fn has_animated_webp(bytes: &[u8]) -> Result<bool, BridgeError> {
    let mut offset = 12usize;
    while offset < bytes.len() {
        let header = bytes
            .get(offset..offset.saturating_add(8))
            .ok_or_else(|| render("truncated WebP chunk"))?;
        let length = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
        let start = offset + 8;
        let end = start
            .checked_add(length)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| render("invalid WebP chunk length"))?;
        if matches!(&header[..4], b"ANIM" | b"ANMF")
            || (&header[..4] == b"VP8X" && bytes.get(start).is_some_and(|flag| flag & 2 != 0))
        {
            return Ok(true);
        }
        offset = end
            .checked_add(length & 1)
            .ok_or_else(|| render("invalid WebP chunk length"))?;
    }
    Ok(false)
}

fn render(message: impl Into<String>) -> BridgeError {
    BridgeError::new(BridgeErrorCode::Render, message)
}

fn unsupported(message: impl Into<String>) -> BridgeError {
    BridgeError::new(BridgeErrorCode::UnsupportedCapability, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use container_ir::Asset;
    use container_render_skia::Rect;
    use image::{ExtendedColorType, ImageEncoder};

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(
                &vec![255; width as usize * height as usize * 4],
                width,
                height,
                ExtendedColorType::Rgba8,
            )
            .unwrap();
        bytes
    }

    #[test]
    fn animation_headers_and_encoded_dimensions_have_explicit_limits() {
        let bytes = png(1, 1);
        assert_eq!(decode(&bytes, 4).unwrap().pixels.len(), 4);
        assert!(
            decode(&bytes, 3).is_err(),
            "preflight frame budget before RGBA allocation"
        );
        let mut apng = bytes.clone();
        // Animation control is rejected before a codec can return frame zero.
        apng.splice(
            8..8,
            [
                0, 0, 0, 8, b'a', b'c', b'T', b'L', 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
        );
        assert_eq!(
            decode(&apng, 4).unwrap_err().code,
            BridgeErrorCode::UnsupportedCapability
        );
        for animated in [
            [
                b"RIFF".as_slice(),
                &[12, 0, 0, 0],
                b"WEBP",
                b"ANIM",
                &[0, 0, 0, 0],
            ]
            .concat(),
            [
                b"RIFF".as_slice(),
                &[14, 0, 0, 0],
                b"WEBP",
                b"VP8X",
                &[2, 0, 0, 0],
                &[2, 0],
            ]
            .concat(),
        ] {
            assert_eq!(
                decode(&animated, 4).unwrap_err().code,
                BridgeErrorCode::UnsupportedCapability
            );
        }
        assert!(decode(&png(MAX_IMAGE_DIMENSION + 1, 1), MAX_IMAGE_BYTES).is_err());
        for bytes in [
            b"\x89PNG\r\n\x1a\n\xff\xff\xff\xffIDAT".as_slice(),
            b"RIFF\xff\xff\xff\xffWEBPVP8X\xff\xff\xff\xff",
        ] {
            assert!(
                decode(bytes, MAX_IMAGE_BYTES).is_err(),
                "hostile chunk lengths are checked"
            );
        }
    }

    fn image_document(root: &mut RenderNode, manifest: &ContainerManifestV1) -> ViewDocument {
        root.event_identity = Some("event:0".into());
        ViewDocument {
            version: container_ir::VIEW_DOCUMENT_VERSION.into(),
            session_id: "image-test".into(),
            page_id: 0,
            revision: 1,
            route_path: "page".into(),
            profile: container_ir::RendererProfile::Skia,
            nodes: vec![ViewNode::Element {
                occurrence_id: "event:0".into(),
                tag: "image".into(),
                attrs: root.attributes.clone(),
                typed_attrs: BTreeMap::new(),
                key: None,
                ownership: container_ir::ViewOwnership {
                    document_id: "page.wxml".into(),
                    ..Default::default()
                },
                events: Vec::new(),
                children: Vec::new(),
            }],
            style_roots: Vec::new(),
            styles: Vec::new(),
            resources: manifest.assets.clone(),
        }
    }

    #[test]
    fn cache_is_bounded_shared_and_does_not_authorize_missing_current_resources() {
        let bytes = png(1, 1);
        let hash = container_ir::hex_digest(&bytes);
        let key = format!("sha256:{hash}");
        let blobs = Arc::new(BTreeMap::from([(key.clone(), bytes.clone())]));
        let mut manifest = ContainerManifestV1::default();
        manifest.assets.push(Asset {
            path: "p".into(),
            sha256: hash,
            mime: "image/png".into(),
            size: bytes.len() as u64,
        });
        let mut root = RenderNode::new(
            "image",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
        );
        root.tag = Some("image".into());
        root.attributes.insert("src".into(), "/p".into());
        let document = image_document(&mut root, &manifest);
        let mut cache = ImageCache::default();
        let resources = cache
            .prepare(
                &manifest,
                &blobs,
                &mut root,
                &document,
                &container_core::BufferUrlStore::default(),
            )
            .unwrap();
        assert!(Arc::ptr_eq(&resources[&key], &cache.entries[&key].image));
        assert!(cache
            .prepare(
                &manifest,
                &Arc::default(),
                &mut root,
                &document,
                &container_core::BufferUrlStore::default()
            )
            .is_err());
        let mut corrupted = bytes.clone();
        corrupted[0] ^= 1;
        assert!(
            cache
                .prepare(
                    &manifest,
                    &Arc::new(BTreeMap::from([(key.clone(), corrupted)])),
                    &mut root,
                    &document,
                    &container_core::BufferUrlStore::default(),
                )
                .is_err(),
            "a cached decode cannot authorize modified bytes"
        );
        for index in 0..MAX_CACHE_ENTRIES + 1 {
            cache.insert(format!("test:{index}"), Arc::clone(&resources[&key]));
        }
        assert_eq!(cache.entries.len(), MAX_CACHE_ENTRIES);
        assert_eq!(cache.bytes, MAX_CACHE_ENTRIES * 4);
        assert!(!cache.entries.contains_key("test:0"));
        assert!(cache
            .entries
            .contains_key(&format!("test:{}", MAX_CACHE_ENTRIES)));
        let large = Arc::new(ImageResource {
            width: 4096,
            height: 4096,
            pixels: vec![0; MAX_IMAGE_BYTES],
        });
        for index in 0..3 {
            cache.insert(format!("large:{index}"), Arc::clone(&large));
        }
        assert_eq!(cache.bytes, MAX_CACHE_BYTES);
        assert_eq!(cache.entries.len(), 2);
        assert!(!cache.entries.contains_key("large:0"));
    }

    #[test]
    fn encoded_limit_is_checked_before_decoding_or_cache_use() {
        let bytes = vec![0; MAX_ENCODED_BYTES + 1];
        let hash = container_ir::hex_digest(&bytes);
        let mut manifest = ContainerManifestV1::default();
        manifest.assets.push(Asset {
            path: "p".into(),
            sha256: hash.clone(),
            mime: "image/png".into(),
            size: bytes.len() as u64,
        });
        let blobs = Arc::new(BTreeMap::from([(format!("sha256:{hash}"), bytes)]));
        let mut root = RenderNode::new(
            "image",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
        );
        root.tag = Some("image".into());
        root.attributes.insert("src".into(), "/p".into());
        let document = image_document(&mut root, &manifest);
        assert!(ImageCache::default()
            .prepare(
                &manifest,
                &blobs,
                &mut root,
                &document,
                &container_core::BufferUrlStore::default()
            )
            .unwrap_err()
            .message
            .contains("8 MiB"));
    }

    #[test]
    fn local_paths_decode_urls_without_escaping_the_package() {
        assert_eq!(
            resolve_path("template:a/b/index.wxml", "../c%20d.png?rev=1#p").unwrap(),
            "a/c d.png"
        );
        assert_eq!(
            resolve_path("a/b/index.wxml", "/root.png").unwrap(),
            "root.png"
        );
        assert_eq!(
            resolve_path(
                "a/b/index.wxml",
                "/root.png?ref=https://example.com/%bad#preview"
            )
            .unwrap(),
            "root.png"
        );
        for source in [
            "../../../x",
            "/%2e%2e/x",
            "//host/x",
            "/%2fhost/x",
            "/%00x",
            "/%5cx",
            "/%3afile",
            "/%gg",
        ] {
            assert!(resolve_path("a/b/index.wxml", source).is_err(), "{source}");
        }
    }
}
