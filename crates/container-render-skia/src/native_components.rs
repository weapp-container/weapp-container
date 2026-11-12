//! Native media frames enter the ordinary image content phase. The shared
//! paint plan remains the sole authority for clipping, stacking and opacity.
use super::*;
use std::collections::BTreeSet;

const PREFIX: &str = "weapp-native-component-frame:";
const MAX_COMPONENT_FRAME_BYTES: usize = 1024 * 1024;
const MAX_COMPONENT_BYTES: usize = 16 * 1024 * 1024;

fn media_node(node: &RenderNode) -> bool {
    matches!(
        node.tag.as_deref(),
        Some("camera" | "video" | "live-player" | "live-pusher")
    )
}

fn identity(node: &RenderNode) -> &str {
    node.event_identity.as_deref().unwrap_or(&node.id)
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
    components: &mut BTreeMap<String, Arc<ImageResource>>,
) -> Result<(), RenderError> {
    remove_attached(&mut frame.root);
    frame.images.retain(|id, _| !id.starts_with(PREFIX));
    fn visit(
        node: &mut RenderNode,
        resources: &mut BTreeMap<String, Arc<ImageResource>>,
        components: &BTreeMap<String, Arc<ImageResource>>,
        used: &mut BTreeSet<String>,
    ) {
        if media_node(node) {
            let id = identity(node).to_owned();
            if let Some(image) = components.get(&id) {
                let resource = format!("{PREFIX}{}", used.len());
                used.insert(id);
                let mode = match node.attributes.get("object-fit").map(String::as_str) {
                    Some("contain") => ImageMode::AspectFit,
                    Some("fill") => ImageMode::ScaleToFill,
                    _ if node.tag.as_deref() == Some("camera") => ImageMode::AspectFill,
                    _ => ImageMode::AspectFit,
                };
                node.image = Some(RenderImage {
                    resource: resource.clone(),
                    mode,
                });
                resources.insert(resource, image.clone());
            }
        }
        for child in &mut node.children {
            visit(child, resources, components, used);
        }
    }
    let mut used = BTreeSet::new();
    visit(&mut frame.root, &mut frame.images, components, &mut used);
    components.retain(|id, _| used.contains(id));
    Ok(())
}

impl SkiaRenderer {
    /// Repaint a host-owned media image at an existing component content slot.
    /// Preparation is transactional; rejection keeps accepted pixels/resources.
    /// A new layout automatically retains only frames for surviving media nodes.
    pub fn update_component_frame(
        &mut self,
        node_id: &str,
        image: ImageResource,
    ) -> Result<(), RenderError> {
        image.validate()?;
        if image.width > 1024
            || image.height > 1024
            || image.pixels.len() > MAX_COMPONENT_FRAME_BYTES
        {
            return Err(RenderError::InvalidImage(
                "native component frame exceeds one MiB/1024 dimension budget".into(),
            ));
        }
        let frame = self.last_frame().cloned().ok_or(RenderError::Unsupported(
            "native-component-frame-without-page",
        ))?;
        let mut pending = vec![&frame.root];
        let mut found = false;
        while let Some(node) = pending.pop() {
            if media_node(node) && identity(node) == node_id {
                found = true;
                break;
            }
            pending.extend(&node.children);
        }
        if !found {
            return Err(RenderError::Unsupported(
                "native-component-frame-target-missing",
            ));
        }
        let mut components = self.component_frames.clone();
        components.insert(node_id.into(), Arc::new(image));
        if components
            .values()
            .map(|image| image.pixels.len())
            .sum::<usize>()
            > MAX_COMPONENT_BYTES
        {
            return Err(RenderError::InvalidImage(
                "native component frame total exceeds sixteen MiB budget".into(),
            ));
        }
        let prepared = self.prepare_page_frame_with_components(
            frame,
            PageFrameTargetPolicy::Legacy,
            components,
        )?;
        drop(prepared.accept());
        Ok(())
    }

    /// Drop native image resources during page/account retirement. The host
    /// retires its presentation surface before acknowledging account cleanup.
    pub fn clear_component_frames(&mut self) {
        let had_frames = !self.component_frames.is_empty();
        self.component_frames.clear();
        if let Some(frame) = self.software_fallback.last_frame.as_mut() {
            remove_attached(&mut frame.root);
            frame.images.retain(|id, _| !id.starts_with(PREFIX));
        }
        #[cfg(feature = "skia-backend")]
        self.native_images.retain(|id, _| !id.starts_with(PREFIX));
        if had_frames {
            self.software_fallback.last_snapshot = None;
            #[cfg(feature = "skia-backend")]
            {
                self.native_snapshot = None;
                self.native_surface = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bounds(x: f32, y: f32, width: f32, height: f32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }
    fn frame() -> RenderFrame {
        let area = bounds(0., 0., 4., 2.);
        let mut root = RenderNode::new("root", area);
        root.background = Some(Color::BLACK);
        let mut camera = RenderNode::new("camera", bounds(0., 0., 3., 2.));
        camera.tag = Some("camera".into());
        let mut above = RenderNode::new("above", bounds(1., 0., 1., 2.));
        above.background = Some(Color {
            red: 0,
            green: 255,
            blue: 0,
            alpha: 255,
        });
        root.children = vec![camera, above];
        RenderFrame {
            frame_id: 1,
            viewport: area,
            root,
            images: BTreeMap::new(),
        }
    }
    fn image() -> ImageResource {
        ImageResource {
            width: 1,
            height: 1,
            pixels: vec![255, 0, 0, 255],
        }
    }
    #[test]
    fn media_pixels_follow_content_order_and_survive_layout_then_retire() {
        let mut renderer = SkiaRenderer::new();
        renderer.commit(frame()).unwrap();
        renderer.update_component_frame("camera", image()).unwrap();
        let pixels = renderer.snapshot().unwrap().pixels;
        assert_eq!(&pixels[0..4], &[255, 0, 0, 255]);
        assert_eq!(&pixels[4..8], &[0, 255, 0, 255]);
        assert_eq!(&pixels[8..12], &[255, 0, 0, 255]);
        let mut next = frame();
        next.frame_id = 2;
        next.root.children[0].bounds = bounds(2., 0., 2., 2.);
        renderer.commit(next).unwrap();
        assert_eq!(
            &renderer.snapshot().unwrap().pixels[8..12],
            &[255, 0, 0, 255]
        );
        let mut next = frame();
        next.root.children.remove(0);
        renderer.commit(next).unwrap();
        assert!(renderer.component_frames.is_empty());
        assert!(renderer.last_frame().unwrap().images.is_empty());
    }
    #[test]
    fn invalid_native_repaint_is_transactional_and_does_not_invent_nodes() {
        let mut renderer = SkiaRenderer::new();
        renderer.commit(frame()).unwrap();
        let revision = renderer.snapshot_revision();
        assert!(renderer.update_component_frame("missing", image()).is_err());
        assert_eq!(renderer.snapshot_revision(), revision);
        assert!(renderer.component_frames.is_empty());
        let mut invalid = image();
        invalid.pixels.pop();
        assert!(renderer.update_component_frame("camera", invalid).is_err());
        assert_eq!(renderer.snapshot_revision(), revision);
    }
}
