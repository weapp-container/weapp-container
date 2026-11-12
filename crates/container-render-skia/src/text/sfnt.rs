//! Exact, unhinted, default-instance SFNT metrics for external frame owners.
//! Face bytes belong to the same session/Canvas owner as the accepted layout.
use super::{GlyphMetrics, TextMeasurement, TextMeasurer};
use crate::{
    DisplayMode, RenderError, RenderNode, MAX_FRAME_TEXT_CHARACTERS, MAX_PAINT_DEPTH,
    MAX_PAINT_NODES,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub const MAX_PORTABLE_FONT_BYTES: usize = 32 * 1024 * 1024;

/// The profile includes face zero, default variation coordinates, linear
/// advances and no hinting. It does not imply shaping or CSS family/weight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortableFontIdentity {
    #[serde(with = "hex_digest")]
    pub sha256: [u8; 32],
    pub face_index: u32,
    pub profile: PortableFontProfile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PortableFontProfile {
    #[serde(rename = "sfnt-unhinted-v1")]
    SfntUnhintedV1,
}

#[derive(Clone)]
pub struct PortableFontData {
    bytes: Arc<[u8]>,
    identity: PortableFontIdentity,
}

impl std::fmt::Debug for PortableFontData {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PortableFontData")
            .field("bytes", &self.bytes.len())
            .field("identity", &self.identity)
            .finish()
    }
}

impl PortableFontData {
    pub fn new(bytes: Arc<[u8]>, expected_sha256: &str) -> Result<Self, RenderError> {
        if bytes.is_empty() || bytes.len() > MAX_PORTABLE_FONT_BYTES || bytes.starts_with(b"ttcf") {
            return Err(RenderError::InvalidFont(
                "bounded single SFNT face required".into(),
            ));
        }
        let digest: [u8; 32] = Sha256::digest(&bytes).into();
        if hex_digest::encode(&digest) != expected_sha256 {
            return Err(RenderError::InvalidFont(
                "font SHA-256 differs from the accepted face".into(),
            ));
        }
        let face = ttf_parser::Face::parse(&bytes, 0)
            .map_err(|_| RenderError::InvalidFont("SFNT face did not decode".into()))?;
        if face.units_per_em() == 0 || face.glyph_index(' ').is_none() {
            return Err(RenderError::InvalidFont(
                "SFNT metrics/space glyph unavailable".into(),
            ));
        }
        Ok(Self {
            bytes,
            identity: PortableFontIdentity {
                sha256: digest,
                face_index: 0,
                profile: PortableFontProfile::SfntUnhintedV1,
            },
        })
    }

    pub fn identity(&self) -> PortableFontIdentity {
        self.identity
    }

    pub(crate) fn measurer(&self) -> Result<PortableTextMeasurer<'_>, RenderError> {
        Ok(PortableTextMeasurer {
            face: ttf_parser::Face::parse(&self.bytes, 0).map_err(|_| {
                RenderError::InvalidFont("retained SFNT face did not decode".into())
            })?,
            identity: self.identity,
        })
    }
}

pub(crate) struct PortableTextMeasurer<'a> {
    face: ttf_parser::Face<'a>,
    identity: PortableFontIdentity,
}

fn invisible(character: char) -> bool {
    matches!(character, '\r' | '\n' | '\t' | '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{2060}' | '\u{feff}' | '\u{fe00}'..='\u{fe0f}' | '\u{e0100}'..='\u{e01ef}')
}

impl PortableTextMeasurer<'_> {
    /// Missing glyphs must fail before any node is laid out. They must not
    /// become synthetic advances that disagree with the external painter.
    pub(crate) fn validate_tree(&self, root: &RenderNode) -> Result<(), RenderError> {
        let mut stack = vec![(root, 0_usize, true)];
        let (mut nodes, mut characters) = (0_usize, 0_usize);
        while let Some((node, depth, parent_displayed)) = stack.pop() {
            let displayed = parent_displayed
                && !matches!(node.style.unwrap_or_default().display, DisplayMode::None);
            nodes += 1;
            if nodes > MAX_PAINT_NODES || depth > MAX_PAINT_DEPTH {
                return Err(RenderError::PaintBudgetExceeded);
            }
            if let Some(text) = &node.text {
                for character in text.chars() {
                    characters += 1;
                    if characters > MAX_FRAME_TEXT_CHARACTERS {
                        return Err(RenderError::TextBudgetExceeded);
                    }
                    if displayed
                        && !invisible(character)
                        && self.face.glyph_index(character).is_none_or(|glyph| {
                            glyph.0 == 0 || self.face.glyph_hor_advance(glyph).is_none()
                        })
                    {
                        return Err(RenderError::InvalidFont(format!(
                            "accepted face does not cover U+{:04X}",
                            character as u32
                        )));
                    }
                }
            }
            stack.extend(
                node.children
                    .iter()
                    .map(|child| (child, depth + 1, displayed)),
            );
        }
        Ok(())
    }
}

impl TextMeasurer for PortableTextMeasurer<'_> {
    fn glyph(&mut self, character: char, size: f32) -> GlyphMetrics {
        let scale = size / f32::from(self.face.units_per_em());
        let advance = if invisible(character) {
            0.0
        } else {
            self.face
                .glyph_index(character)
                .and_then(|glyph| self.face.glyph_hor_advance(glyph))
                .map_or(0.0, f32::from)
                * scale
        };
        GlyphMetrics {
            advance,
            ascent: f32::from(self.face.ascender()).max(0.0) * scale,
            descent: (-f32::from(self.face.descender())).max(0.0) * scale,
            leading: f32::from(self.face.line_gap()).max(0.0) * scale,
        }
    }
    fn measurement(&self) -> TextMeasurement {
        TextMeasurement::Font(self.identity)
    }
}

mod hex_digest {
    use serde::{Deserialize, Deserializer, Serializer};
    pub(super) fn encode(value: &[u8; 32]) -> String {
        value.iter().map(|byte| format!("{byte:02x}")).collect()
    }
    pub(super) fn serialize<S: Serializer>(
        value: &[u8; 32],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&encode(value))
    }
    pub(super) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<[u8; 32], D::Error> {
        let value = String::deserialize(deserializer)?;
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(serde::de::Error::custom("canonical font SHA-256 required"));
        }
        let mut result = [0; 32];
        for (index, byte) in result.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
                .map_err(serde::de::Error::custom)?;
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_font_ingress_rejects_unbounded_or_unverified_data() {
        for bytes in [
            Vec::new(),
            b"ttcf".to_vec(),
            vec![0; MAX_PORTABLE_FONT_BYTES + 1],
        ] {
            assert!(PortableFontData::new(bytes.into(), &"0".repeat(64)).is_err());
        }
        assert!(PortableFontData::new(Arc::from(&b"invalid"[..]), &"0".repeat(64)).is_err());
        let invalid: Arc<[u8]> = Arc::from(&b"invalid"[..]);
        let digest = hex_digest::encode(&Sha256::digest(&invalid).into());
        assert!(
            PortableFontData::new(invalid, &digest).is_err(),
            "verified bytes still require a decoded face"
        );
    }

    #[test]
    fn font_measurement_identity_uses_canonical_strict_wire_shape() {
        let identity = PortableFontIdentity {
            sha256: [0xab; 32],
            face_index: 0,
            profile: PortableFontProfile::SfntUnhintedV1,
        };
        let json = serde_json::to_value(TextMeasurement::Font(identity)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"font":{"sha256":"ab".repeat(32),"face_index":0,"profile":"sfnt-unhinted-v1"}})
        );
        assert_eq!(
            serde_json::from_value::<TextMeasurement>(json.clone()).unwrap(),
            TextMeasurement::Font(identity)
        );
        for mutate in ["uppercase", "extra", "profile"] {
            let mut invalid = json.clone();
            match mutate {
                "uppercase" => invalid["font"]["sha256"] = "AB".repeat(32).into(),
                "extra" => invalid["font"]["extra"] = true.into(),
                _ => invalid["font"]["profile"] = "other".into(),
            }
            assert!(serde_json::from_value::<TextMeasurement>(invalid).is_err());
        }
    }
}
