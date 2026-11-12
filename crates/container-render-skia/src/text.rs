use crate::{RenderError, TextMetrics};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_linebreak::{break_property, linebreaks, BreakClass};
use unicode_segmentation::UnicodeSegmentation;
mod sfnt;
pub use sfnt::{
    PortableFontData, PortableFontIdentity, PortableFontProfile, MAX_PORTABLE_FONT_BYTES,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum WhiteSpace {
    #[default]
    Normal,
    Nowrap,
    Pre,
    PreWrap,
    PreLine,
    BreakSpaces,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum WordBreak {
    #[default]
    Normal,
    BreakAll,
    KeepAll,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    #[default]
    Start,
    End,
    Left,
    Right,
    Center,
}

/// Version-one horizontal, left-to-right text-flow profile. This controls
/// wrapping at extended grapheme boundaries, not shaping or bidi layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct TextFlowStyle {
    pub white_space: WhiteSpace,
    pub word_break: WordBreak,
    pub text_align: TextAlign,
}

/// Computed line-height retains unitless multipliers through inheritance.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LineHeight {
    #[default]
    Normal,
    Number(f32),
    Px(f32),
}

/// Resolved text properties, shared by layout, native paint and host replay.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TextStyle {
    pub font_size: f32,
    pub line_height: LineHeight,
    /// Absent preserves the original scalar-layout wire contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow: Option<TextFlowStyle>,
}

impl Default for TextStyle {
    fn default() -> Self {
        Self {
            font_size: 16.0,
            line_height: LineHeight::Normal,
            flow: None,
        }
    }
}

impl TextStyle {
    /// Fallback line height. Native `normal` uses the selected font metrics
    /// instead, with its actual used height retained in `TextLayout`.
    pub fn used_line_height(self) -> f32 {
        match self.line_height {
            LineHeight::Normal => self.font_size * 1.2,
            LineHeight::Number(factor) => self.font_size * factor,
            LineHeight::Px(value) => value,
        }
    }

    pub fn validate(self) -> Result<(), RenderError> {
        let nonnegative = |value: f32| value.is_finite() && value >= 0.0;
        if !nonnegative(self.font_size)
            || !nonnegative(self.used_line_height())
            || match self.line_height {
                LineHeight::Normal => false,
                LineHeight::Number(value) | LineHeight::Px(value) => !nonnegative(value),
            }
        {
            return Err(RenderError::InvalidTextStyle);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextMeasurement {
    Fallback,
    Native,
    Font(PortableFontIdentity),
}

/// A Unicode scalar positioned relative to the node's content-box origin.
/// CR/LF and tabs change layout but do not generate a painted glyph.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct GlyphPosition {
    pub character: char,
    pub x: f32,
    pub baseline_y: f32,
}

/// Half-open UTF-8 byte range in the unchanged original source string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextSourceSpan {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextFlowBreak {
    Soft,
    Hard,
    End,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextFlowLine {
    pub glyph_start: usize,
    pub glyph_end: usize,
    pub source_start: usize,
    pub source_end: usize,
    pub x: f32,
    pub y: f32,
    /// Used width after conditional hanging of pre-wrap trailing whitespace.
    pub width: f32,
    /// Full advance including preserved trailing whitespace; used to align.
    pub advance_width: f32,
    pub height: f32,
    pub baseline_y: f32,
    pub break_kind: TextFlowBreak,
}

/// Accepted normalization and line plan. `glyph_sources` parallels glyphs;
/// collapsed spaces map to the entire source whitespace run. Other glyphs
/// map to their exact original scalar. Line source ranges partition the
/// original text, including omitted controls and trimmed whitespace.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextFlowPlan {
    pub version: u16,
    pub source_sha256: String,
    pub style: TextFlowStyle,
    pub font_size: f32,
    pub line_height: LineHeight,
    pub available_width: Option<f32>,
    pub glyph_sources: Vec<TextSourceSpan>,
    pub lines: Vec<TextFlowLine>,
    pub offset_x: f32,
    pub offset_y: f32,
    /// Empty/collapsed text creates no line box, but still covers its source.
    pub empty_source: Option<TextSourceSpan>,
}

/// The accepted line-breaking and positioning plan. Consumers must use these
/// positions rather than independently measuring or wrapping the text again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextLayout {
    pub measurement: TextMeasurement,
    pub metrics: TextMetrics,
    pub glyphs: Vec<GlyphPosition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow: Option<TextFlowPlan>,
}

impl TextLayout {
    pub fn validate(&self, text: &str) -> Result<(), RenderError> {
        if let Some(flow) = &self.flow {
            return self.validate_with_style(
                text,
                TextStyle {
                    font_size: flow.font_size,
                    line_height: flow.line_height,
                    flow: Some(flow.style),
                },
            );
        }
        if ![self.metrics.width, self.metrics.height]
            .into_iter()
            .all(|value| value.is_finite() && value >= 0.0)
            || self.metrics.line_count == 0
            || self
                .glyphs
                .iter()
                .any(|glyph| !glyph.x.is_finite() || glyph.x < 0.0 || !glyph.baseline_y.is_finite())
            || !self.glyphs.iter().map(|glyph| glyph.character).eq(text
                .chars()
                .filter(|character| !matches!(character, '\r' | '\n' | '\t')))
        {
            return Err(RenderError::InvalidTextLayout);
        }
        Ok(())
    }

    pub fn validate_with_style(&self, text: &str, style: TextStyle) -> Result<(), RenderError> {
        style.validate()?;
        match (&self.flow, style.flow) {
            (None, None) => self.validate(text),
            (Some(flow), Some(properties)) => {
                validate_flow_layout(self, text, style, properties, flow)
            }
            _ => Err(RenderError::InvalidTextLayout),
        }
    }

    pub(crate) fn translate(&mut self, dx: f32, dy: f32) {
        for glyph in &mut self.glyphs {
            glyph.x += dx;
            glyph.baseline_y += dy;
        }
        if let Some(flow) = &mut self.flow {
            flow.offset_x += dx;
            flow.offset_y += dy;
            for line in &mut flow.lines {
                line.x += dx;
                line.y += dy;
                line.baseline_y += dy;
            }
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct GlyphMetrics {
    advance: f32,
    ascent: f32,
    descent: f32,
    leading: f32,
}

pub(crate) trait TextMeasurer {
    fn glyph(&mut self, character: char, size: f32) -> GlyphMetrics;
    fn measurement(&self) -> TextMeasurement;
}

pub(crate) struct FallbackTextMeasurer;

impl TextMeasurer for FallbackTextMeasurer {
    fn glyph(&mut self, _character: char, size: f32) -> GlyphMetrics {
        GlyphMetrics {
            advance: size * 0.5,
            ascent: size,
            descent: size * 0.2,
            leading: 0.0,
        }
    }
    fn measurement(&self) -> TextMeasurement {
        TextMeasurement::Fallback
    }
}

#[cfg(feature = "skia-backend")]
pub(crate) struct NativeTextMeasurer<'a>(pub(crate) &'a mut crate::NativeFonts);

#[cfg(feature = "skia-backend")]
impl TextMeasurer for NativeTextMeasurer<'_> {
    fn glyph(&mut self, character: char, size: f32) -> GlyphMetrics {
        // Measured positions must later paint with the same font provider,
        // including candidates that fail after measuring their text.
        self.0.begin_render();
        if let Some(font) = self.0.for_character(character, size) {
            let (_, metrics) = font.metrics();
            let mut encoded = [0; 4];
            let text: &str = character.encode_utf8(&mut encoded);
            GlyphMetrics {
                advance: font.measure_str(text, None).0.max(0.0),
                ascent: (-metrics.ascent).max(0.0),
                descent: metrics.descent.max(0.0),
                leading: metrics.leading.max(0.0),
            }
        } else {
            // Match the existing missing-glyph marker's actual advance.
            GlyphMetrics {
                advance: size * 0.75,
                ascent: size,
                descent: size * 0.2,
                leading: 0.0,
            }
        }
    }
    fn measurement(&self) -> TextMeasurement {
        TextMeasurement::Native
    }
}

/// Deterministic fallback metrics for callers without a host font provider.
pub fn measure_styled_text(text: &str, style: TextStyle, max_width: Option<f32>) -> TextMetrics {
    measure_with_measurer(text, style, max_width, &mut FallbackTextMeasurer)
}

pub(crate) fn layout_text(
    text: &str,
    style: TextStyle,
    max_width: Option<f32>,
    measurer: &mut dyn TextMeasurer,
) -> TextLayout {
    layout_text_impl(
        text,
        style,
        max_width,
        measurer,
        true,
        &mut TextBaselines::default(),
    )
}

#[derive(Default, Clone, Copy)]
pub(crate) struct TextBaselines {
    pub first: Option<f32>,
    pub last: Option<f32>,
}

pub(crate) fn measure_with_baselines(
    text: &str,
    style: TextStyle,
    max_width: Option<f32>,
    measurer: &mut dyn TextMeasurer,
) -> (TextMetrics, TextBaselines) {
    let mut baselines = TextBaselines::default();
    let plan = layout_text_impl(text, style, max_width, measurer, false, &mut baselines);
    (plan.metrics, baselines)
}

pub(crate) fn measure_with_measurer(
    text: &str,
    style: TextStyle,
    max_width: Option<f32>,
    measurer: &mut dyn TextMeasurer,
) -> TextMetrics {
    measure_with_baselines(text, style, max_width, measurer).0
}

#[derive(Clone, Copy)]
pub(crate) enum TextMeasureConstraint {
    Definite(f32),
    MinContent,
    MaxContent,
}

pub(crate) fn measure_with_constraint(
    text: &str,
    style: TextStyle,
    constraint: TextMeasureConstraint,
    measurer: &mut dyn TextMeasurer,
) -> (TextMetrics, TextBaselines) {
    let mut baselines = TextBaselines::default();
    let output = if style.flow.is_some() {
        layout_flow_text(text, style, constraint, measurer, false, &mut baselines)
    } else {
        // The legacy scalar profile retains its historical intrinsic sizes.
        let width = match constraint {
            TextMeasureConstraint::Definite(width) => Some(width),
            TextMeasureConstraint::MinContent => Some(0.0),
            TextMeasureConstraint::MaxContent => None,
        };
        layout_text_impl(text, style, width, measurer, false, &mut baselines)
    };
    (output.metrics, baselines)
}

fn layout_text_impl(
    text: &str,
    style: TextStyle,
    max_width: Option<f32>,
    measurer: &mut dyn TextMeasurer,
    keep_glyphs: bool,
    baselines: &mut TextBaselines,
) -> TextLayout {
    if style.flow.is_some() {
        let constraint = max_width
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map_or(
                TextMeasureConstraint::MaxContent,
                TextMeasureConstraint::Definite,
            );
        return layout_flow_text(text, style, constraint, measurer, keep_glyphs, baselines);
    }
    let mut output = TextLayout {
        measurement: measurer.measurement(),
        metrics: TextMetrics {
            width: 0.0,
            height: 0.0,
            line_count: 1,
        },
        glyphs: Vec::new(),
        flow: None,
    };
    // Renderer commit rejects invalid input. Keep infallible layout free of
    // NaN geometry without turning an invalid/zero style into default 16px.
    if style.validate().is_err() {
        return output;
    }
    let max_width = max_width.filter(|value| value.is_finite() && *value >= 0.0);
    let default = measurer.glyph(' ', style.font_size);
    let mut line_start = 0;
    let mut line_width = 0.0_f32;
    let mut line_metrics = default;
    let finish_line = |output: &mut TextLayout,
                       baselines: &mut TextBaselines,
                       start: usize,
                       width: f32,
                       metrics: GlyphMetrics| {
        let natural_height = metrics.ascent + metrics.descent + metrics.leading;
        let height = if matches!(style.line_height, LineHeight::Normal) {
            natural_height
        } else {
            style.used_line_height()
        };
        let baseline = output.metrics.height
            + (height - metrics.ascent - metrics.descent) * 0.5
            + metrics.ascent;
        baselines.first.get_or_insert(baseline);
        baselines.last = Some(baseline);
        for glyph in &mut output.glyphs[start..] {
            glyph.baseline_y = baseline;
        }
        output.metrics.width = output.metrics.width.max(width);
        output.metrics.height += height;
    };
    for character in text.chars() {
        if character == '\r' {
            continue;
        }
        if character == '\n' {
            finish_line(&mut output, baselines, line_start, line_width, line_metrics);
            output.metrics.line_count = output.metrics.line_count.saturating_add(1);
            line_start = output.glyphs.len();
            line_width = 0.0;
            line_metrics = default;
            continue;
        }
        let metrics = if character == '\t' {
            GlyphMetrics {
                advance: style.font_size * 2.0,
                ..default
            }
        } else {
            measurer.glyph(character, style.font_size)
        };
        if max_width.is_some_and(|limit| line_width > 0.0 && line_width + metrics.advance > limit) {
            finish_line(&mut output, baselines, line_start, line_width, line_metrics);
            output.metrics.line_count = output.metrics.line_count.saturating_add(1);
            line_start = output.glyphs.len();
            line_width = 0.0;
            line_metrics = default;
        }
        if keep_glyphs && character != '\t' {
            output.glyphs.push(GlyphPosition {
                character,
                x: line_width,
                baseline_y: 0.0,
            });
        }
        line_width += metrics.advance;
        line_metrics.ascent = line_metrics.ascent.max(metrics.ascent);
        line_metrics.descent = line_metrics.descent.max(metrics.descent);
        line_metrics.leading = line_metrics.leading.max(metrics.leading);
    }
    finish_line(&mut output, baselines, line_start, line_width, line_metrics);
    output
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FlowTokenKind {
    Text,
    CollapsedSpace,
    Space,
    Tab,
    Hard,
}

#[derive(Clone)]
struct FlowToken<'a> {
    source: TextSourceSpan,
    text: &'a str,
    kind: FlowTokenKind,
    break_after: bool,
    metrics: GlyphMetrics,
}

impl WhiteSpace {
    fn collapses(self) -> bool {
        matches!(self, Self::Normal | Self::Nowrap | Self::PreLine)
    }

    fn wraps(self) -> bool {
        !matches!(self, Self::Nowrap | Self::Pre)
    }
}

fn is_cjk_class(class: BreakClass) -> bool {
    matches!(
        class,
        BreakClass::Ideographic
            | BreakClass::ConditionalJapaneseStarter
            | BreakClass::HangulLvSyllable
            | BreakClass::HangulLvtSyllable
            | BreakClass::HangulLJamo
            | BreakClass::HangulVJamo
            | BreakClass::HangulTJamo
    )
}

fn break_all_boundary(left: char, right: char) -> bool {
    let left = break_property(left as u32);
    let right = break_property(right as u32);
    !matches!(
        left,
        BreakClass::OpenPunctuation
            | BreakClass::Quotation
            | BreakClass::WordJoiner
            | BreakClass::NonBreakingGlue
            | BreakClass::ZeroWidthJoiner
    ) && !matches!(
        right,
        BreakClass::ClosePunctuation
            | BreakClass::CloseParenthesis
            | BreakClass::Exclamation
            | BreakClass::InfixSeparator
            | BreakClass::NonStarter
            | BreakClass::Quotation
            | BreakClass::WordJoiner
            | BreakClass::NonBreakingGlue
            | BreakClass::CombiningMark
            | BreakClass::ZeroWidthJoiner
    )
}

/// This profile has no language metadata. Segment breaks collapse to a space
/// even between CJK letters, matching the untagged auxiliary CSS baseline.
/// FF and Unicode spaces are source characters, not CSS segment breaks.
fn normalize_flow_tokens(text: &str, style: TextFlowStyle) -> Vec<FlowToken<'_>> {
    let mut tokens: Vec<FlowToken<'_>> = Vec::new();
    let mut normalized = String::with_capacity(text.len());
    let mut ends = Vec::new();
    let mut scalars = text.char_indices().peekable();
    while let Some((start, character)) = scalars.next() {
        let mut end = start + character.len_utf8();
        if character == '\r' && scalars.peek().is_some_and(|(_, next)| *next == '\n') {
            end = scalars.next().expect("peeked LF").0 + 1;
        }
        let source = &text[start..end];
        let hard = matches!(character, '\r' | '\n');
        let collapse = matches!(character, ' ' | '\t') && style.white_space.collapses()
            || hard && matches!(style.white_space, WhiteSpace::Normal | WhiteSpace::Nowrap);
        if collapse {
            if let Some(last) = tokens
                .last_mut()
                .filter(|last| last.kind == FlowTokenKind::CollapsedSpace)
            {
                last.source.end = end;
                continue;
            }
        }
        let (kind, display) = if collapse {
            (FlowTokenKind::CollapsedSpace, " ")
        } else if hard {
            (FlowTokenKind::Hard, "\n")
        } else if character == '\t' {
            (FlowTokenKind::Tab, source)
        } else if character == ' ' {
            (FlowTokenKind::Space, source)
        } else {
            (FlowTokenKind::Text, source)
        };
        normalized.push_str(display);
        ends.push(normalized.len());
        tokens.push(FlowToken {
            source: TextSourceSpan { start, end },
            text: display,
            kind,
            break_after: false,
            metrics: GlyphMetrics {
                advance: 0.0,
                ascent: 0.0,
                descent: 0.0,
                leading: 0.0,
            },
        });
    }
    // CSS whitespace normalization precedes grapheme segmentation. Segment
    // the normalized stream so spaces adjacent to combining marks collapse
    // correctly while every soft break still respects a whole grapheme.
    let mut grapheme_ends = normalized
        .grapheme_indices(true)
        .map(|(start, grapheme)| start + grapheme.len())
        .peekable();
    let mut opportunities = linebreaks(&normalized).peekable();
    for (index, end) in ends.into_iter().enumerate() {
        while grapheme_ends.peek().is_some_and(|position| *position < end) {
            grapheme_ends.next();
        }
        let grapheme_boundary = grapheme_ends
            .peek()
            .is_some_and(|position| *position == end);
        while opportunities
            .peek()
            .is_some_and(|(position, _)| *position < end)
        {
            opportunities.next();
        }
        tokens[index].break_after = opportunities
            .peek()
            .is_some_and(|(position, _)| *position == end);
        if index + 1 < tokens.len() {
            let left = tokens[index].text.chars().next_back().unwrap_or(' ');
            let right = tokens[index + 1].text.chars().next().unwrap_or(' ');
            if style.word_break == WordBreak::BreakAll
                && tokens[index].kind == FlowTokenKind::Text
                && tokens[index + 1].kind == FlowTokenKind::Text
                && break_all_boundary(left, right)
            {
                tokens[index].break_after = true;
            }
            if style.word_break == WordBreak::KeepAll
                && is_cjk_class(break_property(left as u32))
                && is_cjk_class(break_property(right as u32))
            {
                tokens[index].break_after = false;
            }
        }
        if style.white_space == WhiteSpace::BreakSpaces
            && matches!(
                tokens[index].kind,
                FlowTokenKind::Space | FlowTokenKind::Tab
            )
        {
            tokens[index].break_after = true;
        }
        tokens[index].break_after &= grapheme_boundary;
    }
    tokens
}

pub(crate) fn zero_advance(character: char) -> bool {
    matches!(character, '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{2060}' | '\u{feff}' | '\u{fe00}'..='\u{fe0f}' | '\u{e0100}'..='\u{e01ef}')
}

fn token_advance(token: &FlowToken<'_>, x: f32, tab_stop: f32) -> f32 {
    if token.kind == FlowTokenKind::Tab {
        if tab_stop == 0.0 {
            0.0
        } else {
            ((x / tab_stop).floor() + 1.0) * tab_stop - x
        }
    } else {
        token.metrics.advance
    }
}

#[derive(Clone, Copy)]
struct FlowLineRange {
    start: usize,
    end: usize,
    kind: TextFlowBreak,
}

fn hanging(token: &FlowToken<'_>, white_space: WhiteSpace) -> bool {
    token.kind == FlowTokenKind::CollapsedSpace
        || white_space == WhiteSpace::PreWrap
            && matches!(token.kind, FlowTokenKind::Space | FlowTokenKind::Tab)
}

fn flow_line_ranges(
    tokens: &[FlowToken<'_>],
    style: TextFlowStyle,
    constraint: TextMeasureConstraint,
    tab_stop: f32,
) -> Vec<FlowLineRange> {
    let limit = if !style.white_space.wraps() {
        None
    } else {
        match constraint {
            TextMeasureConstraint::Definite(width) => Some(width),
            TextMeasureConstraint::MinContent => Some(0.0),
            TextMeasureConstraint::MaxContent => None,
        }
    };
    let mut lines = Vec::new();
    let mut start = 0;
    let mut index = 0;
    let mut width = 0.0_f32;
    let mut trailing = 0.0_f32;
    let mut has_content = false;
    let mut last_break = None;
    while index < tokens.len() {
        let token = &tokens[index];
        if token.kind == FlowTokenKind::Hard {
            lines.push(FlowLineRange {
                start,
                end: index + 1,
                kind: TextFlowBreak::Hard,
            });
            index += 1;
            start = index;
            width = 0.0;
            trailing = 0.0;
            has_content = false;
            last_break = None;
            continue;
        }
        let advance = if !has_content && token.kind == FlowTokenKind::CollapsedSpace {
            0.0
        } else {
            token_advance(token, width, tab_stop)
        };
        let candidate = width + advance;
        let new_trailing = if hanging(token, style.white_space) {
            trailing + advance
        } else {
            0.0
        };
        let wrap_boundary = limit
            .is_some_and(|limit| candidate - new_trailing > limit)
            .then_some(last_break)
            .flatten()
            .filter(|boundary| *boundary > start);
        if let Some(boundary) = wrap_boundary {
            lines.push(FlowLineRange {
                start,
                end: boundary,
                kind: TextFlowBreak::Soft,
            });
            start = boundary;
            index = boundary;
            width = 0.0;
            trailing = 0.0;
            has_content = false;
            last_break = None;
            continue;
        }
        width = candidate;
        trailing = new_trailing;
        has_content |= token.kind != FlowTokenKind::CollapsedSpace;
        index += 1;
        if token.break_after && has_content && index < tokens.len() {
            last_break = Some(index);
        }
    }
    if start < tokens.len() {
        if tokens[start..]
            .iter()
            .all(|token| token.kind == FlowTokenKind::CollapsedSpace)
        {
            // A final collapsed run cannot create a line box. Keep its source
            // in the previous line; an all-collapsed string uses empty_source.
            if let Some(last) = lines.last_mut() {
                last.end = tokens.len();
            }
        } else {
            lines.push(FlowLineRange {
                start,
                end: tokens.len(),
                kind: TextFlowBreak::End,
            });
        }
    }
    lines
}

fn trimmed_range(tokens: &[FlowToken<'_>], line: FlowLineRange) -> (usize, usize) {
    let mut start = line.start;
    let mut end = line.end;
    while start < end && tokens[start].kind == FlowTokenKind::CollapsedSpace {
        start += 1;
    }
    while end > start
        && matches!(
            tokens[end - 1].kind,
            FlowTokenKind::CollapsedSpace | FlowTokenKind::Hard
        )
    {
        end -= 1;
    }
    (start, end)
}

fn alignment_offset(align: TextAlign, width: f32, available: Option<f32>) -> f32 {
    let remaining = (available.unwrap_or(width) - width).max(0.0);
    match align {
        TextAlign::Start | TextAlign::Left => 0.0,
        TextAlign::End | TextAlign::Right => remaining,
        TextAlign::Center => remaining * 0.5,
    }
}

fn layout_flow_text(
    text: &str,
    style: TextStyle,
    constraint: TextMeasureConstraint,
    measurer: &mut dyn TextMeasurer,
    keep_glyphs: bool,
    baselines: &mut TextBaselines,
) -> TextLayout {
    let properties = style.flow.expect("text-flow style");
    let available_width = match constraint {
        TextMeasureConstraint::Definite(width) if width.is_finite() && width >= 0.0 => Some(width),
        _ => None,
    };
    let mut output = TextLayout {
        measurement: measurer.measurement(),
        metrics: TextMetrics {
            width: 0.0,
            height: 0.0,
            line_count: 0,
        },
        glyphs: Vec::new(),
        flow: keep_glyphs.then(|| TextFlowPlan {
            version: 1,
            source_sha256: format!("{:x}", Sha256::digest(text.as_bytes())),
            style: properties,
            font_size: style.font_size,
            line_height: style.line_height,
            available_width,
            glyph_sources: Vec::new(),
            lines: Vec::new(),
            offset_x: 0.0,
            offset_y: 0.0,
            empty_source: None,
        }),
    };
    if style.validate().is_err() {
        return output;
    }
    let default = measurer.glyph(' ', style.font_size);
    let tab_stop = default.advance * 8.0;
    let mut tokens = normalize_flow_tokens(text, properties);
    for token in &mut tokens {
        token.metrics = default;
        token.metrics.advance = 0.0;
        if !matches!(token.kind, FlowTokenKind::Hard | FlowTokenKind::Tab) {
            for character in token.text.chars() {
                let metrics = measurer.glyph(character, style.font_size);
                if !zero_advance(character) {
                    token.metrics.advance += metrics.advance;
                }
                token.metrics.ascent = token.metrics.ascent.max(metrics.ascent);
                token.metrics.descent = token.metrics.descent.max(metrics.descent);
                token.metrics.leading = token.metrics.leading.max(metrics.leading);
            }
        }
    }
    let ranges = flow_line_ranges(&tokens, properties, constraint, tab_stop);
    for range in &ranges {
        let (start, end) = trimmed_range(&tokens, *range);
        let glyph_start = output.glyphs.len();
        let mut metrics = default;
        let mut width = 0.0_f32;
        let mut trailing = 0.0_f32;
        for token in &tokens[start..end] {
            let advance = token_advance(token, width, tab_stop);
            if keep_glyphs && !matches!(token.kind, FlowTokenKind::Hard | FlowTokenKind::Tab) {
                let mut x = width;
                for (offset, character) in token.text.char_indices() {
                    output.glyphs.push(GlyphPosition {
                        character,
                        x,
                        baseline_y: 0.0,
                    });
                    output.flow.as_mut().unwrap().glyph_sources.push(
                        if token.kind == FlowTokenKind::CollapsedSpace {
                            token.source
                        } else {
                            TextSourceSpan {
                                start: token.source.start + offset,
                                end: token.source.start + offset + character.len_utf8(),
                            }
                        },
                    );
                    if !zero_advance(character) {
                        x += measurer.glyph(character, style.font_size).advance;
                    }
                }
            }
            width += advance;
            trailing = if hanging(token, properties.white_space) {
                trailing + advance
            } else {
                0.0
            };
            metrics.ascent = metrics.ascent.max(token.metrics.ascent);
            metrics.descent = metrics.descent.max(token.metrics.descent);
            metrics.leading = metrics.leading.max(token.metrics.leading);
        }
        let advance_width = width;
        let hangs = properties.white_space == WhiteSpace::PreWrap
            && match constraint {
                TextMeasureConstraint::MinContent => true,
                TextMeasureConstraint::Definite(limit) => width > limit,
                TextMeasureConstraint::MaxContent => false,
            };
        let width = if hangs {
            (width - trailing).max(0.0)
        } else {
            width
        };
        let height = if matches!(style.line_height, LineHeight::Normal) {
            metrics.ascent + metrics.descent + metrics.leading
        } else {
            style.used_line_height()
        };
        let y = output.metrics.height;
        let baseline = y + (height - metrics.ascent - metrics.descent) * 0.5 + metrics.ascent;
        let x = alignment_offset(properties.text_align, advance_width, available_width);
        for glyph in &mut output.glyphs[glyph_start..] {
            glyph.x += x;
            glyph.baseline_y = baseline;
        }
        baselines.first.get_or_insert(baseline);
        baselines.last = Some(baseline);
        if let Some(flow) = &mut output.flow {
            flow.lines.push(TextFlowLine {
                glyph_start,
                glyph_end: output.glyphs.len(),
                source_start: tokens[range.start].source.start,
                source_end: tokens[range.end - 1].source.end,
                x,
                y,
                width,
                advance_width,
                height,
                baseline_y: baseline,
                break_kind: range.kind,
            });
        }
        output.metrics.width = output.metrics.width.max(width);
        output.metrics.height += height;
        output.metrics.line_count = output.metrics.line_count.saturating_add(1);
    }
    if let Some(flow) = &mut output.flow {
        if ranges.is_empty() {
            flow.empty_source = Some(TextSourceSpan {
                start: 0,
                end: text.len(),
            });
        }
    }
    output
}

fn validate_flow_layout(
    layout: &TextLayout,
    text: &str,
    style: TextStyle,
    properties: TextFlowStyle,
    flow: &TextFlowPlan,
) -> Result<(), RenderError> {
    let invalid = || RenderError::InvalidTextLayout;
    let nonnegative = |value: f32| value.is_finite() && value >= 0.0;
    if flow.version != 1
        || flow.style != properties
        || flow.font_size != style.font_size
        || flow.line_height != style.line_height
        || flow.source_sha256 != format!("{:x}", Sha256::digest(text.as_bytes()))
        || flow
            .available_width
            .is_some_and(|width| !nonnegative(width))
        || !flow.offset_x.is_finite()
        || !flow.offset_y.is_finite()
        || !nonnegative(layout.metrics.width)
        || !nonnegative(layout.metrics.height)
        || flow.lines.len() != layout.metrics.line_count as usize
        || flow.glyph_sources.len() != layout.glyphs.len()
        || flow.lines.len() > text.chars().count()
        || layout.glyphs.len() > text.chars().count()
    {
        return Err(invalid());
    }
    let tokens = normalize_flow_tokens(text, properties);
    if flow.lines.is_empty() {
        return if flow.empty_source
            == Some(TextSourceSpan {
                start: 0,
                end: text.len(),
            })
            && tokens
                .iter()
                .all(|token| token.kind == FlowTokenKind::CollapsedSpace)
            && layout.glyphs.is_empty()
            && layout.metrics.width == 0.0
            && layout.metrics.height == 0.0
        {
            Ok(())
        } else {
            Err(invalid())
        };
    }
    if flow.empty_source.is_some() {
        return Err(invalid());
    }
    let mut source_end = 0;
    let mut glyph_end = 0;
    let mut token_cursor = 0;
    let mut height = 0.0_f32;
    let mut width = 0.0_f32;
    for (line_index, line) in flow.lines.iter().enumerate() {
        if line.source_start != source_end
            || line.source_end <= line.source_start
            || line.source_end > text.len()
            || line.glyph_start != glyph_end
            || line.glyph_end < line.glyph_start
            || line.glyph_end > layout.glyphs.len()
            || ![line.x, line.y, line.baseline_y]
                .into_iter()
                .all(f32::is_finite)
            || !nonnegative(line.width)
            || !nonnegative(line.advance_width)
            || line.width > line.advance_width
            || (properties.white_space != WhiteSpace::PreWrap && line.width != line.advance_width)
            || (properties.white_space == WhiteSpace::PreWrap
                && flow
                    .available_width
                    .is_none_or(|width| line.advance_width <= width)
                && line.width != line.advance_width)
            || !nonnegative(line.height)
            || line.y != height + flow.offset_y
            || line.x
                != alignment_offset(
                    properties.text_align,
                    line.advance_width,
                    flow.available_width,
                ) + flow.offset_x
            || (!matches!(style.line_height, LineHeight::Normal)
                && line.height != style.used_line_height())
        {
            return Err(invalid());
        }
        let start = token_cursor;
        while token_cursor < tokens.len() && tokens[token_cursor].source.end <= line.source_end {
            token_cursor += 1;
        }
        if token_cursor == start
            || tokens[start].source.start != line.source_start
            || tokens[token_cursor - 1].source.end != line.source_end
        {
            return Err(invalid());
        }
        let hard = tokens[start..token_cursor]
            .iter()
            .position(|token| token.kind == FlowTokenKind::Hard);
        match line.break_kind {
            TextFlowBreak::Hard => {
                let hard = hard.ok_or_else(invalid)? + start;
                if tokens[hard + 1..token_cursor]
                    .iter()
                    .any(|token| token.kind != FlowTokenKind::CollapsedSpace)
                    || hard + 1 != token_cursor && line_index + 1 != flow.lines.len()
                {
                    return Err(invalid());
                }
            }
            TextFlowBreak::Soft => {
                if hard.is_some()
                    || !properties.white_space.wraps()
                    || !tokens[token_cursor - 1].break_after
                    || line_index + 1 == flow.lines.len()
                {
                    return Err(invalid());
                }
            }
            TextFlowBreak::End => {
                if hard.is_some() || line_index + 1 != flow.lines.len() {
                    return Err(invalid());
                }
            }
        }
        let range = FlowLineRange {
            start,
            end: token_cursor,
            kind: line.break_kind,
        };
        let (paint_start, paint_end) = trimmed_range(&tokens, range);
        if paint_start == paint_end && hard.is_none() {
            return Err(invalid());
        }
        let mut actual = line.glyph_start;
        let mut previous_x = line.x;
        for token in &tokens[paint_start..paint_end] {
            if matches!(token.kind, FlowTokenKind::Hard | FlowTokenKind::Tab) {
                continue;
            }
            for (offset, character) in token.text.char_indices() {
                if actual >= line.glyph_end {
                    return Err(invalid());
                }
                let expected = if token.kind == FlowTokenKind::CollapsedSpace {
                    token.source
                } else {
                    TextSourceSpan {
                        start: token.source.start + offset,
                        end: token.source.start + offset + character.len_utf8(),
                    }
                };
                let glyph = layout.glyphs[actual];
                if flow.glyph_sources[actual] != expected
                    || glyph.character != character
                    || !glyph.x.is_finite()
                    || glyph.x < previous_x
                    || glyph.baseline_y != line.baseline_y
                {
                    return Err(invalid());
                }
                previous_x = glyph.x;
                actual += 1;
            }
        }
        if actual != line.glyph_end {
            return Err(invalid());
        }
        source_end = line.source_end;
        glyph_end = line.glyph_end;
        height += line.height;
        width = width.max(line.width);
    }
    if source_end != text.len()
        || glyph_end != layout.glyphs.len()
        || height != layout.metrics.height
        || width != layout.metrics.width
    {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flowing(white_space: WhiteSpace, word_break: WordBreak, text_align: TextAlign) -> TextStyle {
        TextStyle {
            font_size: 10.0,
            line_height: LineHeight::Px(20.0),
            flow: Some(TextFlowStyle {
                white_space,
                word_break,
                text_align,
            }),
        }
    }

    fn plan(text: &str, style: TextStyle, width: Option<f32>) -> TextLayout {
        let plan = layout_text(text, style, width, &mut FallbackTextMeasurer);
        assert_eq!(plan.validate_with_style(text, style), Ok(()));
        plan
    }

    fn glyph_text(plan: &TextLayout) -> String {
        plan.glyphs.iter().map(|glyph| glyph.character).collect()
    }

    #[test]
    fn flow_collapses_only_source_whitespace_and_retains_original_utf8_mapping() {
        let source = "  A\r\n\t  B\u{00a0}C\u{202f}D\u{3000}E\u{c}F  ";
        let style = flowing(WhiteSpace::Normal, WordBreak::Normal, TextAlign::Start);
        let layout = plan(source, style, None);
        assert_eq!(glyph_text(&layout), "A B\u{00a0}C\u{202f}D\u{3000}E\u{c}F");
        let flow = layout.flow.as_ref().unwrap();
        assert_eq!(flow.glyph_sources[1], TextSourceSpan { start: 3, end: 8 });
        assert_eq!(
            &source[flow.glyph_sources[1].start..flow.glyph_sources[1].end],
            "\r\n\t  "
        );
        for (glyph, span) in layout.glyphs.iter().zip(&flow.glyph_sources) {
            assert!(source.is_char_boundary(span.start) && source.is_char_boundary(span.end));
            if glyph.character != ' ' {
                assert_eq!(&source[span.start..span.end], glyph.character.to_string());
            }
        }
        assert_eq!(flow.lines[0].source_start, 0);
        assert_eq!(flow.lines[0].source_end, source.len());
        assert_eq!(
            serde_json::from_str::<TextLayout>(&serde_json::to_string(&layout).unwrap()).unwrap(),
            layout
        );
    }

    #[test]
    fn whitespace_normalizes_before_grapheme_breaking_and_marks_keep_their_own_source() {
        for mode in [WhiteSpace::Normal, WhiteSpace::PreLine] {
            let style = flowing(mode, WordBreak::Normal, TextAlign::Start);
            let leading = plan("  \u{301}A  ", style, Some(60.0));
            assert_eq!(glyph_text(&leading), "\u{301}A");
            assert_eq!(
                leading.flow.as_ref().unwrap().glyph_sources[0],
                TextSourceSpan { start: 2, end: 4 }
            );
            let middle = plan("A  \u{301}B ", style, Some(60.0));
            assert_eq!(glyph_text(&middle), "A \u{301}B");
            assert_eq!(
                middle.flow.as_ref().unwrap().glyph_sources[1],
                TextSourceSpan { start: 1, end: 3 }
            );
            assert_eq!(
                middle.flow.as_ref().unwrap().glyph_sources[2],
                TextSourceSpan { start: 3, end: 5 }
            );
        }
        let preserve = flowing(WhiteSpace::PreWrap, WordBreak::BreakAll, TextAlign::Start);
        let grouped = plan(" \u{301}B", preserve, Some(5.0));
        assert_eq!(grouped.metrics.line_count, 2);
        assert_eq!(grouped.glyphs[0].character, ' ');
        assert_eq!(grouped.glyphs[1].character, '\u{301}');
        assert_eq!(
            grouped.glyphs[0].baseline_y, grouped.glyphs[1].baseline_y,
            "normalized space and combining mark cannot be split"
        );
        // Even when word-break permits arbitrary letter boundaries, the plan
        // validator must reject a forged soft line inside that grapheme.
        let mut forged = grouped;
        let flow = forged.flow.as_mut().unwrap();
        flow.lines[0].source_end = 1;
        flow.lines[0].glyph_end = 1;
        flow.lines[1].source_start = 1;
        flow.lines[1].glyph_start = 1;
        assert_eq!(
            forged.validate_with_style(" \u{301}B", preserve),
            Err(RenderError::InvalidTextLayout)
        );
    }

    #[test]
    fn white_space_modes_keep_crlf_and_terminal_newline_semantics_distinct() {
        for (white_space, lines) in [
            (WhiteSpace::Normal, 1),
            (WhiteSpace::Nowrap, 1),
            (WhiteSpace::Pre, 3),
            (WhiteSpace::PreWrap, 3),
            (WhiteSpace::PreLine, 3),
            (WhiteSpace::BreakSpaces, 3),
        ] {
            let style = flowing(white_space, WordBreak::Normal, TextAlign::Start);
            let layout = plan("\r\nAA\r\n\n", style, Some(100.0));
            assert_eq!(layout.metrics.line_count, lines, "{white_space:?}");
            assert_eq!(glyph_text(&layout), "AA");
            let terminal = plan("AA\n", style, Some(100.0));
            assert_eq!(terminal.metrics.line_count, 1);
            if !matches!(white_space, WhiteSpace::Normal | WhiteSpace::Nowrap) {
                assert_eq!(
                    terminal.flow.as_ref().unwrap().lines[0].break_kind,
                    TextFlowBreak::Hard
                );
            }
            let empty = plan("", style, Some(100.0));
            assert_eq!(empty.metrics.line_count, 0);
            assert_eq!(empty.metrics.height, 0.0);
            assert_eq!(
                empty.flow.as_ref().unwrap().empty_source,
                Some(TextSourceSpan { start: 0, end: 0 })
            );
            let spaces = plan("   ", style, Some(100.0));
            assert_eq!(
                spaces.metrics.line_count,
                u32::from(!white_space.collapses())
            );
        }
        let style = flowing(WhiteSpace::PreLine, WordBreak::Normal, TextAlign::Start);
        let terminal = plan("A\n  ", style, Some(100.0));
        assert_eq!(terminal.metrics.line_count, 1);
        assert_eq!(terminal.flow.as_ref().unwrap().lines[0].source_end, 4);
    }

    #[test]
    fn soft_wrapping_uses_legal_word_and_grapheme_boundaries() {
        let normal = flowing(WhiteSpace::Normal, WordBreak::Normal, TextAlign::Start);
        let all = flowing(WhiteSpace::Normal, WordBreak::BreakAll, TextAlign::Start);
        let keep = flowing(WhiteSpace::Normal, WordBreak::KeepAll, TextAlign::Start);
        assert_eq!(plan("  ABCDEFG ", normal, Some(10.0)).metrics.line_count, 1);
        assert_eq!(plan("ABCDEFG", all, Some(10.0)).metrics.line_count, 4);
        assert_eq!(plan("AA BB", normal, Some(15.0)).metrics.line_count, 2);
        assert_eq!(plan("你好世界", normal, Some(10.0)).metrics.line_count, 2);
        assert_eq!(plan("你好世界", keep, Some(10.0)).metrics.line_count, 1);
        assert_eq!(plan("你好，世界。", keep, Some(10.0)).metrics.line_count, 2);
        let punctuation = plan("你好，世界。", all, Some(5.0));
        for line in &punctuation.flow.as_ref().unwrap().lines {
            let first = punctuation.glyphs[line.glyph_start].character;
            assert!(!matches!(first, '，' | '。'));
        }
        assert_eq!(
            plan("AA\u{00a0}BB", normal, Some(10.0)).metrics.line_count,
            1
        );
        let clusters = plan("e\u{301}e\u{301}", all, Some(5.0));
        assert_eq!(clusters.metrics.line_count, 2);
        assert_eq!(clusters.glyphs[0].baseline_y, clusters.glyphs[1].baseline_y);
        assert_eq!(clusters.glyphs[2].baseline_y, clusters.glyphs[3].baseline_y);
        let emoji = plan("👩‍💻👩‍💻", all, Some(5.0));
        assert_eq!(emoji.metrics.line_count, 2);
        assert!(emoji.glyphs[..3]
            .iter()
            .all(|glyph| glyph.baseline_y == emoji.glyphs[0].baseline_y));
        let zwsp = plan("AB\u{200b}CD", normal, Some(10.0));
        assert_eq!(zwsp.metrics.line_count, 2);
        assert_eq!(zwsp.glyphs[2].x, 10.0);
    }

    #[test]
    fn preserved_tabs_use_eight_space_stops_and_hanging_spaces_do_not_become_extra_lines() {
        let pre = flowing(WhiteSpace::Pre, WordBreak::Normal, TextAlign::Start);
        assert_eq!(plan("1234567\tA", pre, None).glyphs.last().unwrap().x, 40.0);
        assert_eq!(
            plan("12345678\tA", pre, None).glyphs.last().unwrap().x,
            80.0
        );
        let wrap = flowing(WhiteSpace::PreWrap, WordBreak::Normal, TextAlign::Start);
        let breaks = flowing(WhiteSpace::BreakSpaces, WordBreak::Normal, TextAlign::Start);
        let hanging = plan("AA   BB ", wrap, Some(15.0));
        assert_eq!(hanging.metrics.line_count, 2);
        assert_eq!(hanging.metrics.width, 15.0);
        assert_eq!(hanging.flow.as_ref().unwrap().lines[0].width, 10.0);
        assert_eq!(hanging.flow.as_ref().unwrap().lines[0].advance_width, 25.0);
        assert_eq!(glyph_text(&hanging), "AA   BB ");
        assert_eq!(plan("AA   BB ", breaks, Some(15.0)).metrics.line_count, 3);
        let tab_wrap = plan("B\tC", wrap, Some(15.0));
        assert_eq!(tab_wrap.metrics.line_count, 2);
        assert_eq!(tab_wrap.glyphs[1].x, 0.0);
        assert_eq!(tab_wrap.flow.as_ref().unwrap().lines[0].width, 5.0);
        let break_tab = plan("B\tC", breaks, Some(15.0));
        assert_eq!(break_tab.flow.as_ref().unwrap().lines[0].width, 40.0);
        let center = TextStyle {
            flow: Some(TextFlowStyle {
                text_align: TextAlign::Center,
                ..wrap.flow.unwrap()
            }),
            ..wrap
        };
        let centered = plan("AA   ", center, Some(70.0));
        assert_eq!(
            centered.glyphs[0].x, 22.5,
            "alignment includes the complete preserved space advance"
        );
        let right = TextStyle {
            flow: Some(TextFlowStyle {
                text_align: TextAlign::Right,
                ..wrap.flow.unwrap()
            }),
            ..wrap
        };
        let overflowing = plan("AA   ", right, Some(20.0));
        assert_eq!(overflowing.glyphs[0].x, 0.0);
        assert_eq!(overflowing.flow.as_ref().unwrap().lines[0].width, 10.0);
    }

    #[test]
    fn min_content_is_longest_legal_segment_and_max_content_does_not_soft_wrap() {
        let normal = flowing(WhiteSpace::Normal, WordBreak::Normal, TextAlign::Start);
        let measure = |source, style, constraint| {
            measure_with_constraint(source, style, constraint, &mut FallbackTextMeasurer).0
        };
        assert_eq!(
            measure("LONG WORD", normal, TextMeasureConstraint::MinContent).width,
            20.0
        );
        assert_eq!(
            measure("LONG WORD", normal, TextMeasureConstraint::MaxContent).width,
            45.0
        );
        let all = flowing(WhiteSpace::Normal, WordBreak::BreakAll, TextAlign::Start);
        assert_eq!(
            measure("LONG", all, TextMeasureConstraint::MinContent).width,
            5.0
        );
        for (mode, minimum, maximum) in [
            (WhiteSpace::PreWrap, 10.0, 40.0),
            (WhiteSpace::BreakSpaces, 15.0, 40.0),
            (WhiteSpace::Pre, 40.0, 40.0),
        ] {
            let style = flowing(mode, WordBreak::Normal, TextAlign::Start);
            assert_eq!(
                measure("AA   BB ", style, TextMeasureConstraint::MinContent).width,
                minimum
            );
            assert_eq!(
                measure("AA   BB ", style, TextMeasureConstraint::MaxContent).width,
                maximum
            );
        }
    }

    #[test]
    fn alignment_uses_allocated_line_width_and_preserves_zero_values() {
        for (align, expected) in [
            (TextAlign::Start, [0.0, 0.0]),
            (TextAlign::Left, [0.0, 0.0]),
            (TextAlign::Right, [50.0, 55.0]),
            (TextAlign::End, [50.0, 55.0]),
            (TextAlign::Center, [25.0, 27.5]),
        ] {
            let style = flowing(WhiteSpace::Pre, WordBreak::Normal, align);
            let layout = plan("AA\nA", style, Some(60.0));
            assert_eq!(layout.metrics.width, 10.0);
            assert_eq!(layout.glyphs[0].x, expected[0]);
            assert_eq!(layout.glyphs[2].x, expected[1]);
            let nowrap = TextStyle {
                flow: Some(TextFlowStyle {
                    white_space: WhiteSpace::Nowrap,
                    ..style.flow.unwrap()
                }),
                ..style
            };
            assert_eq!(plan("ABCDEFGHIJ", nowrap, Some(15.0)).glyphs[0].x, 0.0);
            let zero = TextStyle {
                line_height: LineHeight::Px(0.0),
                ..style
            };
            let zero = plan("A\nA", zero, Some(60.0));
            assert_eq!(zero.metrics.height, 0.0);
            assert_eq!(zero.glyphs[0].baseline_y, zero.glyphs[1].baseline_y);
        }
    }

    #[test]
    fn mapped_plan_rejects_stale_source_style_ranges_and_illegal_omissions() {
        let style = flowing(WhiteSpace::Normal, WordBreak::Normal, TextAlign::Center);
        let source = "  A  B\u{00a0}C  ";
        let accepted = plan(source, style, Some(60.0));
        assert_eq!(
            accepted.validate_with_style("different", style),
            Err(RenderError::InvalidTextLayout)
        );
        assert_eq!(
            accepted.validate_with_style(
                source,
                TextStyle {
                    font_size: 11.0,
                    ..style
                }
            ),
            Err(RenderError::InvalidTextLayout)
        );
        assert_eq!(
            accepted.validate_with_style(
                source,
                TextStyle {
                    flow: None,
                    ..style
                }
            ),
            Err(RenderError::InvalidTextLayout)
        );
        let mutations: [fn(&mut TextLayout); 10] = [
            |layout| layout.flow.as_mut().unwrap().version = 2,
            |layout| layout.flow.as_mut().unwrap().glyph_sources[0].start = 0,
            |layout| layout.flow.as_mut().unwrap().glyph_sources[1].end -= 1,
            |layout| layout.flow.as_mut().unwrap().lines[0].source_start = 1,
            |layout| layout.flow.as_mut().unwrap().lines[0].glyph_end -= 1,
            |layout| layout.flow.as_mut().unwrap().lines[0].x += 1.0,
            |layout| layout.glyphs[0].character = 'X',
            |layout| layout.glyphs[0].baseline_y += 1.0,
            |layout| layout.flow.as_mut().unwrap().available_width = Some(f32::INFINITY),
            |layout| layout.flow.as_mut().unwrap().lines[0].break_kind = TextFlowBreak::Soft,
        ];
        for mutate in mutations {
            let mut candidate = accepted.clone();
            mutate(&mut candidate);
            assert_eq!(
                candidate.validate_with_style(source, style),
                Err(RenderError::InvalidTextLayout)
            );
        }
        let mut dropped = accepted.clone();
        dropped.glyphs.remove(0);
        dropped.flow.as_mut().unwrap().glyph_sources.remove(0);
        dropped.flow.as_mut().unwrap().lines[0].glyph_end -= 1;
        assert_eq!(
            dropped.validate_with_style(source, style),
            Err(RenderError::InvalidTextLayout)
        );
        // Replacing a hard LF with CR has the same visible glyph stream but
        // remains a different immutable source and must not reuse the plan.
        let hard = flowing(WhiteSpace::Pre, WordBreak::Normal, TextAlign::Start);
        assert_eq!(
            plan("A\nB", hard, Some(60.0)).validate_with_style("A\rB", hard),
            Err(RenderError::InvalidTextLayout)
        );
    }

    #[test]
    fn mapped_measurement_does_not_retain_positions_or_wire_source_mapping() {
        let source = "word ".repeat(20_000);
        let style = flowing(WhiteSpace::Normal, WordBreak::Normal, TextAlign::Start);
        let measured = layout_flow_text(
            &source,
            style,
            TextMeasureConstraint::Definite(100.0),
            &mut FallbackTextMeasurer,
            false,
            &mut TextBaselines::default(),
        );
        assert_eq!(measured.glyphs.capacity(), 0);
        assert_eq!(measured.flow, None);
        assert_eq!(measured.metrics, plan(&source, style, Some(100.0)).metrics);
    }

    #[test]
    fn zero_font_size_and_explicit_zero_line_height_remain_zero() {
        let invisible = TextStyle {
            font_size: 0.0,
            line_height: LineHeight::Normal,
            flow: None,
        };
        assert_eq!(invisible.validate(), Ok(()));
        assert_eq!(
            measure_styled_text("ABC", invisible, Some(0.0)),
            TextMetrics {
                width: 0.0,
                height: 0.0,
                line_count: 1
            }
        );
        let overlap = TextStyle {
            font_size: 10.0,
            line_height: LineHeight::Px(0.0),
            flow: None,
        };
        let plan = layout_text("AB\nCD", overlap, None, &mut FallbackTextMeasurer);
        assert_eq!(
            plan.metrics,
            TextMetrics {
                width: 10.0,
                height: 0.0,
                line_count: 2
            }
        );
        assert_eq!(plan.glyphs.len(), 4);
        assert_eq!(plan.glyphs[0].baseline_y, plan.glyphs[2].baseline_y);
        assert_eq!(plan.validate("AB\nCD"), Ok(()));
    }

    #[test]
    fn shared_plan_breaks_lines_and_keeps_tab_cr_lf_out_of_glyph_stream() {
        let style = TextStyle {
            font_size: 10.0,
            line_height: LineHeight::Number(2.0),
            flow: None,
        };
        let plan = layout_text("ABCD\r\nE\tF", style, Some(10.0), &mut FallbackTextMeasurer);
        assert_eq!(
            plan.metrics,
            TextMetrics {
                width: 20.0,
                height: 100.0,
                line_count: 5
            }
        );
        assert_eq!(
            plan.glyphs
                .iter()
                .map(|glyph| glyph.character)
                .collect::<String>(),
            "ABCDEF"
        );
        assert_eq!(plan.glyphs[1].x, 5.0);
        assert_eq!(plan.glyphs[2].x, 0.0);
        assert_eq!(plan.glyphs[2].baseline_y - plan.glyphs[0].baseline_y, 20.0);
        assert_eq!(plan.validate("ABCD\r\nE\tF"), Ok(()));
        assert_eq!(
            plan.validate("outdated"),
            Err(RenderError::InvalidTextLayout)
        );
    }

    #[test]
    fn invalid_typography_does_not_turn_into_a_default_sized_font() {
        for style in [
            TextStyle {
                font_size: f32::NAN,
                ..TextStyle::default()
            },
            TextStyle {
                font_size: -1.0,
                ..TextStyle::default()
            },
            TextStyle {
                line_height: LineHeight::Px(f32::INFINITY),
                ..TextStyle::default()
            },
            TextStyle {
                line_height: LineHeight::Number(-1.0),
                ..TextStyle::default()
            },
            TextStyle {
                font_size: f32::MAX,
                line_height: LineHeight::Number(2.0),
                flow: None,
            },
        ] {
            assert_eq!(style.validate(), Err(RenderError::InvalidTextStyle));
            assert_eq!(measure_styled_text("A", style, None).width, 0.0);
        }
    }

    #[test]
    fn wire_contract_retains_line_height_kind_and_validates_positions() {
        assert_eq!(
            serde_json::to_value(LineHeight::Normal).unwrap(),
            serde_json::json!("normal")
        );
        assert_eq!(
            serde_json::to_value(LineHeight::Number(1.5)).unwrap(),
            serde_json::json!({"number":1.5})
        );
        assert_eq!(
            serde_json::to_value(LineHeight::Px(10.0)).unwrap(),
            serde_json::json!({"px":10.0})
        );
        let mut plan = layout_text("A", TextStyle::default(), None, &mut FallbackTextMeasurer);
        let encoded = serde_json::to_string(&plan).unwrap();
        assert_eq!(serde_json::from_str::<TextLayout>(&encoded).unwrap(), plan);
        plan.glyphs[0].baseline_y = -10.0;
        assert_eq!(plan.validate("A"), Ok(()));
        plan.glyphs[0].x = f32::NAN;
        assert_eq!(plan.validate("A"), Err(RenderError::InvalidTextLayout));
    }

    #[test]
    fn measurement_only_pass_does_not_allocate_or_retain_glyph_positions() {
        let text = "A".repeat(100_000);
        let measured = layout_text_impl(
            &text,
            TextStyle::default(),
            Some(800.0),
            &mut FallbackTextMeasurer,
            false,
            &mut TextBaselines::default(),
        );
        assert_eq!(measured.glyphs.capacity(), 0);
        assert_eq!(measured.metrics.line_count, 1_000);
        assert_eq!(measured.metrics.width, 800.0);
        let planned = layout_text(
            &text,
            TextStyle::default(),
            Some(800.0),
            &mut FallbackTextMeasurer,
        );
        assert_eq!(measured.metrics, planned.metrics);
        assert_eq!(planned.glyphs.len(), 100_000);
    }
}
