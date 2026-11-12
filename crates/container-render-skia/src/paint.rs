//! CSS paint contexts are independent of both document ancestry and spatial
//! ancestry. Compile the tree into phases; input and every raster backend consume
//! that same order. Never reparent the WXML tree to promote a positioned box.
use super::*;

pub const MAX_PAINT_NODES: usize = 100_000;
pub const MAX_PAINT_DEPTH: usize = 256;
pub const MAX_PAINT_PATH_ENTRIES: usize = 1_000_000;

pub(crate) fn validate_budget(root: &RenderNode) -> Result<(), RenderError> {
    let mut pending = vec![(root, 0usize)];
    let (mut nodes, mut paths) = (0usize, 0usize);
    while let Some((node, depth)) = pending.pop() {
        nodes += 1;
        paths += depth;
        if nodes > MAX_PAINT_NODES || depth > MAX_PAINT_DEPTH || paths > MAX_PAINT_PATH_ENTRIES {
            return Err(RenderError::PaintBudgetExceeded);
        }
        pending.extend(node.children.iter().map(|child| (child, depth + 1)));
    }
    Ok(())
}

pub(crate) fn validate_mode(root: &RenderNode) -> Result<(), RenderError> {
    if root.style.is_some_and(|style| style.flow.is_some()) {
        return Ok(());
    }
    let mut pending = vec![root];
    while let Some(node) = pending.pop() {
        if node
            .style
            .is_some_and(|style| style.z_index.is_some() || style.isolation)
        {
            return Err(RenderError::Unsupported("typed-stacking-without-css-root"));
        }
        pending.extend(&node.children);
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Op {
    Begin,
    Background,
    Content,
    End,
}

#[derive(Clone, Copy)]
pub(crate) struct Command {
    pub op: Op,
    pub node: usize,
}

pub(crate) struct PaintNode<'a> {
    pub node: &'a RenderNode,
    pub parent: Option<usize>,
    pub spatial_parent: Option<usize>,
    pub child_index: usize,
    pub transform: Transform2D,
    pub foreground: Color,
    pub clip: Option<usize>,
    child_clip: Option<usize>,
    pub displayed: bool,
    pub paint_active: bool,
    children: Vec<usize>,
}

struct ClipLink {
    value: WorldOverflowClip,
    parent: Option<usize>,
}

pub(crate) struct PaintPlan<'a> {
    pub nodes: Vec<PaintNode<'a>>,
    pub commands: Vec<Command>,
    clips: Vec<ClipLink>,
    css: bool,
}

#[derive(Serialize)]
pub(crate) struct WirePlan {
    version: u8,
    commands: Vec<WireCommand>,
}

#[derive(Serialize)]
struct WireCommand {
    op: Op,
    path: Vec<usize>,
}

#[derive(Default)]
struct FlowGroup {
    backgrounds: Vec<usize>,
    contents: Vec<Content>,
}

enum Content {
    Node(usize),
    Group(FlowGroup),
}

enum Unit {
    Context(usize),
    Positioned(FlowGroup),
}

#[derive(Default)]
struct ContextItems {
    negative: Vec<(i32, Unit)>,
    zero: Vec<Unit>,
    positive: Vec<(i32, Unit)>,
}

impl<'a> PaintPlan<'a> {
    pub(crate) fn new(root: &'a RenderNode) -> Self {
        let mut plan = Self::spatial(root);
        plan.build_commands();
        plan
    }

    pub(crate) fn new_validated(root: &'a RenderNode) -> Self {
        let mut plan = Self::spatial_validated(root);
        plan.build_commands();
        plan
    }

    fn build_commands(&mut self) {
        if self.nodes.first().is_some_and(|node| node.displayed) {
            if self.css {
                self.context(0);
            } else {
                self.legacy(0);
            }
        } else if self.css && !self.nodes.is_empty() {
            // Even a hidden root has one balanced wire context. It publishes
            // no background/content or input boxes.
            self.command(Op::Begin, 0);
            self.command(Op::End, 0);
        }
    }

    pub(crate) fn spatial(root: &'a RenderNode) -> Self {
        let mut plan = Self {
            nodes: Vec::new(),
            commands: Vec::new(),
            clips: Vec::new(),
            css: root.style.is_some_and(|style| style.flow.is_some()),
        };
        if validate_budget(root).is_ok() {
            plan.project(root, None, 0, None);
        }
        plan
    }

    pub(crate) fn spatial_validated(root: &'a RenderNode) -> Self {
        let mut plan = Self {
            nodes: Vec::new(),
            commands: Vec::new(),
            clips: Vec::new(),
            css: root.style.is_some_and(|style| style.flow.is_some()),
        };
        plan.project(root, None, 0, None);
        plan
    }

    // A single document traversal computes the spatial chain. Promotion in
    // context() changes neither this chain nor the event parent index.
    fn project(
        &mut self,
        node: &'a RenderNode,
        parent: Option<usize>,
        child_index: usize,
        absolute_container: Option<usize>,
    ) -> usize {
        let style = node.style.unwrap_or_default();
        let css = self.css;
        let spatial_parent = if node.is_viewport_fixed() {
            None
        } else if css && style.position == PositionMode::Absolute {
            absolute_container
        } else {
            parent
        };
        let parent_transform = spatial_parent.map_or(Transform2D::IDENTITY, |index| {
            let parent = &self.nodes[index];
            parent
                .transform
                .multiply(parent.node.descendant_translation())
        });
        let transform = node.traversal_transform(parent_transform);
        let inherited_clip = if node.is_viewport_fixed() {
            None
        } else if css && style.position == PositionMode::Absolute {
            // CSS overflow does not clip absolute descendants whose containing
            // block is outside that overflow box. Keep the containing block's
            // own clip and its ancestors; discard only the intervening clips.
            absolute_container.and_then(|index| self.nodes[index].child_clip)
        } else {
            parent.and_then(|index| self.nodes[index].child_clip)
        };
        let displayed = style.display != DisplayMode::None
            && parent.is_none_or(|index| self.nodes[index].displayed);
        let paint_active = displayed
            && node.opacity > 0.0
            && parent.is_none_or(|index| self.nodes[index].paint_active);
        let index = self.nodes.len();
        let child_clip = if let Some(clip) = node.descendant_clip(style.border_radius) {
            let clip_index = self.clips.len();
            self.clips.push(ClipLink {
                value: WorldOverflowClip { clip, transform },
                parent: inherited_clip,
            });
            Some(clip_index)
        } else {
            inherited_clip
        };
        let foreground = node
            .foreground
            .unwrap_or_else(|| parent.map_or(Color::BLACK, |index| self.nodes[index].foreground));
        self.nodes.push(PaintNode {
            node,
            parent,
            spatial_parent,
            child_index,
            transform,
            foreground,
            clip: inherited_clip,
            child_clip,
            displayed,
            paint_active,
            children: Vec::with_capacity(node.children.len()),
        });
        let absolute_container = if parent.is_none()
            || style.position != PositionMode::Static
            || style.transform.is_some()
        {
            Some(index)
        } else {
            absolute_container
        };
        for (child_index, child) in node.children.iter().enumerate() {
            let child = self.project(child, Some(index), child_index, absolute_container);
            self.nodes[index].children.push(child);
        }
        index
    }

    fn is_flex_item(&self, index: usize) -> bool {
        let entry = &self.nodes[index];
        !matches!(
            entry.node.style.unwrap_or_default().position,
            PositionMode::Absolute | PositionMode::Fixed
        ) && entry.parent.is_some_and(|parent| {
            self.nodes[parent]
                .node
                .style
                .and_then(|style| style.flow)
                .is_some_and(|flow| flow.context == FormattingContext::Flex)
        })
    }

    fn stack_level(&self, index: usize) -> Option<i32> {
        let style = self.nodes[index].node.style.unwrap_or_default();
        if style.position != PositionMode::Static || self.is_flex_item(index) {
            style.z_index
        } else {
            None
        }
    }

    fn is_context(&self, index: usize) -> bool {
        let node = self.nodes[index].node;
        let style = node.style.unwrap_or_default();
        index == 0
            || style.position == PositionMode::Fixed
            || style.transform.is_some()
            || node.opacity < 1.0
            || style.isolation
            || self.stack_level(index).is_some()
    }

    fn children(&self, index: usize, legacy: bool) -> Vec<usize> {
        let parent = &self.nodes[index];
        if legacy {
            return parent
                .node
                .child_paint_order()
                .into_iter()
                .map(|child| parent.children[child])
                .collect();
        }
        let mut children = parent.children.clone();
        children.sort_by_key(|index| {
            let child = &self.nodes[*index];
            (
                parent.node.child_flow_order(child.child_index),
                child.child_index,
            )
        });
        children
    }

    fn command(&mut self, op: Op, node: usize) {
        // Keep contexts, transforms, clips and opacity for visible descendants.
        // Only this node's own ink/target phases are suppressed.
        if matches!(op, Op::Background | Op::Content)
            && self.nodes[node].node.visibility == Visibility::Hidden
        {
            return;
        }
        self.commands.push(Command { op, node });
    }

    fn legacy(&mut self, index: usize) {
        if !self.nodes[index].displayed {
            return;
        }
        self.command(Op::Begin, index);
        self.command(Op::Background, index);
        self.command(Op::Content, index);
        for child in self.children(index, true) {
            self.legacy(child);
        }
        self.command(Op::End, index);
    }

    fn context(&mut self, index: usize) {
        let mut items = ContextItems::default();
        let group = self.group(index, &mut items);
        // Stable sort preserves order-modified document traversal for equal z.
        items.negative.sort_by_key(|item| item.0);
        items.positive.sort_by_key(|item| item.0);
        self.command(Op::Begin, index);
        self.command(Op::Background, index);
        for (_, unit) in items.negative {
            self.unit(unit);
        }
        self.emit_group(group);
        for unit in items.zero {
            self.unit(unit);
        }
        for (_, unit) in items.positive {
            self.unit(unit);
        }
        self.command(Op::End, index);
    }

    // The context/pseudo-group root background is handled by the caller. Its
    // content follows normal block backgrounds, then its children's content.
    fn group(&self, index: usize, items: &mut ContextItems) -> FlowGroup {
        let mut group = FlowGroup {
            contents: vec![Content::Node(index)],
            ..FlowGroup::default()
        };
        for child in self.children(index, false) {
            self.gather(child, &mut group, items);
        }
        group
    }

    fn gather(&self, index: usize, group: &mut FlowGroup, items: &mut ContextItems) {
        if !self.nodes[index].displayed {
            return;
        }
        if self.is_context(index) {
            let level = self.stack_level(index).unwrap_or(0);
            let unit = Unit::Context(index);
            if level < 0 {
                items.negative.push((level, unit));
            } else if level > 0 {
                items.positive.push((level, unit));
            } else {
                items.zero.push(unit);
            }
        } else if self.nodes[index].node.style.unwrap_or_default().position != PositionMode::Static
        {
            // Positioned auto is a paint group, not an isolating context. Its
            // positioned/context descendants stay in the surrounding items.
            // Reserve its position before collecting those descendants.
            let slot = items.zero.len();
            items.zero.push(Unit::Positioned(FlowGroup::default()));
            let mut local = self.group(index, items);
            local.backgrounds.insert(0, index);
            items.zero[slot] = Unit::Positioned(local);
        } else if self.is_flex_item(index) {
            // Flex items paint atomically like inline-blocks, while their
            // positioned descendants still participate in the owner context.
            let mut local = self.group(index, items);
            local.backgrounds.insert(0, index);
            group.contents.push(Content::Group(local));
        } else {
            group.backgrounds.push(index);
            group.contents.push(Content::Node(index));
            for child in self.children(index, false) {
                self.gather(child, group, items);
            }
        }
    }

    fn unit(&mut self, unit: Unit) {
        match unit {
            Unit::Context(index) => self.context(index),
            Unit::Positioned(group) => self.emit_group(group),
        }
    }

    fn emit_group(&mut self, group: FlowGroup) {
        for index in group.backgrounds {
            self.command(Op::Background, index);
        }
        for content in group.contents {
            match content {
                Content::Node(index) => self.command(Op::Content, index),
                Content::Group(group) => self.emit_group(group),
            }
        }
    }

    pub(crate) fn clips(&self, index: usize) -> impl Iterator<Item = WorldOverflowClip> + '_ {
        let mut next = self.nodes[index].clip;
        std::iter::from_fn(move || {
            let index = next?;
            let link = &self.clips[index];
            next = link.parent;
            Some(link.value)
        })
    }

    fn contains_hit(&self, index: usize, x: f32, y: f32) -> bool {
        let entry = &self.nodes[index];
        let Some(inverse) = entry.transform.inverse() else {
            return false;
        };
        let (local_x, local_y) = inverse.apply((x, y));
        rounded_rect_contains(
            entry.node.bounds,
            local_x,
            local_y,
            entry.node.style.unwrap_or_default().border_radius,
        ) && self.clips(index).all(|clip| {
            clip.transform.inverse().is_some_and(|inverse| {
                let (x, y) = inverse.apply((x, y));
                clip.clip.contains(x, y)
            })
        })
    }

    pub(crate) fn hit_path(&self, x: f32, y: f32) -> Vec<&'a RenderNode> {
        for command in self.commands.iter().rev() {
            let entry = &self.nodes[command.node];
            let content_hit = command.op == Op::Content
                && (entry.node.image.is_some()
                    || entry.node.text_layout.as_ref().map_or_else(
                        || {
                            entry
                                .node
                                .text
                                .as_deref()
                                .is_some_and(|text| !text.is_empty())
                        },
                        |layout| !layout.glyphs.is_empty(),
                    ));
            if command.op != Op::Background && !content_hit {
                continue;
            }
            if !self.contains_hit(command.node, x, y) {
                continue;
            }
            let mut target = command.node;
            if !entry.node.hit_testable {
                // Legacy recursive input always skips non-targetable nodes.
                // CSS anonymous text instead participates in its foreground
                // phase, targeting its containing element only inside that
                // element's own input box. Anonymous ink cannot enlarge it.
                if !self.css || !content_hit || entry.node.text.is_none() {
                    continue;
                }
                while !self.nodes[target].node.hit_testable {
                    let Some(parent) = self.nodes[target].parent else {
                        break;
                    };
                    target = parent;
                }
                if !self.nodes[target].node.hit_testable || !self.contains_hit(target, x, y) {
                    continue;
                }
            }
            if self.nodes[target].node.visibility == Visibility::Hidden {
                continue;
            }
            let mut path = Vec::new();
            let mut next = Some(target);
            while let Some(index) = next {
                path.push(self.nodes[index].node);
                next = self.nodes[index].parent;
            }
            path.reverse();
            return path;
        }
        Vec::new()
    }

    pub(crate) fn wire(&self) -> WirePlan {
        WirePlan {
            version: 1,
            commands: self
                .commands
                .iter()
                .map(|command| {
                    let mut path = Vec::new();
                    let mut index = command.node;
                    while let Some(parent) = self.nodes[index].parent {
                        path.push(self.nodes[index].child_index);
                        index = parent;
                    }
                    path.reverse();
                    WireCommand {
                        op: command.op,
                        path,
                    }
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validated_paint_plan_preserves_checked_order_and_hit_paths() {
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 32.0,
            height: 32.0,
        };
        let mut root = RenderNode::new("root", viewport);
        root.style = Some(LayoutStyle {
            flow: Some(FlowStyle::default()),
            ..LayoutStyle::default()
        });
        let mut child = RenderNode::new(
            "child",
            Rect {
                x: 4.0,
                y: 4.0,
                width: 12.0,
                height: 12.0,
            },
        );
        child.style = Some(LayoutStyle {
            flow: Some(FlowStyle::default()),
            ..LayoutStyle::default()
        });
        root.children.push(child);

        let checked = PaintPlan::new(&root);
        let validated = PaintPlan::new_validated(&root);
        assert_eq!(
            serde_json::to_value(checked.wire()).unwrap(),
            serde_json::to_value(validated.wire()).unwrap()
        );
        assert_eq!(
            checked
                .hit_path(8.0, 8.0)
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            validated
                .hit_path(8.0, 8.0)
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>()
        );
    }
}
