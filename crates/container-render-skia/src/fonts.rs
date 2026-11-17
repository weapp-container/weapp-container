use crate::RenderError;
use skia_safe as skia;
use std::{collections::BTreeMap, sync::Arc};

// A session can encounter arbitrary Unicode input. Bound positive and
// negative lookups instead of retaining every scalar for the entire session.
const MAX_CACHED_CHARACTERS: usize = 8_192;

/// Host-owned bytes for one face in an installed TTF/OTF font or collection.
/// Cloning this value shares the input bytes; it does not copy a font buffer.
#[derive(Clone)]
pub struct NativeFontData {
    bytes: Arc<[u8]>,
    collection_index: u32,
}

impl NativeFontData {
    pub fn new(bytes: Arc<[u8]>, collection_index: u32) -> Self {
        Self {
            bytes,
            collection_index,
        }
    }

    fn same_source(&self, other: &Self) -> bool {
        self.collection_index == other.collection_index
            && (Arc::ptr_eq(&self.bytes, &other.bytes) || self.bytes == other.bytes)
    }

    fn valid_collection_index(&self) -> bool {
        if self.collection_index > i32::MAX as u32 || self.bytes.is_empty() {
            return false;
        }
        if !self.bytes.starts_with(b"ttcf") {
            return self.collection_index == 0;
        }
        let Some(count) = self.bytes.get(8..12) else {
            return false;
        };
        let count = u32::from_be_bytes(count.try_into().expect("four-byte TTC face count"));
        let table_end = usize::try_from(count)
            .ok()
            .and_then(|count| count.checked_mul(4))
            .and_then(|table_len| table_len.checked_add(12));
        self.collection_index < count
            && table_end.is_some_and(|table_end| table_end <= self.bytes.len())
    }
}

impl std::fmt::Debug for NativeFontData {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeFontData")
            .field("byte_len", &self.bytes.len())
            .field("collection_index", &self.collection_index)
            .finish()
    }
}

/// Successfully decoded host faces, in the order used for glyph fallback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeFontInfo {
    pub installed_faces: usize,
    pub families: Vec<String>,
}

#[derive(Clone)]
struct InstalledFont {
    source: NativeFontData,
    font: skia::Font,
}

/// An initialized manager may legitimately have no default face. Retaining
/// that state prevents repeated discovery on fontless hosts.
struct SystemFonts {
    manager: skia::FontMgr,
    default: Option<skia::Font>,
}

impl SystemFonts {
    fn from_manager(manager: skia::FontMgr) -> Self {
        // CSS generic family names need not be exposed as system families
        // (CoreText, for example, need not have a `sans-serif` family).
        let style = skia::FontStyle::normal();
        let default = manager
            .legacy_make_typeface(None, style)
            .or_else(|| manager.match_family_style("sans-serif", style))
            .or_else(|| manager.match_family_style_character("", style, &[], 'A' as i32))
            .map(|typeface| skia::Font::new(typeface, Some(16.0)));
        Self { manager, default }
    }

    fn for_character(&self, character_id: i32) -> Option<skia::Font> {
        self.default
            .as_ref()
            .filter(|font| font.unichar_to_glyph(character_id) != 0)
            .cloned()
            .or_else(|| {
                self.manager
                    .match_family_style_character("", skia::FontStyle::normal(), &[], character_id)
                    .filter(|typeface| typeface.unichar_to_glyph(character_id) != 0)
                    .map(|typeface| skia::Font::new(typeface, Some(16.0)))
            })
    }
}

/// One renderer owns lazy font discovery, injected faces and positive/negative
/// character lookups across page, Canvas and native GPU drawing paths.
pub(crate) struct NativeFonts {
    system: Option<SystemFonts>,
    installed: Vec<InstalledFont>,
    system_fallback: bool,
    pub(crate) fallback: BTreeMap<char, Option<skia::Font>>,
    rendered: bool,
    #[cfg(test)]
    decoded_faces: usize,
    #[cfg(test)]
    system_factory: fn() -> skia::FontMgr,
    #[cfg(test)]
    system_factory_calls: usize,
}

impl NativeFonts {
    pub(crate) fn new() -> Self {
        Self {
            system: None,
            installed: Vec::new(),
            system_fallback: true,
            fallback: BTreeMap::new(),
            rendered: false,
            #[cfg(test)]
            decoded_faces: 0,
            #[cfg(test)]
            system_factory: skia::FontMgr::new,
            #[cfg(test)]
            system_factory_calls: 0,
        }
    }

    #[cfg(test)]
    pub(crate) fn from_manager(manager: skia::FontMgr) -> Self {
        Self {
            system: Some(SystemFonts::from_manager(manager)),
            ..Self::new()
        }
    }

    #[cfg(test)]
    fn with_system_factory(factory: fn() -> skia::FontMgr) -> Self {
        Self {
            system_factory: factory,
            ..Self::new()
        }
    }

    #[cfg(test)]
    pub(crate) fn set_default_for_test(&mut self, font: skia::Font) {
        self.system
            .as_mut()
            .expect("explicitly injected manager")
            .default = Some(font);
    }

    fn ensure_system(&mut self) -> &SystemFonts {
        if self.system.is_none() {
            #[cfg(test)]
            let manager = {
                self.system_factory_calls += 1;
                (self.system_factory)()
            };
            #[cfg(not(test))]
            let manager = skia::FontMgr::new();
            self.system = Some(SystemFonts::from_manager(manager));
        }
        self.system.as_ref().expect("initialized system fonts")
    }

    pub(crate) fn info(&self) -> NativeFontInfo {
        NativeFontInfo {
            installed_faces: self.installed.len(),
            families: self
                .installed
                .iter()
                .map(|entry| entry.font.typeface().family_name())
                .collect(),
        }
    }

    pub(crate) fn install(
        &mut self,
        sources: &[NativeFontData],
    ) -> Result<NativeFontInfo, RenderError> {
        if sources.len() == self.installed.len()
            && sources
                .iter()
                .zip(&self.installed)
                .all(|(source, installed)| source.same_source(&installed.source))
        {
            return Ok(self.info());
        }
        if self.rendered {
            return Err(RenderError::InvalidFont(
                "fonts must be installed before the first native layout or render".into(),
            ));
        }

        // OpenHarmony may have no system FontMgr even though FreeType is
        // available. Decode explicit host bytes through that factory; use the
        // platform factory on systems where custom_empty is unavailable.
        // Decoding must be independent of fallback discovery: a host/test may
        // deliberately use an empty fallback manager on a CoreText platform.
        let decoder = skia::FontMgr::custom_empty().unwrap_or_default();
        let mut staged: Vec<InstalledFont> = Vec::with_capacity(sources.len());
        #[cfg(test)]
        let mut decoded_faces = 0;
        for (position, source) in sources.iter().enumerate() {
            if !source.valid_collection_index() {
                return Err(RenderError::InvalidFont(format!(
                    "face {position} has empty bytes or an invalid collection index"
                )));
            }
            let existing = self
                .installed
                .iter()
                .chain(&staged)
                .find(|entry| source.same_source(&entry.source));
            let installed = if let Some(existing) = existing {
                existing.clone()
            } else {
                // Skia owns this one decode-time copy. Its typeface/strike
                // caches can retain the data beyond this Rust provider, so
                // borrowing an Arc's bytes with Data::new_bytes is unsafe.
                // No byte copy, decode or filesystem access occurs per frame.
                let typeface = decoder
                    .new_from_data(skia::Data::new_copy(&source.bytes), source.collection_index)
                    .filter(|face| face.count_glyphs() > 0)
                    .ok_or_else(|| {
                        RenderError::InvalidFont(format!(
                            "face {position} could not be decoded at collection index {}",
                            source.collection_index
                        ))
                    })?;
                #[cfg(test)]
                {
                    decoded_faces += 1;
                }
                InstalledFont {
                    source: source.clone(),
                    font: skia::Font::new(typeface, Some(16.0)),
                }
            };
            staged.push(installed);
        }
        // Publish only after every requested face has been validated. In
        // particular a corrupt later face cannot discard the working set.
        self.installed = staged;
        self.fallback.clear();
        #[cfg(test)]
        {
            self.decoded_faces += decoded_faces;
        }
        Ok(self.info())
    }

    pub(crate) fn begin_render(&mut self) {
        self.rendered = true;
    }

    /// A self-contained host may choose an exact font set. Do this before any
    /// native work; later unsupported glyphs must not silently change layout
    /// according to fonts installed on the customer's machine.
    pub(crate) fn install_only(
        &mut self,
        sources: &[NativeFontData],
    ) -> Result<NativeFontInfo, RenderError> {
        if self.rendered && self.system_fallback {
            return Err(RenderError::InvalidFont(
                "font fallback must be configured before native layout or render".into(),
            ));
        }
        let info = self.install(sources)?;
        self.system_fallback = false;
        self.system = None;
        self.fallback.clear();
        Ok(info)
    }

    pub(crate) fn for_character(&mut self, character: char, size: f32) -> Option<skia::Font> {
        let character_id = character as i32;
        let resolved = if let Some(cached) = self.fallback.get(&character) {
            // Some(None) is a completed negative lookup, not a cache miss.
            cached.clone()
        } else {
            let installed = self
                .installed
                .iter()
                .map(|entry| &entry.font)
                .find(|font| font.unichar_to_glyph(character_id) != 0)
                .cloned();
            let resolved = installed.or_else(|| {
                self.system_fallback
                    .then(|| self.ensure_system().for_character(character_id))
                    .flatten()
            });
            if self.fallback.len() >= MAX_CACHED_CHARACTERS {
                // Deterministic one-entry eviction avoids an unbounded map or a
                // large cache-clear pause. Eviction affects lookup cost only.
                self.fallback.pop_first();
            }
            self.fallback.insert(character, resolved.clone());
            resolved
        };
        let mut font = resolved?;
        font.set_size(size);
        Some(font)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        CanvasFrame, Color, FlowStyle, LayoutLength, LayoutStyle, Rect, RenderFrame, RenderNode,
        RenderSnapshot, Renderer, SkiaRenderer, TextFlowStyle, TextStyle,
    };

    fn assert_pixels(actual: &RenderSnapshot, expected: &RenderSnapshot, message: &str) {
        assert_eq!(
            (actual.width, actual.height),
            (expected.width, expected.height)
        );
        assert!(
            actual.pixels == expected.pixels,
            "{message}: first differing pixels {:?}",
            actual
                .pixels
                .chunks(4)
                .zip(expected.pixels.chunks(4))
                .enumerate()
                .filter(|(_, (actual, expected))| actual != expected)
                .take(10)
                .map(|(index, pixels)| (
                    (index % actual.width as usize, index / actual.width as usize),
                    pixels
                ))
                .collect::<Vec<_>>()
        );
    }

    fn host_font(variable: &str, paths: &[&str]) -> Option<NativeFontData> {
        let explicit = std::env::var_os(variable).map(std::path::PathBuf::from);
        let path = explicit.or_else(|| {
            paths
                .iter()
                .map(std::path::PathBuf::from)
                .find(|path| path.is_file())
        });
        let Some(path) = path else {
            assert!(
                std::env::var_os("WEAPP_CONTAINER_REQUIRE_FONT_TESTS").is_none(),
                "required host font unavailable: set {variable} to a public TTF/OTF font"
            );
            eprintln!(
                "{variable} unavailable: injected native glyph coverage was not exercised; set WEAPP_CONTAINER_REQUIRE_FONT_TESTS=1 to require it"
            );
            return None;
        };
        let bytes = std::fs::read(&path).expect("read explicitly selected or installed host font");
        eprintln!(
            "injected font fixture: {} ({} bytes)",
            path.display(),
            bytes.len()
        );
        Some(NativeFontData::new(Arc::from(bytes), 0))
    }

    fn latin_font() -> Option<NativeFontData> {
        host_font(
            "WEAPP_CONTAINER_TEST_LATIN_FONT",
            &[
                "/System/Library/Fonts/Supplemental/Arial.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                "C:/Windows/Fonts/arial.ttf",
            ],
        )
    }

    fn cjk_font() -> Option<NativeFontData> {
        host_font(
            "WEAPP_CONTAINER_TEST_CJK_FONT",
            &[
                "/System/Library/Fonts/Supplemental/Songti.ttc",
                "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                "/system/fonts/HarmonyOS_Sans_SC.ttf",
            ],
        )
    }

    fn forbid_system_discovery() -> skia::FontMgr {
        panic!("this path must not discover system fonts")
    }

    #[cfg(any(
        feature = "skia-gpu-gles",
        all(
            feature = "skia-gpu-metal",
            any(target_os = "macos", target_os = "ios")
        )
    ))]
    #[test]
    fn discarded_gpu_page_candidate_keeps_font_provider_installable() {
        let mut renderer = SkiaRenderer::new_native_gpu().unwrap();
        renderer.canvas.native_fonts.system_factory = forbid_system_discovery;
        let owner = &renderer.canvas.native_fonts as *const NativeFonts;
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 2.0,
            height: 1.0,
        };
        let frame = RenderFrame {
            frame_id: 1,
            viewport,
            root: RenderNode::new("gpu-font-lifetime", viewport),
            images: Default::default(),
        };
        drop(
            renderer
                .prepare_page_frame(frame.clone(), crate::PageFrameTargetPolicy::Legacy)
                .unwrap(),
        );
        assert!(!renderer.canvas.native_fonts.rendered);
        assert_eq!(
            renderer.install_native_fonts(&[]).unwrap().installed_faces,
            0
        );
        let accepted = renderer
            .prepare_page_frame(frame, crate::PageFrameTargetPolicy::Legacy)
            .unwrap()
            .accept();
        assert!(renderer.canvas.native_fonts.rendered);
        assert_eq!(&renderer.canvas.native_fonts as *const _, owner);
        assert!(renderer.canvas.native_fonts.system.is_none());
        assert!(renderer.canvas.native_fonts.fallback.is_empty());
        assert_eq!(renderer.canvas.native_fonts.system_factory_calls, 0);
        // This verifies only the font install lifetime; no GPU context,
        // drawable or hardware presentation was created by this test.
        assert!(!renderer.has_gpu_surface());
        drop(accepted);
    }

    #[test]
    fn native_font_construction_info_and_render_lock_leave_system_uninitialized() {
        let mut fonts = NativeFonts::new();
        fonts.system_factory = forbid_system_discovery;
        assert_eq!(
            fonts.info(),
            NativeFontInfo {
                installed_faces: 0,
                families: Vec::new(),
            }
        );
        fonts.begin_render();
        assert!(fonts.rendered);
        assert!(fonts.system.is_none());
        assert_eq!(fonts.system_factory_calls, 0);
        assert!(fonts.fallback.is_empty());
        assert!(matches!(
            fonts.install(&[NativeFontData::new(Arc::from([0]), 0)]),
            Err(RenderError::InvalidFont(message))
                if message.contains("before the first native layout or render")
        ));
        assert!(fonts.system.is_none());
        assert_eq!(fonts.system_factory_calls, 0);
    }

    #[test]
    fn first_invalid_native_canvas_keeps_font_installation_open() {
        let source = latin_font();
        for (op, args, message) in [
            (
                "setLineDash",
                serde_json::json!([[1, -1]]),
                "canvas command setLineDash argument 1 must be finite and non-negative",
            ),
            (
                "setTextAlign",
                serde_json::json!(["invalid"]),
                "unsupported textAlign value invalid",
            ),
            (
                "setTextBaseline",
                serde_json::json!(["invalid"]),
                "unsupported textBaseline value invalid",
            ),
        ] {
            let mut renderer = SkiaRenderer::new();
            renderer.canvas.native_fonts.system_factory = forbid_system_discovery;
            let payload = serde_json::json!({
                "canvasId": "first-rejected",
                "width": 2,
                "height": 1,
                "commands": [
                    {"op": "fillText", "args": ["A", 0, 1]},
                    {"op": op, "args": args},
                ],
            });
            let frame = CanvasFrame::from_payload(payload.as_object().unwrap(), 1, None).unwrap();
            assert_eq!(
                renderer.commit_canvas(frame),
                Err(RenderError::InvalidCanvas(message.into()))
            );
            // A previous successful draw would already set this lock and hide
            // a regression that enters begin_render before native admission.
            assert!(
                !renderer.canvas.native_fonts.rendered,
                "{op} locked font installation"
            );
            assert!(renderer.canvas.native_fonts.system.is_none());
            assert_eq!(renderer.canvas.native_fonts.system_factory_calls, 0);
            assert!(renderer.canvas.native_fonts.fallback.is_empty());
            assert_eq!(renderer.native_font_info().installed_faces, 0);
            assert!(renderer.canvas_snapshot("first-rejected").is_none());

            // Use the same real host-font fixture as the injection tests. On
            // fontless hosts the state assertions above still run; host_font
            // reports the missing exercise and REQUIRE_FONT_TESTS can require it.
            if let Some(source) = &source {
                let installed = renderer
                    .install_native_fonts(std::slice::from_ref(source))
                    .unwrap();
                assert_eq!(installed.installed_faces, 1);
                assert_eq!(renderer.canvas.native_fonts.decoded_faces, 1);
                assert!(!renderer.canvas.native_fonts.rendered);
                assert!(renderer.canvas.native_fonts.system.is_none());
                assert_eq!(renderer.canvas.native_fonts.system_factory_calls, 0);
            }
        }
    }

    #[test]
    fn exclusive_fonts_resolve_real_glyphs_without_discovering_system_fallback() {
        let Some(source) = latin_font() else {
            return;
        };
        let mut fonts = NativeFonts::with_system_factory(forbid_system_discovery);
        fonts.install_only(std::slice::from_ref(&source)).unwrap();
        assert!(fonts.for_character('A', 24.0).is_some());
        assert!(fonts.for_character('\u{10ffff}', 24.0).is_none());
        assert_eq!(fonts.system_factory_calls, 0);
        assert!(fonts.system.is_none());
        fonts.begin_render();
        // Reinstalling the same complete set is harmless after drawing, while
        // a different resource cannot alter an already published font owner.
        fonts.install_only(&[source]).unwrap();
        assert!(fonts.install_only(&[]).is_err());
        assert!(fonts.for_character('A', 24.0).is_some());
        assert_eq!(fonts.system_factory_calls, 0);
    }

    #[test]
    fn first_glyph_miss_initializes_even_fontless_system_once_and_caches_absence() {
        let mut fonts = NativeFonts::with_system_factory(skia::FontMgr::empty);
        assert!(fonts.system.is_none());
        assert_eq!(fonts.system_factory_calls, 0);
        assert!(fonts.for_character('A', 16.0).is_none());
        assert_eq!(fonts.system_factory_calls, 1);
        assert!(fonts.system.as_ref().unwrap().default.is_none());
        assert!(matches!(fonts.fallback.get(&'A'), Some(None)));
        assert!(fonts.for_character('A', 28.0).is_none());
        assert_eq!(fonts.fallback.len(), 1);
        assert!(fonts.for_character('中', 16.0).is_none());
        assert_eq!(fonts.fallback.len(), 2);
        assert_eq!(fonts.system_factory_calls, 1);

        let mut injected = NativeFonts::from_manager(skia::FontMgr::empty());
        injected.system_factory = forbid_system_discovery;
        assert!(injected.for_character('A', 16.0).is_none());
        assert!(injected.for_character('中', 16.0).is_none());
        assert_eq!(injected.system_factory_calls, 0);
    }

    #[test]
    fn rectangle_only_native_and_export_renderers_never_discover_system_fonts() {
        for mut renderer in [SkiaRenderer::new(), SkiaRenderer::new_frame_export_only()] {
            renderer.canvas.native_fonts.system_factory = forbid_system_discovery;
            assert_eq!(renderer.native_font_info().installed_faces, 0);
            assert!(!format!("{renderer:?}").is_empty());
            let viewport = Rect {
                x: 0.0,
                y: 0.0,
                width: 8.0,
                height: 6.0,
            };
            let mut root = RenderNode::new("rectangle", viewport);
            root.background = Some(Color {
                red: 18,
                green: 52,
                blue: 86,
                alpha: 255,
            });
            renderer.layout_tree(&mut root, viewport).unwrap();
            renderer
                .commit(RenderFrame {
                    images: BTreeMap::new(),
                    frame_id: 1,
                    viewport,
                    root,
                })
                .unwrap();
            let snapshot = renderer.snapshot().unwrap();
            assert_eq!((snapshot.width, snapshot.height), (8, 6));
            assert!(snapshot
                .pixels
                .as_chunks::<4>()
                .0
                .iter()
                .all(|rgba| *rgba == [18, 52, 86, 255]));
            assert!(renderer.canvas.native_fonts.system.is_none());
            assert_eq!(renderer.canvas.native_fonts.system_factory_calls, 0);
            assert_eq!(
                renderer.canvas.native_fonts.rendered,
                renderer.page_render_mode() != crate::PageRenderMode::ExternalFrame
            );
            assert_eq!(renderer.native_font_info().installed_faces, 0);
        }
    }

    #[test]
    fn flow_rectangle_native_and_export_layouts_never_discover_system_fonts() {
        for mut renderer in [SkiaRenderer::new(), SkiaRenderer::new_frame_export_only()] {
            renderer.canvas.native_fonts.system_factory = forbid_system_discovery;
            let viewport = Rect {
                x: 0.0,
                y: 0.0,
                width: 64.0,
                height: 48.0,
            };
            let rectangle = |id, width, height| {
                RenderNode::new(id, viewport)
                    .with_style(LayoutStyle {
                        flow: Some(FlowStyle {
                            width,
                            height,
                            ..FlowStyle::default()
                        }),
                        ..LayoutStyle::default()
                    })
                    // Runtime style resolution supplies text-flow properties
                    // even to ordinary views with no text content.
                    .with_text_style(TextStyle {
                        flow: Some(TextFlowStyle::default()),
                        ..TextStyle::default()
                    })
            };
            let mut root = rectangle("page", LayoutLength::Auto, LayoutLength::Auto);
            root.background = Some(Color {
                red: 18,
                green: 52,
                blue: 86,
                alpha: 255,
            });
            // Auto height requires intrinsic leaf measurement. A fixed-size
            // rectangle alone can skip that callback and miss the regression.
            let empty = rectangle("empty", LayoutLength::Auto, LayoutLength::Auto);
            let mut painted = rectangle("painted", LayoutLength::Px(20.0), LayoutLength::Px(20.0));
            painted.background = Some(Color::BLACK);
            root.children = vec![empty, painted];
            renderer.layout_tree(&mut root, viewport).unwrap();
            assert_eq!(root.bounds, viewport);
            assert_eq!(root.children[0].bounds.width, 64.0);
            assert_eq!(root.children[0].bounds.height, 0.0);
            assert_eq!(
                root.children[1].bounds,
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 20.0,
                    height: 20.0,
                }
            );
            assert!(root.children.iter().all(|node| node.text_layout.is_none()));
            assert!(!renderer.canvas.native_fonts.rendered);
            assert!(renderer.canvas.native_fonts.system.is_none());
            assert!(renderer.canvas.native_fonts.fallback.is_empty());
            assert_eq!(renderer.canvas.native_fonts.system_factory_calls, 0);
            renderer
                .commit(RenderFrame {
                    images: BTreeMap::new(),
                    frame_id: 1,
                    viewport,
                    root,
                })
                .unwrap();
            let snapshot = renderer.snapshot().unwrap();
            assert_eq!((snapshot.width, snapshot.height), (64, 48));
            assert_eq!(&snapshot.pixels[..4], &[0, 0, 0, 255]);
            assert_eq!(
                &snapshot.pixels[snapshot.pixels.len() - 4..],
                &[18, 52, 86, 255]
            );
            assert!(renderer.canvas.native_fonts.system.is_none());
            assert_eq!(renderer.canvas.native_fonts.system_factory_calls, 0);
        }
    }

    #[test]
    fn installed_glyph_and_positive_cache_skip_system_and_clone_requested_size() {
        let Some(source) = latin_font() else { return };
        let mut fonts = NativeFonts::with_system_factory(forbid_system_discovery);
        fonts.install(&[source]).unwrap();
        let original = fonts.for_character('A', 16.0).unwrap();
        let resized = fonts.for_character('A', 28.0).unwrap();
        assert_eq!(
            resized.typeface().unique_id(),
            original.typeface().unique_id()
        );
        assert_eq!(resized.size(), 28.0);
        assert_eq!(original.size(), 16.0);
        assert_eq!(fonts.fallback[&'A'].as_ref().unwrap().size(), 16.0);
        assert!(fonts.system.is_none());
        assert_eq!(fonts.system_factory_calls, 0);
        assert_eq!(fonts.decoded_faces, 1);
    }

    #[test]
    fn native_font_debug_and_corrupt_sources_do_not_expose_or_mutate_provider() {
        let mut fonts = NativeFonts::from_manager(skia::FontMgr::empty());
        assert!(fonts.for_character('A', 16.0).is_none());
        for source in [
            NativeFontData::new(Arc::from([]), 0),
            NativeFontData::new(Arc::from(&b"corrupt-font-secret"[..]), 0),
            NativeFontData::new(Arc::from([0, 1, 2]), u32::MAX),
            NativeFontData::new(Arc::from(&b"ttcf\0\x01\0\0\0\0\0\x01"[..]), 0),
        ] {
            let debug = format!("{source:?}");
            assert!(!debug.contains("corrupt-font-secret"));
            assert!(debug.contains("byte_len"));
            assert!(matches!(
                fonts.install(&[source]),
                Err(RenderError::InvalidFont(_))
            ));
            assert_eq!(fonts.info().installed_faces, 0);
            assert_eq!(
                fonts.fallback.len(),
                1,
                "a failed install must retain cached misses"
            );
            assert_eq!(fonts.decoded_faces, 0);
        }
    }

    #[test]
    fn native_font_negative_character_cache_is_bounded_for_session_lifetime() {
        let mut fonts = NativeFonts::with_system_factory(skia::FontMgr::empty);
        for offset in 0..MAX_CACHED_CHARACTERS + 100 {
            let character = char::from_u32(0xf0000 + offset as u32).unwrap();
            assert!(fonts.for_character(character, 16.0).is_none());
            assert!(fonts.fallback.len() <= MAX_CACHED_CHARACTERS);
        }
        assert_eq!(fonts.fallback.len(), MAX_CACHED_CHARACTERS);
        assert!(fonts.for_character('A', 16.0).is_none());
        assert_eq!(fonts.fallback.len(), MAX_CACHED_CHARACTERS);
        assert_eq!(fonts.system_factory_calls, 1);
    }

    #[test]
    fn native_font_install_is_transactional_and_clears_cached_misses() {
        let Some(source) = latin_font() else { return };
        let mut fonts = NativeFonts::from_manager(skia::FontMgr::empty());
        assert!(fonts.for_character('A', 16.0).is_none());
        let info = fonts.install(std::slice::from_ref(&source)).unwrap();
        assert_eq!(info.installed_faces, 1);
        assert_eq!(info.families.len(), 1);
        assert!(!info.families[0].is_empty());
        assert!(
            fonts.fallback.is_empty(),
            "successful install invalidates cached misses"
        );
        let original = fonts.for_character('A', 16.0).unwrap();
        assert_ne!(original.unichar_to_glyph('A' as i32), 0);
        let corrupt = NativeFontData::new(Arc::from(&b"not a font"[..]), 0);
        assert!(matches!(
            fonts.install(&[source.clone(), corrupt]),
            Err(RenderError::InvalidFont(_))
        ));
        assert_eq!(fonts.info(), info);
        assert_eq!(fonts.decoded_faces, 1);
        assert_eq!(fonts.fallback.len(), 1);
        assert_eq!(
            fonts
                .for_character('A', 22.0)
                .unwrap()
                .typeface()
                .unique_id(),
            original.typeface().unique_id()
        );
        let invalid_index = NativeFontData::new(source.bytes.clone(), 99);
        assert!(matches!(
            fonts.install(&[invalid_index]),
            Err(RenderError::InvalidFont(_))
        ));
        assert_eq!(fonts.info(), info);
        // Adding the same input twice reuses the already decoded typeface.
        fonts.install(&[source.clone(), source]).unwrap();
        assert_eq!(fonts.decoded_faces, 1);
    }

    #[test]
    fn canvas_compound_rejection_preflights_before_fonts_and_keeps_installation_open() {
        use serde_json::json;
        let mut service = crate::CanvasService::default();
        service.native_fonts.system_factory = forbid_system_discovery;
        let rejected: CanvasFrame = serde_json::from_value(json!({
            "frame_id":1,"canvas_id":"compound","width":32,"height":32,"reserve":false,
            "commands":[{"op":"fillText","args":["A",0,16]},
              {"op":"save","args":[]},{"op":"setLineDash","args":[[2,2]]},
              {"op":"strokeText","args":["B",0,16]},{"op":"restore","args":[]}]
        }))
        .unwrap();
        assert!(matches!(
            service.commit(rejected),
            Err(RenderError::UnsupportedCanvasCommand(_))
        ));
        assert!(service.snapshot("compound").is_none());
        assert!(!service.native_fonts.rendered);
        assert!(service.native_fonts.system.is_none());
        assert!(service.native_fonts.fallback.is_empty());
        assert_eq!(service.native_fonts.system_factory_calls, 0);
        assert!(service.install_native_fonts(&[]).is_ok());
    }

    #[test]
    fn canvas_dynamic_rejection_freezes_fonts_only_after_successful_publication() {
        use serde_json::json;
        let frame = |commands: serde_json::Value| -> CanvasFrame {
            serde_json::from_value(json!({
            "frame_id":1,"canvas_id":"dynamic","width":32,"height":32,"reserve":false,"commands":commands
        })).unwrap()
        };
        let mut service = crate::CanvasService::default();
        service.native_fonts.system_factory = forbid_system_discovery;
        let rejected = frame(json!([
            {"op":"setLineDash","args":[[1e-6,1e-6]]},{"op":"beginPath","args":[]},
            {"op":"moveTo","args":[0,8]},{"op":"lineTo","args":[64,8]},{"op":"stroke","args":[]}
        ]));
        assert!(service.commit(rejected.clone()).is_err());
        assert!(!service.native_fonts.rendered);
        assert!(service.snapshot("dynamic").is_none());
        assert_eq!(service.native_fonts.system_factory_calls, 0);
        let snapshot = service
            .commit(frame(json!([{"op":"fillRect","args":[0,0,8,8]}])))
            .unwrap();
        assert!(service.native_fonts.rendered);
        assert!(service.commit(rejected).is_err());
        assert!(service.native_fonts.rendered);
        assert_eq!(service.snapshot("dynamic").unwrap(), snapshot);
        let invalid = NativeFontData::new(Arc::from(&b"not a font"[..]), 0);
        assert_eq!(
            service.install_native_fonts(&[invalid]),
            Err(RenderError::InvalidFont(
                "fonts must be installed before the first native layout or render".into()
            ))
        );
    }

    #[test]
    fn standalone_canvas_rejections_leave_native_fonts_inert_and_installable(
    ) -> Result<(), RenderError> {
        let mut service = crate::CanvasService::default();
        service.native_fonts.system_factory = forbid_system_discovery;
        for (op, args) in [
            (
                "lineTo",
                vec![serde_json::json!(1), serde_json::json!("invalid")],
            ),
            ("setTextAlign", vec![serde_json::json!("invalid")]),
        ] {
            let frame = CanvasFrame {
                frame_id: 1,
                canvas_id: "rejected".into(),
                width: 2,
                height: 1,
                reserve: true,
                commands: vec![crate::CanvasCommand {
                    op: op.into(),
                    args,
                }],
            };
            assert!(service.commit(frame).is_err());
            assert!(service.snapshot("rejected").is_none());
            assert_eq!(service.ids().count(), 0);
            assert!(!service.native_fonts.rendered);
            assert!(service.native_fonts.system.is_none());
            assert!(service.native_fonts.fallback.is_empty());
            assert_eq!(service.native_fonts.system_factory_calls, 0);
            assert_eq!(service.native_fonts.decoded_faces, 0);
        }
        assert_eq!(service.install_native_fonts(&[])?.installed_faces, 0);
        Ok(())
    }

    #[test]
    fn canvas_owner_moves_fonts_without_redecode_cache_loss_or_thawing() -> Result<(), RenderError>
    {
        let Some(source) = latin_font() else {
            return Ok(());
        };
        let mut service = crate::CanvasService::default();
        service.native_fonts.system_factory = forbid_system_discovery;
        let sources = [source];
        let info = service.install_native_fonts(&sources)?;
        let source_storage = service.native_fonts.installed.as_ptr();
        let before_draw = service.native_font_info();
        assert_eq!(before_draw, info);
        let snapshot = service.commit(CanvasFrame {
            frame_id: 1,
            canvas_id: "font-owner".into(),
            width: 32,
            height: 32,
            reserve: false,
            commands: vec![crate::CanvasCommand {
                op: "fillText".into(),
                args: vec![
                    serde_json::json!("A"),
                    serde_json::json!(0),
                    serde_json::json!(20),
                ],
            }],
        })?;
        assert!(snapshot.pixels.chunks(4).any(|pixel| pixel[3] != 0));
        assert!(service.native_fonts.rendered);
        assert_eq!(service.native_fonts.decoded_faces, 1);
        // Keep a cached character not used by the later page layout, so a
        // discarded and repopulated cache cannot satisfy the identity check.
        assert!(service.native_fonts.for_character('Z', 16.0).is_some());
        let cached_faces: BTreeMap<_, _> = service
            .native_fonts
            .fallback
            .iter()
            .map(|(&character, font)| {
                (
                    character,
                    font.as_ref().map(|font| font.typeface().unique_id()),
                )
            })
            .collect();
        let cached = service
            .native_fonts
            .fallback
            .get(&'A')
            .map(std::ptr::from_ref);
        assert!(cached.is_some());
        let mode = crate::ValidatedPageRenderMode::new(crate::PageRenderMode::ExternalFrame)?;
        let mut renderer = SkiaRenderer::new_with_validated_mode_and_canvas(mode, service);
        assert_eq!(
            renderer.canvas.native_fonts.installed.as_ptr(),
            source_storage
        );
        assert_eq!(
            renderer
                .canvas
                .native_fonts
                .fallback
                .get(&'A')
                .map(std::ptr::from_ref),
            cached
        );
        assert_eq!(renderer.native_font_info(), info);
        assert!(renderer.canvas.native_fonts.rendered);
        assert_eq!(renderer.canvas_snapshot("font-owner"), Some(snapshot));
        assert_eq!(renderer.install_native_fonts(&sources)?, info);
        assert!(matches!(
            renderer.install_native_fonts(&[]),
            Err(RenderError::InvalidFont(_))
        ));
        assert_eq!(renderer.native_font_info(), info);
        assert_eq!(renderer.canvas.native_fonts.decoded_faces, 1);
        assert!(renderer.canvas.native_fonts.system.is_none());
        assert_eq!(renderer.canvas.native_fonts.system_factory_calls, 0);

        // Page text measurement uses the moved provider and cached face too.
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 32.0,
            height: 32.0,
        };
        let mut root = RenderNode::new("page-font-owner", viewport).with_text("A");
        renderer.layout_tree(&mut root, viewport)?;
        // Layout also looks up spacing characters. BTreeMap may move slots
        // when inserting those keys; the cached faces and unused 'Z' entry
        // must survive, rather than each map entry retaining its old address.
        for (character, face) in cached_faces {
            assert_eq!(
                renderer
                    .canvas
                    .native_fonts
                    .fallback
                    .get(&character)
                    .map(|font| font.as_ref().map(|font| font.typeface().unique_id())),
                Some(face)
            );
        }
        assert_eq!(
            renderer.canvas.native_fonts.installed.as_ptr(),
            source_storage
        );
        assert_eq!(renderer.canvas.native_fonts.decoded_faces, 1);
        assert_eq!(renderer.native_font_info(), info);
        assert!(renderer.canvas.native_fonts.rendered);
        assert!(renderer.canvas.native_fonts.system.is_none());
        assert_eq!(renderer.canvas.native_fonts.system_factory_calls, 0);
        // An arbitrary whole-renderer replacement intentionally resets fonts.
        renderer = SkiaRenderer::new();
        assert_eq!(renderer.native_font_info().installed_faces, 0);
        assert!(renderer.canvas_snapshot("font-owner").is_none());
        assert!(!renderer.canvas.native_fonts.rendered);
        Ok(())
    }

    #[test]
    fn native_fonts_reuse_latin_cjk_faces_across_page_canvas_and_target_drawing() {
        let (Some(latin), Some(cjk)) = (latin_font(), cjk_font()) else {
            return;
        };
        // This intentionally has no default/system fallback. Both scripts must
        // come from the explicit public host bytes and the second face must be
        // selected for CJK rather than a tofu glyph in the first Latin face.
        let mut renderer = SkiaRenderer::new();
        renderer.canvas.native_fonts = NativeFonts::with_system_factory(forbid_system_discovery);
        let sources = [latin, cjk];
        let info = renderer.install_native_fonts(&sources).unwrap();
        assert_eq!(info.installed_faces, 2);
        assert_eq!(info.families.len(), 2);
        assert!(info.families.iter().all(|family| !family.is_empty()));
        let latin = &renderer.canvas.native_fonts.installed[0].font;
        let cjk = &renderer.canvas.native_fonts.installed[1].font;
        assert_ne!(latin.unichar_to_glyph('A' as i32), 0);
        assert_eq!(
            latin.unichar_to_glyph('中' as i32),
            0,
            "Latin fixture must lack CJK"
        );
        assert_ne!(cjk.unichar_to_glyph('中' as i32), 0);
        let expected_ids = [latin.typeface().unique_id(), cjk.typeface().unique_id()];
        let fonts = ['A', '中'].map(|character| {
            renderer
                .canvas
                .native_fonts
                .for_character(character, 16.0)
                .unwrap()
        });
        assert_eq!(
            fonts.each_ref().map(|font| font.typeface().unique_id()),
            expected_ids
        );
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 64.0,
            height: 32.0,
        };
        let text_bounds = Rect {
            x: 4.0,
            y: 2.0,
            width: 56.0,
            height: 24.0,
        };
        let value = RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 1,
            viewport,
            root: RenderNode::new("injected-text", text_bounds).with_text("A中"),
        };
        renderer.commit(value.clone()).unwrap();
        let actual = renderer.snapshot().unwrap();
        let mut expected = skia::surfaces::raster_n32_premul((64, 32)).unwrap();
        expected.canvas().clear(skia::Color::TRANSPARENT);
        expected.canvas().clip_rect(
            skia::Rect::from_xywh(
                text_bounds.x,
                text_bounds.y,
                text_bounds.width,
                text_bounds.height,
            ),
            skia::ClipOp::Intersect,
            false,
        );
        let paint = skia::Paint::new(skia::Color4f::from(skia::Color::BLACK), None);
        let mut x = 4.0;
        for (character, font) in ['A', '中'].into_iter().zip(&fonts) {
            let mut encoded = [0; 4];
            let glyph: &str = character.encode_utf8(&mut encoded);
            expected.canvas().draw_str(glyph, (x, 18.0), font, &paint);
            x += font.measure_str(glyph, Some(&paint)).0;
        }
        let expected = crate::native_raster::readback_native(&mut expected, 1, 64, 32).unwrap();
        assert!(actual.pixels.chunks(4).any(|pixel| pixel[3] != 0));
        assert_pixels(
            &actual,
            &expected,
            "injected text must use actual Latin/CJK glyphs",
        );

        let payload = serde_json::json!({
            "canvasId": "injected-fonts", "width": 64, "height": 32,
            "commands": [
                {"op": "setFontSize", "args": [16]},
                {"op": "fillText", "args": ["A中", 4, 18]}
            ]
        });
        let canvas = renderer
            .commit_canvas(
                CanvasFrame::from_payload(payload.as_object().unwrap(), 2, None).unwrap(),
            )
            .unwrap();
        assert!(canvas.pixels.chunks(4).any(|pixel| pixel[3] != 0));
        let mut canvas_expected = skia::surfaces::raster_n32_premul((64, 32)).unwrap();
        canvas_expected.canvas().clear(skia::Color::TRANSPARENT);
        let mut paint = skia::Paint::new(skia::Color4f::from(skia::Color::BLACK), None);
        paint.set_anti_alias(true);
        let mut x = 4.0;
        for (character, font) in ['A', '中'].into_iter().zip(&fonts) {
            let mut encoded = [0; 4];
            let glyph: &str = character.encode_utf8(&mut encoded);
            canvas_expected
                .canvas()
                .draw_str(glyph, (x, 18.0), font, &paint);
            x += font.measure_str(glyph, Some(&paint)).0;
        }
        let canvas_expected =
            crate::native_raster::readback_native(&mut canvas_expected, 2, 64, 32).unwrap();
        assert_pixels(
            &canvas,
            &canvas_expected,
            "Canvas text must use the same injected faces",
        );
        let mut target = skia::surfaces::raster_n32_premul((64, 32)).unwrap();
        SkiaRenderer::draw_frame_to_target(
            target.canvas(),
            &value,
            64,
            32,
            &mut renderer.canvas.native_fonts,
        )
        .unwrap();
        let target = crate::native_raster::readback_native(&mut target, 1, 64, 32).unwrap();
        assert_pixels(
            &target,
            &actual,
            "the shared native target path must retain the injected provider",
        );
        renderer
            .commit(RenderFrame {
                images: std::collections::BTreeMap::new(),
                frame_id: 3,
                ..value
            })
            .unwrap();
        assert_eq!(
            renderer.canvas.native_fonts.decoded_faces, 2,
            "no face is decoded per render path/frame"
        );
        assert_eq!(
            renderer.canvas.native_fonts.fallback.len(),
            2,
            "glyph cache persists across all render paths"
        );
        assert!(renderer.canvas.native_fonts.system.is_none());
        assert_eq!(renderer.canvas.native_fonts.system_factory_calls, 0);
        // Subsequent deliberately missing scalars may initialize the injected
        // fontless system once, independently of explicit font decoding.
        renderer.canvas.native_fonts.system_factory = skia::FontMgr::empty;
        for offset in 0..MAX_CACHED_CHARACTERS + 1 {
            let character = char::from_u32(0xf0000 + offset as u32).unwrap();
            renderer.canvas.native_fonts.for_character(character, 16.0);
        }
        assert_eq!(renderer.canvas.native_fonts.system_factory_calls, 1);
        assert_eq!(
            renderer.canvas.native_fonts.fallback.len(),
            MAX_CACHED_CHARACTERS
        );
        let after_eviction = ['A', '中'].map(|character| {
            renderer
                .canvas
                .native_fonts
                .for_character(character, 16.0)
                .unwrap()
                .typeface()
                .unique_id()
        });
        assert_eq!(
            after_eviction, expected_ids,
            "eviction must preserve glyph selection"
        );
        assert_eq!(
            renderer.canvas.native_fonts.fallback.len(),
            MAX_CACHED_CHARACTERS
        );
        assert_eq!(renderer.install_native_fonts(&sources).unwrap(), info);
        assert_eq!(renderer.canvas.native_fonts.decoded_faces, 2);
        let before = renderer.snapshot();
        assert!(matches!(
            renderer.install_native_fonts(&[]),
            Err(RenderError::InvalidFont(_))
        ));
        assert_eq!(renderer.native_font_info(), info);
        assert_eq!(
            renderer.snapshot(),
            before,
            "rejected font changes must retain accepted pixels"
        );
    }
}
