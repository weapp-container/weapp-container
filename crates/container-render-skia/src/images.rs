//! Decoded image resources and shared source/destination geometry. Encoded
//! asset resolution, decoding and SHA-256 provenance belong to the runtime.
use super::*;
use std::str::FromStr;
#[cfg(any(test, feature = "skia-backend"))]
use std::sync::Arc;

pub const MAX_IMAGE_DIMENSION: u32 = 8192;
pub const MAX_IMAGE_PIXELS: usize = 16 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: usize = MAX_IMAGE_PIXELS * 4;
pub const MAX_FRAME_IMAGE_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_FRAME_IMAGES: usize = 1024;
pub const MAX_IMAGE_ID_BYTES: usize = 256;

/// Straight (unpremultiplied), tightly packed RGBA8, without row padding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageResource {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum ImageMode {
    #[default]
    #[serde(rename = "scaleToFill")]
    ScaleToFill,
    #[serde(rename = "aspectFit")]
    AspectFit,
    #[serde(rename = "aspectFill")]
    AspectFill,
    #[serde(rename = "widthFix")]
    WidthFix,
    #[serde(rename = "heightFix")]
    HeightFix,
    #[serde(rename = "top")]
    Top,
    #[serde(rename = "bottom")]
    Bottom,
    #[serde(rename = "center")]
    Center,
    #[serde(rename = "left")]
    Left,
    #[serde(rename = "right")]
    Right,
    #[serde(rename = "top left")]
    TopLeft,
    #[serde(rename = "top right")]
    TopRight,
    #[serde(rename = "bottom left")]
    BottomLeft,
    #[serde(rename = "bottom right")]
    BottomRight,
}

impl ImageMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ScaleToFill => "scaleToFill",
            Self::AspectFit => "aspectFit",
            Self::AspectFill => "aspectFill",
            Self::WidthFix => "widthFix",
            Self::HeightFix => "heightFix",
            Self::Top => "top",
            Self::Bottom => "bottom",
            Self::Center => "center",
            Self::Left => "left",
            Self::Right => "right",
            Self::TopLeft => "top left",
            Self::TopRight => "top right",
            Self::BottomLeft => "bottom left",
            Self::BottomRight => "bottom right",
        }
    }
}

impl FromStr for ImageMode {
    type Err = RenderError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Ok(match value {
            "scaleToFill" => Self::ScaleToFill,
            "aspectFit" => Self::AspectFit,
            "aspectFill" => Self::AspectFill,
            "widthFix" => Self::WidthFix,
            "heightFix" => Self::HeightFix,
            "top" => Self::Top,
            "bottom" => Self::Bottom,
            "center" => Self::Center,
            "left" => Self::Left,
            "right" => Self::Right,
            "top left" => Self::TopLeft,
            "top right" => Self::TopRight,
            "bottom left" => Self::BottomLeft,
            "bottom right" => Self::BottomRight,
            _ => {
                return Err(RenderError::InvalidImage(format!(
                    "unknown image mode: {value}"
                )))
            }
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderImage {
    pub resource: String,
    pub mode: ImageMode,
}

/// All painters consume these same logical rectangles. Crop alignment uses
/// original image pixels, while aspect modes retain fractional source pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImageGeometry {
    pub source: Rect,
    pub destination: Rect,
    pub clip: Rect,
}

#[derive(Clone, Copy)]
struct PreciseImageRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl PreciseImageRect {
    fn narrow(self) -> Option<Rect> {
        let rect = Rect {
            x: self.x as f32,
            y: self.y as f32,
            width: self.width as f32,
            height: self.height as f32,
        };
        (rect.width > 0.0
            && rect.height > 0.0
            && [
                rect.x,
                rect.y,
                rect.width,
                rect.height,
                rect.x + rect.width,
                rect.y + rect.height,
            ]
            .into_iter()
            .all(f32::is_finite))
        .then_some(rect)
    }
}

impl ImageGeometry {
    pub fn new(content: Rect, width: u32, height: u32, mode: ImageMode) -> Option<Self> {
        if width == 0
            || height == 0
            || content.width <= 0.0
            || content.height <= 0.0
            || ![
                content.x,
                content.y,
                content.width,
                content.height,
                content.x + content.width,
                content.y + content.height,
            ]
            .into_iter()
            .all(f32::is_finite)
        {
            return None;
        }
        // Even nonzero f32 content dimensions can underflow when divided by
        // intrinsic pixels. Keep ratio/crop arithmetic in f64, then reject
        // final dimensions that cannot be represented by the frame protocol.
        let iw = f64::from(width);
        let ih = f64::from(height);
        let content_precise = PreciseImageRect {
            x: f64::from(content.x),
            y: f64::from(content.y),
            width: f64::from(content.width),
            height: f64::from(content.height),
        };
        let mut source = PreciseImageRect {
            x: 0.0,
            y: 0.0,
            width: iw,
            height: ih,
        };
        let mut destination = content_precise;
        match mode {
            ImageMode::ScaleToFill | ImageMode::WidthFix | ImageMode::HeightFix => {}
            ImageMode::AspectFit => {
                let scale = (content_precise.width / iw).min(content_precise.height / ih);
                destination.width = iw * scale;
                destination.height = ih * scale;
                destination.x += (content_precise.width - destination.width) * 0.5;
                destination.y += (content_precise.height - destination.height) * 0.5;
            }
            ImageMode::AspectFill => {
                let scale = (content_precise.width / iw).max(content_precise.height / ih);
                source.width = content_precise.width / scale;
                source.height = content_precise.height / scale;
                source.x = (iw - source.width) * 0.5;
                source.y = (ih - source.height) * 0.5;
            }
            _ => {
                let (x, y) = match mode {
                    ImageMode::Top => (0.5, 0.0),
                    ImageMode::Bottom => (0.5, 1.0),
                    ImageMode::Left => (0.0, 0.5),
                    ImageMode::Right => (1.0, 0.5),
                    ImageMode::TopLeft => (0.0, 0.0),
                    ImageMode::TopRight => (1.0, 0.0),
                    ImageMode::BottomLeft => (0.0, 1.0),
                    ImageMode::BottomRight => (1.0, 1.0),
                    _ => (0.5, 0.5),
                };
                source.width = iw.min(content_precise.width);
                source.height = ih.min(content_precise.height);
                source.x = (iw - source.width) * x;
                source.y = (ih - source.height) * y;
                destination.width = source.width;
                destination.height = source.height;
                destination.x += (content_precise.width - destination.width) * x;
                destination.y += (content_precise.height - destination.height) * y;
            }
        }
        Some(Self {
            source: source.narrow()?,
            destination: destination.narrow()?,
            clip: content,
        })
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_IMAGE_ID_BYTES
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:/-".contains(&c))
}

impl ImageResource {
    pub fn validate(&self) -> Result<(), RenderError> {
        let pixels = (self.width as usize).checked_mul(self.height as usize);
        if self.width == 0
            || self.height == 0
            || self.width > MAX_IMAGE_DIMENSION
            || self.height > MAX_IMAGE_DIMENSION
            || pixels.is_none_or(|pixels| pixels > MAX_IMAGE_PIXELS)
            || pixels.and_then(|pixels| pixels.checked_mul(4)) != Some(self.pixels.len())
        {
            return Err(RenderError::InvalidImage(
                "invalid RGBA8 image dimensions or byte length".into(),
            ));
        }
        Ok(())
    }
}

pub(super) fn validate(frame: &RenderFrame) -> Result<(), RenderError> {
    if frame.images.len() > MAX_FRAME_IMAGES {
        return Err(RenderError::InvalidImage(
            "frame image resource count exceeds limit".into(),
        ));
    }
    let mut total = 0usize;
    for (id, image) in &frame.images {
        if !valid_id(id) {
            return Err(RenderError::InvalidImage(
                "invalid image resource id".into(),
            ));
        }
        image.validate()?;
        total = total
            .checked_add(image.pixels.len())
            .filter(|total| *total <= MAX_FRAME_IMAGE_BYTES)
            .ok_or_else(|| RenderError::InvalidImage("frame image byte budget exceeded".into()))?;
    }
    fn visit(node: &RenderNode, frame: &RenderFrame) -> Result<(), RenderError> {
        if let Some(image) = &node.image {
            if !valid_id(&image.resource) || !frame.images.contains_key(&image.resource) {
                return Err(RenderError::InvalidImage(
                    "missing or invalid image resource reference".into(),
                ));
            }
            let content = node.style.unwrap_or_default().content_box(node.bounds);
            if ![
                content.x,
                content.y,
                content.width,
                content.height,
                content.x + content.width,
                content.y + content.height,
            ]
            .into_iter()
            .all(f32::is_finite)
                || content.width < 0.0
                || content.height < 0.0
            {
                return Err(RenderError::InvalidImage(
                    "invalid image content box".into(),
                ));
            }
        } else if node.tag.as_deref() == Some("image")
            && node
                .attributes
                .get("src")
                .is_some_and(|src| !src.is_empty())
        {
            return Err(RenderError::Unsupported("image-resource-not-resolved"));
        }
        for child in &node.children {
            visit(child, frame)?;
        }
        Ok(())
    }
    visit(&frame.root, frame)
}

pub(super) fn draw_software(
    pixels: &mut [u8],
    surface: (u32, u32),
    node: &RenderNode,
    resource: &ImageResource,
    transform: Transform2D,
    opacity: f32,
    clips: &RasterClipState,
) {
    let style = node.style.unwrap_or_default();
    let Some(geometry) = ImageGeometry::new(
        style.content_box(node.bounds),
        resource.width,
        resource.height,
        node.image.as_ref().unwrap().mode,
    ) else {
        return;
    };
    let Some(inverse) = transform.inverse() else {
        return;
    };
    let dest = geometry.destination;
    let corners = [
        transform.apply((dest.x, dest.y)),
        transform.apply((dest.x + dest.width, dest.y)),
        transform.apply((dest.x, dest.y + dest.height)),
        transform.apply((dest.x + dest.width, dest.y + dest.height)),
    ];
    if corners.iter().any(|p| !p.0.is_finite() || !p.1.is_finite()) {
        return;
    }
    let left = corners
        .iter()
        .map(|p| p.0)
        .fold(f32::INFINITY, f32::min)
        .floor()
        .max(0.0) as u32;
    let top = corners
        .iter()
        .map(|p| p.1)
        .fold(f32::INFINITY, f32::min)
        .floor()
        .max(0.0) as u32;
    let right = (corners
        .iter()
        .map(|p| p.0)
        .fold(f32::NEG_INFINITY, f32::max)
        .ceil()
        .max(0.0) as u32)
        .min(surface.0);
    let bottom = (corners
        .iter()
        .map(|p| p.1)
        .fold(f32::NEG_INFINITY, f32::max)
        .ceil()
        .max(0.0) as u32)
        .min(surface.1);
    for y in top.max(clips.bounds.top)..bottom.min(clips.bounds.bottom) {
        for x in left.max(clips.bounds.left)..right.min(clips.bounds.right) {
            if !clips.contains(x, y) {
                continue;
            }
            let local = inverse.apply((x as f32 + 0.5, y as f32 + 0.5));
            if !dest.contains(local.0, local.1)
                || !geometry.clip.contains(local.0, local.1)
                || !rounded_rect_contains(node.bounds, local.0, local.1, style.border_radius)
            {
                continue;
            }
            let sx = (geometry.source.x + (local.0 - dest.x) * geometry.source.width / dest.width)
                .floor()
                .clamp(0.0, resource.width as f32 - 1.0) as usize;
            let sy = (geometry.source.y + (local.1 - dest.y) * geometry.source.height / dest.height)
                .floor()
                .clamp(0.0, resource.height as f32 - 1.0) as usize;
            let source = (sy * resource.width as usize + sx) * 4;
            let rgba = &resource.pixels[source..source + 4];
            let alpha = (f32::from(rgba[3]) * opacity).round().clamp(0.0, 255.0) as u8;
            let offset = (y as usize * surface.0 as usize + x as usize) * 4;
            blend_pixel(
                &mut pixels[offset..offset + 4],
                [rgba[0], rgba[1], rgba[2], alpha],
            );
        }
    }
}

#[cfg(feature = "skia-backend")]
#[derive(Clone)]
pub(super) struct NativeImage {
    resource: Arc<ImageResource>,
    image: skia::Image,
}

#[cfg(feature = "skia-backend")]
pub(super) fn prepare_native(
    resources: &BTreeMap<String, Arc<ImageResource>>,
    previous: &BTreeMap<String, NativeImage>,
) -> Result<BTreeMap<String, NativeImage>, RenderError> {
    resources
        .iter()
        .map(|(id, resource)| {
            if let Some(previous) = previous
                .get(id)
                .filter(|old| Arc::ptr_eq(&old.resource, resource))
            {
                return Ok((id.clone(), previous.clone()));
            }
            let info = skia::ImageInfo::new(
                (resource.width as i32, resource.height as i32),
                skia::ColorType::RGBA8888,
                skia::AlphaType::Unpremul,
                None,
            );
            let image = skia::images::raster_from_data(
                &info,
                skia::Data::new_copy(&resource.pixels),
                resource.width as usize * 4,
            )
            .ok_or(RenderError::Unsupported("skia-raster-image"))?;
            Ok((
                id.clone(),
                NativeImage {
                    resource: resource.clone(),
                    image,
                },
            ))
        })
        .collect()
}

#[cfg(feature = "skia-backend")]
pub(super) fn draw_native(
    canvas: &skia::Canvas,
    node: &RenderNode,
    resource: &NativeImage,
    opacity: f32,
) {
    let style = node.style.unwrap_or_default();
    let Some(geometry) = ImageGeometry::new(
        style.content_box(node.bounds),
        resource.resource.width,
        resource.resource.height,
        node.image.as_ref().unwrap().mode,
    ) else {
        return;
    };
    let rect = |r: Rect| skia::Rect::from_xywh(r.x, r.y, r.width, r.height);
    canvas.save();
    canvas.clip_rect(rect(geometry.clip), skia::ClipOp::Intersect, false);
    canvas.clip_rrect(
        skia::RRect::new_rect_radii(
            rect(node.bounds),
            &normalized_corner_radii(node.bounds, style.border_radius)
                .map(|r| skia::Vector::new(r.x, r.y)),
        ),
        skia::ClipOp::Intersect,
        false,
    );
    let mut paint = skia::Paint::default();
    paint.set_alpha_f(opacity);
    paint.set_anti_alias(false);
    canvas.draw_image_rect_with_sampling_options(
        &resource.image,
        Some((
            &rect(geometry.source),
            skia::canvas::SrcRectConstraint::Strict,
        )),
        rect(geometry.destination),
        skia::SamplingOptions::new(skia::FilterMode::Nearest, skia::MipmapMode::None),
        &paint,
    );
    canvas.restore();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f32, y: f32, width: f32, height: f32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn resource(width: u32, height: u32) -> Arc<ImageResource> {
        Arc::new(ImageResource {
            width,
            height,
            pixels: (0..width * height)
                .flat_map(|i| {
                    [
                        if i % 2 == 0 { 255 } else { 0 },
                        if i % 3 == 0 { 255 } else { 0 },
                        if i % 2 == 1 { 255 } else { 0 },
                        255,
                    ]
                })
                .collect(),
        })
    }

    fn frame(mode: ImageMode) -> RenderFrame {
        let mut root = RenderNode::new("root", rect(0.0, 0.0, 16.0, 16.0));
        root.background = Some(Color::WHITE);
        let mut image = RenderNode::new("image", rect(2.0, 2.0, 8.0, 8.0));
        image.tag = Some("image".into());
        image.image = Some(RenderImage {
            resource: "sha256:fixture".into(),
            mode,
        });
        root.children.push(image);
        RenderFrame {
            frame_id: 1,
            viewport: root.bounds,
            root,
            images: BTreeMap::from([("sha256:fixture".into(), resource(4, 2))]),
        }
    }

    fn sample(snapshot: &RenderSnapshot, x: usize, y: usize) -> &[u8] {
        let start = y * snapshot.stride as usize + x * 4;
        &snapshot.pixels[start..start + 4]
    }

    fn modes() -> [ImageMode; 14] {
        [
            ImageMode::ScaleToFill,
            ImageMode::AspectFit,
            ImageMode::AspectFill,
            ImageMode::WidthFix,
            ImageMode::HeightFix,
            ImageMode::Top,
            ImageMode::Bottom,
            ImageMode::Center,
            ImageMode::Left,
            ImageMode::Right,
            ImageMode::TopLeft,
            ImageMode::TopRight,
            ImageMode::BottomLeft,
            ImageMode::BottomRight,
        ]
    }

    #[test]
    fn image_wire_modes_and_legacy_frames_are_explicit() {
        for mode in modes() {
            assert_eq!(ImageMode::from_str(mode.as_str()).unwrap(), mode);
            assert_eq!(serde_json::to_value(mode).unwrap(), mode.as_str());
            assert_eq!(
                serde_json::from_value::<ImageMode>(serde_json::json!(mode.as_str())).unwrap(),
                mode
            );
        }
        assert!(ImageMode::from_str("AspectFit").is_err());
        assert!(serde_json::from_value::<ImageMode>(serde_json::json!("invalid")).is_err());
        let old = serde_json::json!({"frame_id":0,"viewport":{"x":0,"y":0,"width":1,"height":1},
            "root":{"id":"root","bounds":{"x":0,"y":0,"width":1,"height":1},"background":null,"opacity":1,"children":[]}});
        let parsed: RenderFrame = serde_json::from_value(old.clone()).unwrap();
        assert!(parsed.images.is_empty());
        assert!(parsed.root.image.is_none());
        let serialized = serde_json::to_value(&parsed).unwrap();
        assert!(serialized.get("images").is_none());
        assert!(serialized["root"].get("image").is_none());
        assert_eq!(
            serde_json::from_value::<RenderFrame>(serialized).unwrap(),
            parsed
        );
    }

    #[test]
    fn shared_geometry_contains_covers_and_aligns_original_pixels() {
        let content = rect(10.0, 20.0, 8.0, 8.0);
        let fit = ImageGeometry::new(content, 4, 2, ImageMode::AspectFit).unwrap();
        assert_eq!(fit.source, rect(0.0, 0.0, 4.0, 2.0));
        assert_eq!(fit.destination, rect(10.0, 22.0, 8.0, 4.0));
        let fill = ImageGeometry::new(content, 4, 2, ImageMode::AspectFill).unwrap();
        assert_eq!(fill.source, rect(1.0, 0.0, 2.0, 2.0));
        assert_eq!(fill.destination, content);
        let alignments = [
            (ImageMode::TopLeft, 0.0, 0.0),
            (ImageMode::Top, 0.5, 0.0),
            (ImageMode::TopRight, 1.0, 0.0),
            (ImageMode::Left, 0.0, 0.5),
            (ImageMode::Center, 0.5, 0.5),
            (ImageMode::Right, 1.0, 0.5),
            (ImageMode::BottomLeft, 0.0, 1.0),
            (ImageMode::Bottom, 0.5, 1.0),
            (ImageMode::BottomRight, 1.0, 1.0),
        ];
        for (mode, x, y) in alignments {
            let crop = ImageGeometry::new(rect(10.0, 20.0, 2.0, 2.0), 6, 4, mode).unwrap();
            assert_eq!(crop.source, rect(4.0 * x, 2.0 * y, 2.0, 2.0));
            assert_eq!(crop.destination, rect(10.0, 20.0, 2.0, 2.0));
            let small = ImageGeometry::new(content, 4, 2, mode).unwrap();
            assert_eq!(small.source, rect(0.0, 0.0, 4.0, 2.0));
            assert_eq!(
                small.destination,
                rect(10.0 + 4.0 * x, 20.0 + 6.0 * y, 4.0, 2.0)
            );
        }
        for mode in [
            ImageMode::ScaleToFill,
            ImageMode::WidthFix,
            ImageMode::HeightFix,
        ] {
            assert_eq!(
                ImageGeometry::new(content, 4, 2, mode).unwrap().destination,
                content
            );
        }
        assert!(
            ImageGeometry::new(rect(0.0, 0.0, 0.0, 10.0), 4, 2, ImageMode::AspectFit).is_none()
        );
    }

    fn assert_finite_positive_geometry(geometry: ImageGeometry) {
        for rect in [geometry.source, geometry.destination, geometry.clip] {
            assert!(rect.width > 0.0 && rect.height > 0.0, "{rect:?}");
            assert!(
                [
                    rect.x,
                    rect.y,
                    rect.width,
                    rect.height,
                    rect.x + rect.width,
                    rect.y + rect.height,
                ]
                .into_iter()
                .all(f32::is_finite),
                "{rect:?}"
            );
        }
    }

    #[test]
    fn tiny_content_has_finite_crops_and_unrepresentable_fit_is_empty() {
        let tiny = f32::from_bits(1);
        let content = rect(0.0, 0.0, tiny, tiny);
        let fill = ImageGeometry::new(content, 4, 2, ImageMode::AspectFill).unwrap();
        assert_eq!(fill.source, rect(1.0, 0.0, 2.0, 2.0));
        assert_eq!(fill.destination, content);
        assert_finite_positive_geometry(fill);
        // The fitted half-height rounds to zero in the f32 frame protocol;
        // skip the image rather than sending a degenerate rect to a painter.
        assert!(ImageGeometry::new(content, 4, 2, ImageMode::AspectFit).is_none());
        for mode in modes() {
            if let Some(geometry) = ImageGeometry::new(content, 4, 2, mode) {
                assert_finite_positive_geometry(geometry);
            }
        }
    }

    #[test]
    fn extreme_aspect_ratios_never_export_nonfinite_or_zero_rectangles() {
        for content in [
            rect(0.0, 0.0, f32::MAX / 4.0, f32::MIN_POSITIVE),
            rect(0.0, 0.0, f32::MIN_POSITIVE, f32::MAX / 4.0),
        ] {
            // The source crop itself cannot retain a nonzero f32 extent at
            // these ratios, even with valid f64 intermediate arithmetic.
            assert!(ImageGeometry::new(content, 4, 2, ImageMode::AspectFill).is_none());
            assert_finite_positive_geometry(
                ImageGeometry::new(content, 4, 2, ImageMode::AspectFit).unwrap(),
            );
            for mode in modes() {
                if let Some(geometry) = ImageGeometry::new(content, 4, 2, mode) {
                    assert_finite_positive_geometry(geometry);
                }
            }
        }
        assert_finite_positive_geometry(
            ImageGeometry::new(rect(0.0, 0.0, 1.0e10, 1.0e-10), 4, 2, ImageMode::AspectFill)
                .unwrap(),
        );
    }

    #[test]
    fn invalid_resources_references_and_unresolved_sources_retain_every_accepted_frame() {
        let accepted = frame(ImageMode::ScaleToFill);
        let mut software = SoftwareRenderer::new();
        let mut native = SkiaRenderer::new();
        let mut exported = SkiaRenderer::new_frame_export_only();
        for renderer in [
            &mut software as &mut dyn Renderer,
            &mut native,
            &mut exported,
        ] {
            renderer.commit(accepted.clone()).unwrap();
        }
        let software_before = software.snapshot();
        let native_before = native.snapshot();
        let mut cases = Vec::new();
        for (width, height, bytes) in [
            (0, 1, 0),
            (MAX_IMAGE_DIMENSION + 1, 1, 4),
            (8192, 8192, 0),
            (1, 1, 3),
            (1, 1, 5),
        ] {
            let mut invalid = accepted.clone();
            invalid.images.insert(
                "sha256:fixture".into(),
                Arc::new(ImageResource {
                    width,
                    height,
                    pixels: vec![0; bytes],
                }),
            );
            cases.push(invalid);
        }
        for id in [
            "",
            "bad id",
            "日本語",
            "../x?",
            &"a".repeat(MAX_IMAGE_ID_BYTES + 1),
            "missing",
        ] {
            let mut invalid = accepted.clone();
            invalid.root.children[0].image.as_mut().unwrap().resource = id.into();
            cases.push(invalid);
        }
        let mut invalid_key = accepted.clone();
        invalid_key.images.insert("bad key".into(), resource(1, 1));
        cases.push(invalid_key);
        let mut unresolved = accepted.clone();
        unresolved.root.children[0].image = None;
        unresolved.root.children[0]
            .attributes
            .insert("src".into(), "/photo.png".into());
        cases.push(unresolved);
        let mut count = accepted.clone();
        let pixel = resource(1, 1);
        for i in 0..MAX_FRAME_IMAGES {
            count.images.insert(format!("image:{i}"), pixel.clone());
        }
        cases.push(count);
        for mut invalid in cases {
            invalid.frame_id = 2;
            for renderer in [
                &mut software as &mut dyn Renderer,
                &mut native,
                &mut exported,
            ] {
                assert!(renderer.commit(invalid.clone()).is_err());
                assert_eq!(renderer.last_frame(), Some(&accepted));
            }
        }
        assert_eq!(software.snapshot(), software_before);
        assert_eq!(native.snapshot(), native_before);
        let mut empty = accepted;
        empty.root.children[0].image = None;
        empty.root.children[0]
            .attributes
            .insert("src".into(), String::new());
        software.commit(empty).unwrap();
    }

    #[test]
    fn aggregate_budget_counts_all_resources_without_copying_arc_pixels() {
        let mut frame = frame(ImageMode::ScaleToFill);
        frame.images.clear();
        let image = Arc::new(ImageResource {
            width: 4096,
            height: 4096,
            pixels: vec![0; MAX_IMAGE_BYTES],
        });
        frame.images.insert("sha256:fixture".into(), image.clone());
        frame.images.insert("second".into(), image.clone());
        validate(&frame).unwrap();
        frame.images.insert("third".into(), image);
        assert!(matches!(
            validate(&frame),
            Err(RenderError::InvalidImage(_))
        ));
    }

    #[test]
    fn content_box_image_blends_straight_alpha_and_keeps_border_and_padding() {
        let mut frame = frame(ImageMode::ScaleToFill);
        frame.images.insert(
            "sha256:fixture".into(),
            Arc::new(ImageResource {
                width: 1,
                height: 1,
                pixels: vec![255, 0, 0, 128],
            }),
        );
        let node = &mut frame.root.children[0];
        node.style = Some(LayoutStyle {
            padding: EdgeInsets {
                top: 1.0,
                right: 1.0,
                bottom: 1.0,
                left: 1.0,
            },
            border: [BorderSide {
                width: 1.0,
                color: Color::BLACK,
                style: BorderStyle::Solid,
            }; 4],
            ..LayoutStyle::default()
        });
        node.opacity = 0.5;
        let mut renderer = SoftwareRenderer::new();
        renderer.commit(frame.clone()).unwrap();
        let snapshot = renderer.snapshot().unwrap();
        assert_eq!(sample(&snapshot, 2, 2), [127, 127, 127, 255]);
        assert_eq!(sample(&snapshot, 3, 3), [255, 255, 255, 255]);
        assert_eq!(sample(&snapshot, 4, 4), [255, 191, 191, 255]);
        #[cfg(feature = "skia-backend")]
        {
            let mut native = SkiaRenderer::new();
            native.commit(frame).unwrap();
            let native = native.snapshot().unwrap();
            for (x, y) in [(2, 2), (3, 3), (4, 4), (7, 7)] {
                for (a, b) in sample(&snapshot, x, y).iter().zip(sample(&native, x, y)) {
                    assert!(a.abs_diff(*b) <= 1, "software/native alpha: {a} versus {b}");
                }
            }
        }
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_and_software_modes_share_pixels_and_cache_same_arc() {
        let mut native = SkiaRenderer::new();
        for mode in modes() {
            let frame = frame(mode);
            let mut software = SoftwareRenderer::new();
            software.commit(frame.clone()).unwrap();
            native.commit(frame.clone()).unwrap();
            assert_eq!(
                software.snapshot().unwrap().pixels,
                native.snapshot().unwrap().pixels,
                "{mode:?}"
            );
            let cached = native.native_images["sha256:fixture"].image.unique_id();
            native.commit(frame).unwrap();
            assert_eq!(
                native.native_images["sha256:fixture"].image.unique_id(),
                cached
            );
        }
    }

    #[test]
    fn image_follows_transformed_scrolling_rounded_clip_and_restores_siblings() {
        let mut frame = frame(ImageMode::ScaleToFill);
        frame.images.insert(
            "sha256:fixture".into(),
            Arc::new(ImageResource {
                width: 1,
                height: 1,
                pixels: vec![0, 0, 255, 255],
            }),
        );
        let mut image = frame.root.children.remove(0);
        image.bounds = rect(2.0, 2.0, 8.0, 8.0);
        let mut clip = RenderNode::new("clip", rect(2.0, 2.0, 6.0, 6.0)).with_style(LayoutStyle {
            transform: Some(Transform2D {
                e: 2.0,
                f: 1.0,
                ..Transform2D::IDENTITY
            }),
            border_radius: [CornerRadius { x: 3.0, y: 3.0 }; 4],
            ..LayoutStyle::default()
        });
        clip.computed_style
            .insert("overflow".into(), "hidden".into());
        clip.scroll_container = true;
        clip.scroll_offset = Some(ScrollOffset {
            scroll_left: 1.0,
            scroll_top: 2.0,
        });
        clip.children.push(image);
        frame.root.children.push(clip);
        let mut later = RenderNode::new("later", rect(12.0, 12.0, 2.0, 2.0));
        later.background = Some(Color::BLACK);
        frame.root.children.push(later);
        let mut software = SoftwareRenderer::new();
        software.commit(frame.clone()).unwrap();
        let snapshot = software.snapshot().unwrap();
        assert_eq!(sample(&snapshot, 4, 3), [255, 255, 255, 255]);
        assert_eq!(sample(&snapshot, 6, 4), [0, 0, 255, 255]);
        assert_eq!(sample(&snapshot, 6, 10), [255, 255, 255, 255]);
        assert_eq!(sample(&snapshot, 12, 12), [0, 0, 0, 255]);
        assert_eq!(frame.root.hit_test(6.5, 4.5).unwrap().id, "image");
        #[cfg(feature = "skia-backend")]
        {
            let mut native = SkiaRenderer::new();
            native.commit(frame).unwrap();
            let native = native.snapshot().unwrap();
            for (x, y) in [(4, 3), (6, 4), (6, 10), (12, 12)] {
                assert_eq!(sample(&snapshot, x, y), sample(&native, x, y));
            }
        }
    }
}
