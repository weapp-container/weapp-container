//! Trusted Canvas owners publish immutable resources through ordinary image paint.
//! Ownership keys are supplied by the runtime, never decoded from a RenderFrame.
use super::*;
use std::collections::BTreeSet;

const PREFIX: &str = "weapp-owned-canvas:";
pub const MAX_OWNED_CANVASES: usize = 256;
pub const MAX_OWNED_CANVAS_BYTES: usize = 64 * 1024 * 1024;
const MAX_OWNER_ID_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct CanvasOwnerKey {
    pub page_id: u64,
    pub page_incarnation: u64,
    pub scope_id: Option<String>,
    pub scope_incarnation: Option<u64>,
    pub node_identity: String,
    pub node_generation: u64,
}

impl CanvasOwnerKey {
    pub(super) fn validate(&self) -> Result<(), RenderError> {
        if self.page_id == 0
            || self.page_incarnation == 0
            || self.node_generation == 0
            || self.node_identity.is_empty()
            || self.node_identity.len() > MAX_OWNER_ID_BYTES
            || self.scope_id.is_some() != self.scope_incarnation.is_some()
            || self.scope_incarnation == Some(0)
            || self
                .scope_id
                .as_ref()
                .is_some_and(|scope| scope.is_empty() || scope.len() > MAX_OWNER_ID_BYTES)
        {
            return Err(RenderError::InvalidCanvas(
                "invalid owned canvas key".into(),
            ));
        }
        Ok(())
    }
}

pub(super) struct OwnedCanvasSurface {
    pub(super) history: Vec<CanvasCommand>,
    pub(super) batch_starts: Vec<usize>,
    pub(super) snapshot: RenderSnapshot,
    pub(super) image: Option<Arc<ImageResource>>,
    pub(super) retained_bytes: usize,
}
pub(super) type OwnedCanvasSurfaces = BTreeMap<CanvasOwnerKey, Arc<OwnedCanvasSurface>>;

/// Owns complete replacement maps so accept only moves fields and never
/// allocates a BTreeMap node or drops the former surface in a joint publisher.
pub(super) struct PreparedOwnedCanvasUpdate {
    pub(super) owner: CanvasOwnerKey,
    pub(super) surfaces: OwnedCanvasSurfaces,
}
impl PreparedOwnedCanvasUpdate {
    pub(super) fn snapshot(&self) -> &RenderSnapshot {
        &self.surfaces[&self.owner].snapshot
    }
}

/// Bound retained pixel and replay allocations, including JSON container
/// storage. The command-wire budget alone undercounts small JSON values.
pub(super) fn retained_bytes(
    owner: &CanvasOwnerKey,
    history: &[CanvasCommand],
    history_capacity: usize,
    boundaries_capacity: usize,
    pixel_bytes: usize,
) -> Result<usize, RenderError> {
    fn add(total: &mut usize, bytes: usize) -> Result<(), RenderError> {
        *total = total
            .checked_add(bytes)
            .ok_or(RenderError::PixelBufferOverflow)?;
        Ok(())
    }
    fn values(total: &mut usize, value: &Value) -> Result<(), RenderError> {
        match value {
            Value::String(text) => add(total, text.capacity())?,
            Value::Array(items) => {
                add(
                    total,
                    items
                        .capacity()
                        .checked_mul(std::mem::size_of::<Value>())
                        .ok_or(RenderError::PixelBufferOverflow)?,
                )?;
                for item in items {
                    values(total, item)?;
                }
            }
            Value::Object(items) => {
                // A conservative per-entry charge also covers partially full
                // BTreeMap nodes, their pointers and allocator metadata.
                add(
                    total,
                    items
                        .len()
                        .checked_mul(1024)
                        .ok_or(RenderError::PixelBufferOverflow)?,
                )?;
                for (key, value) in items {
                    add(total, key.capacity())?;
                    values(total, value)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    let mut total = pixel_bytes
        .checked_mul(2)
        .ok_or(RenderError::PixelBufferOverflow)?;
    add(
        &mut total,
        std::mem::size_of::<OwnedCanvasSurface>() + std::mem::size_of::<CanvasOwnerKey>() + 1024,
    )?;
    add(&mut total, owner.node_identity.capacity())?;
    if let Some(scope) = &owner.scope_id {
        add(&mut total, scope.capacity())?;
    }
    add(
        &mut total,
        history_capacity
            .checked_mul(std::mem::size_of::<CanvasCommand>())
            .ok_or(RenderError::PixelBufferOverflow)?,
    )?;
    add(
        &mut total,
        boundaries_capacity
            .checked_mul(std::mem::size_of::<usize>())
            .ok_or(RenderError::PixelBufferOverflow)?,
    )?;
    for command in history {
        add(&mut total, command.op.capacity())?;
        add(
            &mut total,
            command
                .args
                .capacity()
                .checked_mul(std::mem::size_of::<Value>())
                .ok_or(RenderError::PixelBufferOverflow)?,
        )?;
        for value in &command.args {
            values(&mut total, value)?;
        }
    }
    Ok(total)
}

pub(super) fn image_from_snapshot(
    snapshot: &RenderSnapshot,
) -> Result<Option<Arc<ImageResource>>, RenderError> {
    if snapshot.width == 0 || snapshot.height == 0 {
        return Ok(None);
    }
    if snapshot.format != "rgba8-premultiplied"
        || snapshot.stride
            != snapshot
                .width
                .checked_mul(4)
                .ok_or(RenderError::PixelBufferOverflow)?
    {
        return Err(RenderError::InvalidCanvas(
            "owned canvas snapshot must be tightly packed premultiplied RGBA8".into(),
        ));
    }
    let mut pixels = snapshot.pixels.clone();
    for rgba in pixels.as_chunks_mut::<4>().0 {
        let alpha = u32::from(rgba[3]);
        for channel in &mut rgba[..3] {
            *channel = (u32::from(*channel) * 255 + alpha / 2)
                .checked_div(alpha)
                .unwrap_or(0)
                .min(255) as u8;
        }
    }
    let image = ImageResource {
        width: snapshot.width,
        height: snapshot.height,
        pixels,
    };
    image.validate()?;
    Ok(Some(Arc::new(image)))
}

fn remove_attached(node: &mut RenderNode) {
    if node
        .image
        .as_ref()
        .is_some_and(|image| image.resource.starts_with(PREFIX))
    {
        node.image = None;
    }
    for child in &mut node.children {
        remove_attached(child);
    }
}

pub(super) fn attach(
    frame: &mut RenderFrame,
    bindings: &[CanvasOwnerKey],
    surfaces: &OwnedCanvasSurfaces,
) -> Result<(), RenderError> {
    if bindings.len() > MAX_OWNED_CANVASES {
        return Err(RenderError::InvalidCanvas(
            "owned canvas binding count exceeded".into(),
        ));
    }
    let mut identities = BTreeSet::new();
    for binding in bindings {
        binding.validate()?;
        if !identities.insert(binding.node_identity.as_str()) {
            return Err(RenderError::InvalidCanvas(
                "duplicate owned canvas node binding".into(),
            ));
        }
    }
    remove_attached(&mut frame.root);
    frame.images.retain(|id, _| !id.starts_with(PREFIX));
    fn visit(
        node: &mut RenderNode,
        bindings: &[CanvasOwnerKey],
        surfaces: &OwnedCanvasSurfaces,
        images: &mut BTreeMap<String, Arc<ImageResource>>,
        found: &mut BTreeSet<String>,
    ) -> Result<(), RenderError> {
        if let Some(binding) = bindings
            .iter()
            .find(|binding| node.event_identity.as_deref() == Some(binding.node_identity.as_str()))
        {
            if node.tag.as_deref() != Some("canvas")
                || node.event_owner_scope_id != binding.scope_id
                || !found.insert(binding.node_identity.clone())
            {
                return Err(RenderError::InvalidCanvas(
                    "owned canvas binding does not match exact canvas node and scope".into(),
                ));
            }
            // Canvas content never inherits a caller-supplied image reference.
            node.image = None;
            if let Some(image) = surfaces
                .get(binding)
                .and_then(|surface| surface.image.as_ref())
            {
                let resource = format!("{PREFIX}{}", found.len());
                node.image = Some(RenderImage {
                    resource: resource.clone(),
                    mode: ImageMode::ScaleToFill,
                });
                images.insert(resource, image.clone());
            }
        }
        for child in &mut node.children {
            visit(child, bindings, surfaces, images, found)?;
        }
        Ok(())
    }
    let mut found = BTreeSet::new();
    visit(
        &mut frame.root,
        bindings,
        surfaces,
        &mut frame.images,
        &mut found,
    )?;
    if found.len() != bindings.len() {
        return Err(RenderError::InvalidCanvas(
            "owned canvas binding target missing".into(),
        ));
    }
    Ok(())
}

impl SkiaRenderer {
    pub(super) fn commit_retained_page_frame(
        &mut self,
        frame: RenderFrame,
    ) -> Result<(), RenderError> {
        let bindings = self.canvas_bindings.clone();
        drop(
            self.prepare_page_frame_with_canvas_bindings(
                frame,
                PageFrameTargetPolicy::Legacy,
                bindings,
            )?
            .accept(),
        );
        Ok(())
    }

    pub fn owned_canvas_snapshot(&self, owner: &CanvasOwnerKey) -> Option<RenderSnapshot> {
        self.canvas
            .owned
            .get(owner)
            .map(|surface| surface.snapshot.clone())
    }

    pub fn prepare_owned_canvas_draw(
        &mut self,
        owner: &CanvasOwnerKey,
        frame: CanvasFrame,
    ) -> Result<PreparedPageFrame<'_>, RenderError> {
        if !self.canvas_bindings.contains(owner) {
            return Err(RenderError::InvalidCanvas(
                "owned canvas binding is retired or not accepted".into(),
            ));
        }
        let retained = self
            .last_frame()
            .cloned()
            .ok_or(RenderError::Unsupported("owned-canvas-without-page"))?;
        let update = self.canvas.prepare_owned_update(owner, frame)?;
        let bindings = self.canvas_bindings.clone();
        self.prepare_page_frame_with_owned_update(
            retained,
            PageFrameTargetPolicy::Legacy,
            bindings,
            Some(update),
        )
    }

    /// Retire authorization and future attachment by exact runtime-owned keys.
    /// Previously captured frames retain their immutable resource allocations.
    pub fn retire_owned_canvases(&mut self, active: &BTreeSet<CanvasOwnerKey>) {
        self.canvas.owned.retain(|owner, _| active.contains(owner));
        self.canvas_bindings.retain(|owner| active.contains(owner));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rect(x: f32, y: f32, width: f32, height: f32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn owner(page: u64) -> CanvasOwnerKey {
        CanvasOwnerKey {
            page_id: page,
            page_incarnation: 1,
            scope_id: None,
            scope_incarnation: None,
            node_identity: "occurrence:opaque/canvas".into(),
            node_generation: 1,
        }
    }

    fn page(owner: &CanvasOwnerKey) -> RenderFrame {
        let viewport = rect(0., 0., 4., 2.);
        let mut root = RenderNode::new("page", viewport);
        root.background = Some(Color::BLACK);
        let mut canvas = RenderNode::new("same-public-id", rect(0., 0., 3., 2.));
        canvas.tag = Some("canvas".into());
        canvas.event_identity = Some(owner.node_identity.clone());
        canvas.event_owner_scope_id = owner.scope_id.clone();
        canvas
            .attributes
            .insert("canvas-id".into(), "shared".into());
        root.children.push(canvas);
        RenderFrame {
            frame_id: owner.page_id,
            viewport,
            root,
            images: BTreeMap::new(),
        }
    }

    fn bind(renderer: &mut SkiaRenderer, owner: &CanvasOwnerKey) {
        drop(
            renderer
                .prepare_page_frame_with_canvas_bindings(
                    page(owner),
                    PageFrameTargetPolicy::Legacy,
                    vec![owner.clone()],
                )
                .unwrap()
                .accept(),
        );
    }

    fn draw(color: &str, x: f32, width: f32, reserve: bool) -> CanvasFrame {
        CanvasFrame {
            frame_id: 9,
            canvas_id: "shared".into(),
            width: 3,
            height: 2,
            reserve,
            commands: vec![
                CanvasCommand {
                    op: "setFillStyle".into(),
                    args: vec![json!(color)],
                },
                CanvasCommand {
                    op: "fillRect".into(),
                    args: vec![json!(x), json!(0), json!(width), json!(2)],
                },
            ],
        }
    }

    fn paint(renderer: &mut SkiaRenderer, owner: &CanvasOwnerKey, color: &str) {
        drop(
            renderer
                .prepare_owned_canvas_draw(owner, draw(color, 0., 3., false))
                .unwrap()
                .accept(),
        );
    }

    fn sample(snapshot: &RenderSnapshot, x: usize, y: usize) -> [u8; 4] {
        let offset = y * snapshot.stride as usize + x * 4;
        snapshot.pixels[offset..offset + 4].try_into().unwrap()
    }

    #[test]
    fn all_legal_premultiplied_channels_roundtrip_and_zero_alpha_canonicalizes() {
        let mut pixels = Vec::new();
        for alpha in 0..=255u8 {
            for channel in 0..=255u8 {
                let channel = channel.min(alpha);
                pixels.extend_from_slice(&[channel, channel / 2, alpha - channel, alpha]);
            }
        }
        let snapshot = RenderSnapshot {
            frame_id: 1,
            width: 256,
            height: 256,
            stride: 1024,
            format: "rgba8-premultiplied".into(),
            pixels,
        };
        let image = image_from_snapshot(&snapshot).unwrap().unwrap();
        for (straight, expected) in image
            .pixels
            .as_chunks::<4>()
            .0
            .iter()
            .zip(snapshot.pixels.as_chunks::<4>().0)
        {
            let mut actual = [0; 4];
            blend_pixel(&mut actual, *straight);
            assert_eq!(actual.as_slice(), expected, "straight={straight:?}");
        }
        let transparent = RenderSnapshot {
            frame_id: 2,
            width: 1,
            height: 1,
            stride: 4,
            format: "rgba8-premultiplied".into(),
            pixels: vec![255, 37, 19, 0],
        };
        assert_eq!(
            image_from_snapshot(&transparent).unwrap().unwrap().pixels,
            [0, 0, 0, 0]
        );
        // The immutable resource has the existing straight-RGBA contract;
        // source pixels have already incurred their original 8-bit rounding.
        #[cfg(feature = "skia-backend")]
        {
            let mut frame = page(&owner(1));
            frame.viewport = rect(0., 0., 256., 256.);
            frame.root.bounds = frame.viewport;
            frame.root.background = None;
            frame.root.children.clear();
            frame.root.image = Some(RenderImage {
                resource: "roundtrip".into(),
                mode: ImageMode::ScaleToFill,
            });
            frame.images.insert("roundtrip".into(), image);
            let mut native = SkiaRenderer::new();
            native.commit(frame).unwrap();
            for (actual, expected) in native
                .snapshot_ref()
                .unwrap()
                .pixels
                .iter()
                .zip(&snapshot.pixels)
            {
                assert!(actual.abs_diff(*expected) <= 1);
            }
        }
    }

    #[test]
    fn owned_pixels_use_page_transform_ancestor_opacity_clip_and_sibling_order() {
        let key = owner(1);
        let mut frame = page(&key);
        frame.viewport = rect(0., 0., 8., 4.);
        frame.root.bounds = frame.viewport;
        frame.root.background = Some(Color::WHITE);
        let mut canvas = frame.root.children.remove(0);
        canvas.bounds = rect(0., 0., 6., 2.);
        let mut group = RenderNode::new("clip", rect(0., 0., 4., 2.)).with_style(LayoutStyle {
            transform: Some(Transform2D {
                e: 2.,
                f: 1.,
                ..Transform2D::IDENTITY
            }),
            ..LayoutStyle::default()
        });
        group.opacity = 0.5;
        group
            .computed_style
            .insert("overflow".into(), "hidden".into());
        group.children.push(canvas);
        let mut above = RenderNode::new("sibling", rect(3., 1., 1., 2.));
        above.background = Some(Color {
            red: 0,
            green: 255,
            blue: 0,
            alpha: 255,
        });
        frame.root.children = vec![group, above];
        let mut renderer = SkiaRenderer::new();
        drop(
            renderer
                .prepare_page_frame_with_canvas_bindings(
                    frame,
                    PageFrameTargetPolicy::Legacy,
                    vec![key.clone()],
                )
                .unwrap()
                .accept(),
        );
        paint(&mut renderer, &key, "red");
        let pixels = renderer.snapshot_ref().unwrap();
        assert_eq!(sample(pixels, 1, 1), [255, 255, 255, 255]);
        assert_eq!(sample(pixels, 2, 1), [255, 127, 127, 255]);
        assert_eq!(sample(pixels, 3, 1), [0, 255, 0, 255]);
        assert_eq!(sample(pixels, 5, 1), [255, 127, 127, 255]);
        assert_eq!(sample(pixels, 6, 1), [255, 255, 255, 255]);
        assert_eq!(sample(pixels, 2, 3), [255, 255, 255, 255]);
        let accepted = renderer.last_frame().unwrap();
        assert_eq!(accepted.root.children[0].children[0].bounds.width, 6.);
        assert_eq!(accepted.images.len(), 1);
        let mut software = SoftwareRenderer::new();
        software.commit(accepted.clone()).unwrap();
        assert_eq!(software.snapshot().unwrap().pixels, pixels.pixels);
    }

    #[test]
    fn low_alpha_canvas_is_premultiplied_once_before_ancestor_group_opacity() {
        let key = owner(1);
        let mut frame = page(&key);
        frame.root.background = None;
        frame.root.opacity = 0.5;
        let mut renderer = SkiaRenderer::new();
        drop(
            renderer
                .prepare_page_frame_with_canvas_bindings(
                    frame,
                    PageFrameTargetPolicy::Legacy,
                    vec![key.clone()],
                )
                .unwrap()
                .accept(),
        );
        paint(&mut renderer, &key, "#ff000005");
        assert_eq!(
            sample(&renderer.owned_canvas_snapshot(&key).unwrap(), 0, 0),
            [5, 0, 0, 5]
        );
        assert_eq!(sample(renderer.snapshot_ref().unwrap(), 0, 0), [3, 0, 0, 3]);
        let mut software = SoftwareRenderer::new();
        software
            .commit(renderer.last_frame().unwrap().clone())
            .unwrap();
        assert_eq!(sample(&software.snapshot().unwrap(), 0, 0), [3, 0, 0, 3]);
    }

    #[test]
    fn canvas_id_never_shares_history_across_exact_owner_incarnations() {
        let mut keys = vec![owner(1), owner(2)];
        let mut generation = owner(1);
        generation.node_generation = 2;
        keys.push(generation);
        let mut page_incarnation = owner(1);
        page_incarnation.page_incarnation = 2;
        keys.push(page_incarnation);
        let mut scoped = owner(1);
        scoped.scope_id = Some("component".into());
        scoped.scope_incarnation = Some(1);
        keys.push(scoped.clone());
        scoped.scope_incarnation = Some(2);
        keys.push(scoped);
        let mut renderer = SkiaRenderer::new();
        renderer.commit_canvas(draw("blue", 1., 1., false)).unwrap();
        for key in &keys {
            bind(&mut renderer, key);
            drop(
                renderer
                    .prepare_owned_canvas_draw(key, draw("red", 0., 1., true))
                    .unwrap()
                    .accept(),
            );
            let snapshot = renderer.owned_canvas_snapshot(key).unwrap();
            assert_eq!(sample(&snapshot, 0, 0), [255, 0, 0, 255]);
            assert_eq!(sample(&snapshot, 1, 0), [0, 0, 0, 0]);
        }
        assert_eq!(renderer.canvas.owned.len(), keys.len());
        assert_eq!(
            sample(&renderer.canvas_snapshot("shared").unwrap(), 1, 0),
            [0, 0, 255, 255]
        );
        assert_eq!(renderer.canvas_ids().collect::<Vec<_>>(), ["shared"]);
    }

    #[test]
    fn bindings_require_exact_occurrence_tag_and_event_owner_scope() {
        let mut key = owner(1);
        key.scope_id = Some("declaring-component".into());
        key.scope_incarnation = Some(1);
        let mut renderer = SkiaRenderer::new();
        bind(&mut renderer, &key);
        let revision = renderer.snapshot_revision();
        let mut wrong_tag = page(&key);
        wrong_tag.root.children[0].tag = Some("image".into());
        let mut wrong_scope = page(&key);
        wrong_scope.root.children[0].event_owner_scope_id = Some("render-parent".into());
        wrong_scope.root.children[0].component_scope_id = key.scope_id.clone();
        let mut duplicate = page(&key);
        duplicate
            .root
            .children
            .push(duplicate.root.children[0].clone());
        let mut missing = page(&key);
        missing.root.children[0].event_identity = Some("other-occurrence".into());
        for frame in [wrong_tag, wrong_scope, duplicate, missing] {
            assert!(renderer
                .prepare_page_frame_with_canvas_bindings(
                    frame,
                    PageFrameTargetPolicy::Legacy,
                    vec![key.clone()]
                )
                .is_err());
            assert_eq!(renderer.snapshot_revision(), revision);
            assert_eq!(renderer.canvas_bindings, [key.clone()]);
        }
        assert!(renderer
            .prepare_page_frame_with_canvas_bindings(
                page(&key),
                PageFrameTargetPolicy::Legacy,
                vec![key.clone(), key.clone()]
            )
            .is_err());
        let mut projected = page(&key);
        projected.root.children[0].component_scope_id = Some("different-render-parent".into());
        drop(
            renderer
                .prepare_page_frame_with_canvas_bindings(
                    projected,
                    PageFrameTargetPolicy::Legacy,
                    vec![key],
                )
                .unwrap()
                .accept(),
        );
    }

    #[test]
    fn malformed_owned_keys_and_excess_bindings_never_create_authority() {
        let key = owner(1);
        let mut malformed = Vec::new();
        let mut zero_page = key.clone();
        zero_page.page_id = 0;
        malformed.push(zero_page);
        let mut zero_incarnation = key.clone();
        zero_incarnation.page_incarnation = 0;
        malformed.push(zero_incarnation);
        let mut zero_generation = key.clone();
        zero_generation.node_generation = 0;
        malformed.push(zero_generation);
        let mut missing_scope_token = key.clone();
        missing_scope_token.scope_id = Some("component".into());
        malformed.push(missing_scope_token);
        let mut zero_scope_token = key.clone();
        zero_scope_token.scope_id = Some("component".into());
        zero_scope_token.scope_incarnation = Some(0);
        malformed.push(zero_scope_token);
        let mut long_identity = key.clone();
        long_identity.node_identity = "x".repeat(MAX_OWNER_ID_BYTES + 1);
        malformed.push(long_identity);
        let mut renderer = SkiaRenderer::new();
        canvas_work_probes::reset();
        for invalid in malformed {
            assert!(renderer
                .canvas
                .prepare_owned_update(&invalid, draw("red", 0., 3., false))
                .is_err());
            assert!(renderer
                .prepare_page_frame_with_canvas_bindings(
                    page(&invalid),
                    PageFrameTargetPolicy::Legacy,
                    vec![invalid]
                )
                .is_err());
        }
        let excess = (1..=MAX_OWNED_CANVASES as u64 + 1).map(owner).collect();
        assert!(renderer
            .prepare_page_frame_with_canvas_bindings(
                page(&key),
                PageFrameTargetPolicy::Legacy,
                excess
            )
            .is_err());
        assert!(renderer.canvas.owned.is_empty());
        assert!(renderer.canvas_bindings.is_empty());
        assert!(renderer.last_frame().is_none());
        assert_eq!(
            canvas_work_probes::counts(),
            canvas_work_probes::Counts::default()
        );
    }

    #[test]
    fn legacy_frame_cannot_restore_owned_prefix_or_binding_authority() {
        let key = owner(1);
        let mut renderer = SkiaRenderer::new();
        bind(&mut renderer, &key);
        paint(&mut renderer, &key, "red");
        let captured = renderer.last_frame().unwrap().clone();
        assert_eq!(captured.images.len(), 1);
        renderer.commit(captured.clone()).unwrap();
        assert!(renderer.canvas_bindings.is_empty());
        assert!(renderer.last_frame().unwrap().images.is_empty());
        assert!(renderer.last_frame().unwrap().root.children[0]
            .image
            .is_none());
        assert!(renderer
            .prepare_owned_canvas_draw(&key, draw("blue", 0., 3., false))
            .is_err());
        assert!(renderer.owned_canvas_snapshot(&key).is_some());
        let mut forged = page(&key);
        forged.images = captured.images;
        forged.root.image = captured.root.children[0].image.clone();
        renderer.commit(forged).unwrap();
        assert!(renderer.last_frame().unwrap().root.image.is_none());
        assert!(renderer.last_frame().unwrap().images.is_empty());
    }

    #[test]
    fn dropped_or_page_failed_candidate_preserves_canvas_reserve_and_page_revision() {
        let key = owner(1);
        let mut renderer = SkiaRenderer::new();
        bind(&mut renderer, &key);
        drop(
            renderer
                .prepare_owned_canvas_draw(&key, draw("red", 0., 1., false))
                .unwrap()
                .accept(),
        );
        let old_canvas = renderer.owned_canvas_snapshot(&key).unwrap();
        let old_page = renderer.last_frame().unwrap().clone();
        let old_pixels = renderer.snapshot_ref().unwrap().clone();
        let revision = renderer.snapshot_revision();
        let old_surface = renderer.canvas.owned[&key].clone();
        let candidate = renderer
            .prepare_owned_canvas_draw(&key, draw("blue", 1., 1., true))
            .unwrap();
        assert_eq!(
            sample(candidate.owned_canvas_snapshot().unwrap(), 1, 0),
            [0, 0, 255, 255]
        );
        drop(candidate);
        assert_eq!(
            renderer.owned_canvas_snapshot(&key),
            Some(old_canvas.clone())
        );
        assert_eq!(renderer.snapshot_ref(), Some(&old_pixels));
        assert_eq!(renderer.last_frame(), Some(&old_page));
        assert_eq!(renderer.snapshot_revision(), revision);
        assert!(Arc::ptr_eq(&old_surface, &renderer.canvas.owned[&key]));
        renderer.software_fallback.snapshot_revision = u64::MAX;
        assert!(matches!(
            renderer.prepare_owned_canvas_draw(&key, draw("blue", 1., 1., true)),
            Err(RenderError::Unsupported("page-render-revision-exhausted"))
        ));
        assert_eq!(renderer.owned_canvas_snapshot(&key), Some(old_canvas));
        assert!(Arc::ptr_eq(&old_surface, &renderer.canvas.owned[&key]));
        renderer.software_fallback.snapshot_revision = revision;
        drop(
            renderer
                .prepare_owned_canvas_draw(&key, draw("green", 2., 1., true))
                .unwrap()
                .accept(),
        );
        let next = renderer.owned_canvas_snapshot(&key).unwrap();
        assert_eq!(sample(&next, 0, 0), [255, 0, 0, 255]);
        assert_eq!(sample(&next, 1, 0), [0, 0, 0, 0]);
        assert_eq!(sample(&next, 2, 0), [0, 128, 0, 255]);
        assert_eq!(renderer.canvas.owned[&key].batch_starts, [2]);
    }

    #[test]
    fn accepted_image_arcs_and_retirement_receipt_keep_old_pixels_immutable() {
        let key = owner(1);
        let mut renderer = SkiaRenderer::new();
        bind(&mut renderer, &key);
        paint(&mut renderer, &key, "red");
        let captured = renderer.last_frame().unwrap().clone();
        let image = captured.images.values().next().unwrap().clone();
        let old_surface = Arc::downgrade(&renderer.canvas.owned[&key]);
        let receipt = renderer
            .prepare_owned_canvas_draw(&key, draw("blue", 0., 3., false))
            .unwrap()
            .accept();
        assert!(old_surface.upgrade().is_some());
        assert_eq!(image.pixels, [255, 0, 0, 255].repeat(6));
        assert!(!Arc::ptr_eq(
            &image,
            renderer
                .last_frame()
                .unwrap()
                .images
                .values()
                .next()
                .unwrap()
        ));
        drop(receipt);
        assert!(old_surface.upgrade().is_none());
        renderer.retire_owned_canvases(&BTreeSet::new());
        assert!(renderer.owned_canvas_snapshot(&key).is_none());
        let mut replay = SoftwareRenderer::new();
        replay.commit(captured).unwrap();
        assert_eq!(sample(&replay.snapshot().unwrap(), 0, 0), [255, 0, 0, 255]);
        assert_eq!(image.pixels, [255, 0, 0, 255].repeat(6));
    }

    #[test]
    fn zero_dimension_clears_content_without_a_placeholder_image() {
        let key = owner(1);
        let mut renderer = SkiaRenderer::new();
        bind(&mut renderer, &key);
        paint(&mut renderer, &key, "red");
        for (width, height) in [(0, 2), (3, 0), (0, 0)] {
            let mut clear = draw("blue", 0., 3., false);
            clear.width = width;
            clear.height = height;
            drop(
                renderer
                    .prepare_owned_canvas_draw(&key, clear)
                    .unwrap()
                    .accept(),
            );
            let snapshot = renderer.owned_canvas_snapshot(&key).unwrap();
            assert_eq!((snapshot.width, snapshot.height), (width, height));
            assert!(snapshot.pixels.is_empty());
            assert!(renderer.canvas.owned[&key].image.is_none());
            assert!(renderer.last_frame().unwrap().root.children[0]
                .image
                .is_none());
            assert!(renderer.last_frame().unwrap().images.is_empty());
            assert_eq!(
                sample(renderer.snapshot_ref().unwrap(), 0, 0),
                [0, 0, 0, 255]
            );
        }
    }

    #[test]
    fn live_hidden_pages_survive_retirement_and_exact_retired_generation_is_denied() {
        let first = owner(1);
        let second = owner(2);
        let mut renderer = SkiaRenderer::new();
        bind(&mut renderer, &first);
        paint(&mut renderer, &first, "red");
        bind(&mut renderer, &second);
        paint(&mut renderer, &second, "blue");
        renderer.retire_owned_canvases(&BTreeSet::from([first.clone(), second.clone()]));
        assert_eq!(renderer.canvas.owned.len(), 2);
        assert!(renderer
            .prepare_owned_canvas_draw(&first, draw("green", 0., 3., false))
            .is_err());
        bind(&mut renderer, &first);
        assert_eq!(
            sample(renderer.snapshot_ref().unwrap(), 0, 0),
            [255, 0, 0, 255]
        );
        let mut replacement = first.clone();
        replacement.node_generation += 1;
        bind(&mut renderer, &replacement);
        renderer.retire_owned_canvases(&BTreeSet::from([replacement.clone(), second]));
        assert!(renderer.owned_canvas_snapshot(&first).is_none());
        assert!(renderer
            .prepare_owned_canvas_draw(&first, draw("green", 0., 3., true))
            .is_err());
        drop(
            renderer
                .prepare_owned_canvas_draw(&replacement, draw("green", 2., 1., true))
                .unwrap()
                .accept(),
        );
        let snapshot = renderer.owned_canvas_snapshot(&replacement).unwrap();
        assert_eq!(sample(&snapshot, 0, 0), [0, 0, 0, 0]);
        assert_eq!(sample(&snapshot, 2, 0), [0, 128, 0, 255]);
    }

    fn seeded_surface(bytes: usize) -> Arc<OwnedCanvasSurface> {
        Arc::new(OwnedCanvasSurface {
            history: Vec::new(),
            batch_starts: Vec::new(),
            snapshot: RenderSnapshot {
                frame_id: 0,
                width: 0,
                height: 0,
                stride: 0,
                format: "rgba8-premultiplied".into(),
                pixels: Vec::new(),
            },
            image: None,
            retained_bytes: bytes,
        })
    }

    #[test]
    fn aggregate_bytes_replace_old_charge_and_reject_before_backend_work() {
        let key = owner(1);
        let mut service = CanvasService::default();
        service
            .owned
            .insert(key.clone(), seeded_surface(MAX_OWNED_CANVAS_BYTES));
        let replacement = service
            .prepare_owned_update(&key, draw("red", 0., 3., false))
            .unwrap();
        assert!(replacement.surfaces[&key].retained_bytes < MAX_OWNED_CANVAS_BYTES);
        assert_eq!(service.owned[&key].retained_bytes, MAX_OWNED_CANVAS_BYTES);
        drop(replacement);
        canvas_work_probes::reset();
        assert!(service
            .prepare_owned_update(&owner(2), draw("blue", 0., 3., false))
            .is_err());
        assert_eq!(
            canvas_work_probes::counts(),
            canvas_work_probes::Counts::default()
        );
        assert_eq!(service.owned.len(), 1);
        assert_eq!(service.owned[&key].retained_bytes, MAX_OWNED_CANVAS_BYTES);
    }

    #[test]
    fn aggregate_owner_count_allows_replacement_but_rejects_new_key_before_work() {
        let mut service = CanvasService::default();
        for page_id in 1..=MAX_OWNED_CANVASES as u64 {
            service.owned.insert(owner(page_id), seeded_surface(1024));
        }
        canvas_work_probes::reset();
        assert!(service
            .prepare_owned_update(&owner(257), draw("red", 0., 3., false))
            .is_err());
        assert_eq!(
            canvas_work_probes::counts(),
            canvas_work_probes::Counts::default()
        );
        let replacement = service
            .prepare_owned_update(&owner(1), draw("red", 0., 3., false))
            .unwrap();
        assert_eq!(replacement.surfaces.len(), MAX_OWNED_CANVASES);
        assert_eq!(service.owned.len(), MAX_OWNED_CANVASES);
    }

    #[test]
    fn retained_density_and_media_repaints_keep_exact_bindings_and_canvas_arc() {
        let key = owner(1);
        let mut renderer = SkiaRenderer::new_frame_export_only();
        let mut frame = page(&key);
        let mut media = RenderNode::new("video", rect(3., 0., 1., 2.));
        media.tag = Some("video".into());
        frame.root.children.push(media);
        drop(
            renderer
                .prepare_page_frame_with_canvas_bindings(
                    frame,
                    PageFrameTargetPolicy::Legacy,
                    vec![key.clone()],
                )
                .unwrap()
                .accept(),
        );
        paint(&mut renderer, &key, "red");
        let surface = renderer.canvas.owned[&key].clone();
        let image = surface.image.as_ref().unwrap().clone();
        renderer.set_render_scale(2.).unwrap();
        renderer.repaint_accepted_layout(3.).unwrap();
        renderer
            .update_component_frame(
                "video",
                ImageResource {
                    width: 1,
                    height: 1,
                    pixels: vec![0, 0, 255, 255],
                },
            )
            .unwrap();
        assert_eq!(
            renderer.canvas_bindings.as_slice(),
            std::slice::from_ref(&key)
        );
        assert!(Arc::ptr_eq(&surface, &renderer.canvas.owned[&key]));
        assert!(renderer
            .last_frame()
            .unwrap()
            .images
            .values()
            .any(|resource| Arc::ptr_eq(resource, &image)));
        drop(
            renderer
                .prepare_owned_canvas_draw(&key, draw("green", 2., 1., true))
                .unwrap()
                .accept(),
        );
    }
}
