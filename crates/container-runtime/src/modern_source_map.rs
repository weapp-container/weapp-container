//! Source-map diagnostics are derived from verified pack bytes. Mapping never
//! executes JavaScript and retains the generated frame for audit/debugging.
use container_ir::ContainerManifestV1;
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Default)]
pub(crate) struct ModernSourceMaps(BTreeMap<String, SourceMap>);

#[derive(Debug)]
struct SourceMap {
    sources: Vec<String>,
    lines: Vec<Vec<Segment>>,
}

#[derive(Debug)]
struct Segment {
    generated_column: usize,
    original: Option<(usize, usize, usize)>,
}

#[derive(Deserialize)]
struct WireMap {
    version: u32,
    sources: Vec<String>,
    names: Vec<String>,
    mappings: String,
}

impl ModernSourceMaps {
    pub(crate) fn load(
        manifest: &ContainerManifestV1,
        blobs: &BTreeMap<String, Vec<u8>>,
    ) -> Result<Self, String> {
        let mut maps = BTreeMap::new();
        if let Some(modern) = &manifest.modern_view {
            for unit in &modern.units {
                let bytes =
                    crate::lookup_render_blob(blobs, &format!("sha256:{}", unit.source_map_sha256))
                        .map_err(|error| error.to_string())?;
                if container_ir::hex_digest(bytes) != unit.source_map_sha256 {
                    return Err("modern View source map SHA-256 mismatch".into());
                }
                let wire: WireMap = serde_json::from_slice(bytes)
                    .map_err(|error| format!("invalid modern View source map: {error}"))?;
                if wire.version != 3
                    || wire.sources.iter().any(|source| {
                        !unit.sources.iter().any(|entry| entry.path == *source)
                            && !source.strip_prefix("virtual:").is_some_and(|id| {
                                id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
                            })
                    })
                {
                    return Err("unsupported modern View source map version/source".into());
                }
                let map = SourceMap::parse(wire)?;
                maps.insert(format!("weapp-view:///{}.js", unit.id), map);
            }
        }
        Ok(Self(maps))
    }

    pub(crate) fn map_stack(&self, stack: &str, function_line_offset: usize) -> String {
        let mut mapped = stack.to_owned();
        for (url, map) in &self.0 {
            let needle = format!("{url}:");
            let mut cursor = 0;
            while let Some(relative) = mapped[cursor..].find(&needle) {
                let start = cursor + relative;
                let position = start + needle.len();
                let (line, after_line) = read_number(&mapped, position);
                let (column, end) = if mapped.as_bytes().get(after_line) == Some(&b':') {
                    read_number(&mapped, after_line + 1)
                } else {
                    (None, after_line)
                };
                cursor = end.max(position);
                let Some(line) = line.and_then(|line| line.checked_sub(function_line_offset))
                else {
                    continue;
                };
                let Some((source, line, column)) = map.lookup(line, column) else {
                    continue;
                };
                let generated = &mapped[start..end];
                let replacement = format!("{source}:{line}:{column} [generated {generated}]");
                mapped.replace_range(start..end, &replacement);
                cursor = start + replacement.len();
            }
        }
        mapped
    }
}

fn read_number(value: &str, start: usize) -> (Option<usize>, usize) {
    let mut end = start;
    while value.as_bytes().get(end).is_some_and(u8::is_ascii_digit) {
        end += 1;
    }
    (value[start..end].parse().ok(), end)
}

impl SourceMap {
    fn parse(wire: WireMap) -> Result<Self, String> {
        let mut source = 0_i64;
        let mut original_line = 0_i64;
        let mut original_column = 0_i64;
        let mut name = 0_i64;
        let mut lines = Vec::new();
        for line in wire.mappings.split(';') {
            let mut generated_column = 0_i64;
            let mut segments = Vec::new();
            for segment in line.split(',').filter(|segment| !segment.is_empty()) {
                let fields = decode_vlq(segment)?;
                if !matches!(fields.len(), 1 | 4 | 5) {
                    return Err("invalid source map segment arity".into());
                }
                let previous = generated_column;
                generated_column = generated_column
                    .checked_add(fields[0])
                    .ok_or("source map overflow")?;
                if generated_column < previous {
                    return Err("unordered source map columns".into());
                }
                let original = if fields.len() >= 4 {
                    source = source.checked_add(fields[1]).ok_or("source map overflow")?;
                    original_line = original_line
                        .checked_add(fields[2])
                        .ok_or("source map overflow")?;
                    original_column = original_column
                        .checked_add(fields[3])
                        .ok_or("source map overflow")?;
                    if source < 0
                        || source as usize >= wire.sources.len()
                        || original_line < 0
                        || original_column < 0
                    {
                        return Err("source map source/position is outside its table".into());
                    }
                    if fields.len() == 5 {
                        name = name.checked_add(fields[4]).ok_or("source map overflow")?;
                        if name < 0 || name as usize >= wire.names.len() {
                            return Err("source map name is outside its table".into());
                        }
                    }
                    Some((
                        source as usize,
                        original_line as usize,
                        original_column as usize,
                    ))
                } else {
                    None
                };
                segments.push(Segment {
                    generated_column: generated_column as usize,
                    original,
                });
            }
            lines.push(segments);
        }
        Ok(Self {
            sources: wire.sources,
            lines,
        })
    }

    fn lookup(&self, line: usize, column: Option<usize>) -> Option<(&str, usize, usize)> {
        let segments = self.lines.get(line.checked_sub(1)?)?;
        let segment = if let Some(column) = column {
            segments
                .iter()
                .rev()
                .find(|segment| segment.generated_column <= column.saturating_sub(1))?
        } else {
            // QuickJS may provide only a line. Report its first mapped token,
            // retaining the generated frame instead of inventing a column.
            segments.iter().find(|segment| segment.original.is_some())?
        };
        let (source, line, column) = segment.original?;
        Some((self.sources.get(source)?.as_str(), line + 1, column + 1))
    }
}

fn decode_vlq(segment: &str) -> Result<Vec<i64>, String> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut fields = Vec::new();
    let mut value = 0_u64;
    let mut shift = 0_u32;
    for byte in segment.bytes() {
        let digit = ALPHABET
            .iter()
            .position(|candidate| *candidate == byte)
            .ok_or("invalid source map base64")? as u64;
        if shift > 55 {
            return Err("source map VLQ overflow".into());
        }
        value |= (digit & 31) << shift;
        if digit & 32 == 0 {
            let magnitude = (value >> 1) as i64;
            fields.push(if value & 1 == 0 {
                magnitude
            } else {
                -magnitude
            });
            shift = 0;
            value = 0;
        } else {
            shift += 5;
        }
    }
    if shift != 0 {
        return Err("unterminated source map VLQ".into());
    }
    Ok(fields)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_positions_preserve_generated_frames_and_unmapped_segments() {
        let map = SourceMap::parse(WireMap {
            version: 3,
            sources: vec!["view/main.view.ts".into()],
            names: vec![],
            mappings: "AAAA,KACE;A".into(),
        })
        .unwrap();
        let maps = ModernSourceMaps(BTreeMap::from([(
            "weapp-view:///modern:test.js".into(),
            map,
        )]));
        let stack="at read (weapp-view:///modern:test.js:4:7)\nat unmapped (weapp-view:///modern:test.js:5:1)";
        assert_eq!(maps.map_stack(stack,3),"at read (view/main.view.ts:2:3 [generated weapp-view:///modern:test.js:4:7])\nat unmapped (weapp-view:///modern:test.js:5:1)");
        assert!(maps
            .map_stack("at read (weapp-view:///modern:test.js:4)", 3)
            .contains("view/main.view.ts:1:1"));
    }
    #[test]
    fn malformed_mappings_fail_without_panics_or_wrapping_positions() {
        for mappings in [
            "?",
            "g",
            "AAAAAA",
            "ADAA",
            "DAAA",
            "AAAA,C",
            "ggggggggggggggA",
        ] {
            let result = SourceMap::parse(WireMap {
                version: 3,
                sources: vec!["x".into()],
                names: vec![],
                mappings: mappings.into(),
            });
            if mappings == "AAAA,C" {
                assert!(result.is_ok());
            } else {
                assert!(result.is_err(), "{mappings}");
            }
        }
    }
}
