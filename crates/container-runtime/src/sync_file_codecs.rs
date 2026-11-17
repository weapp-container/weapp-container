//! File text is transported as UTF-16 code units, independently of JSON's
//! Unicode-scalar strings. Only the synchronous filesystem facade creates or
//! consumes this private wire value; the asynchronous managed-file producer
//! emits the same projection and the guest bridge decodes it at the delivery
//! boundary. Genuine ArrayBuffer data retains its byte transport. UTF-8
//! replacement follows the encoding contract, never transport.
use super::{Value, CHUNK};
use serde_json::json;

#[derive(Clone, Copy)]
enum Encoding {
    Utf8,
    Utf16,
    Ascii,
    Latin1,
    Base64,
    Hex,
}
impl Encoding {
    fn read(payload: &Value, default: Option<Self>) -> Result<Option<Self>, String> {
        let Some(value) = payload.get("encoding").filter(|value| !value.is_null()) else {
            return Ok(default);
        };
        let value = value.as_str().ok_or("file encoding must be a string")?;
        Ok(Some(match value {
            "utf8" | "utf-8" => Self::Utf8,
            "ucs2" | "ucs-2" | "utf16le" | "utf-16le" => Self::Utf16,
            "ascii" => Self::Ascii,
            "binary" | "latin1" => Self::Latin1,
            "base64" => Self::Base64,
            "hex" => Self::Hex,
            _ => return Err("unsupported file encoding".into()),
        }))
    }
}
fn units(data: &Value) -> Result<Vec<u16>, String> {
    // Keep direct native callers of the old UTF-8 JSON-string input working.
    // The public JS facade always projects before serialization, so no lone
    // surrogate is repaired or rejected by the JSON parser on that path.
    if let Some(text) = data.as_str() {
        if text.encode_utf16().count() > CHUNK * 2 {
            return Err("file text code-unit budget exceeded".into());
        }
        return Ok(text.encode_utf16().collect());
    }
    let outer = data
        .as_object()
        .ok_or("file text projection must be an object")?;
    let marker = outer
        .get("__weappSyncText")
        .and_then(Value::as_object)
        .ok_or("invalid file text projection")?;
    let units = marker
        .get("units")
        .and_then(Value::as_array)
        .filter(|units| units.len() <= CHUNK * 2)
        .ok_or("invalid file text code-unit budget")?;
    if outer.len() != 1
        || marker.len() != 2
        || marker.get("type").and_then(Value::as_str) != Some("UTF16")
    {
        return Err("invalid file text projection shape".into());
    }
    units
        .iter()
        .map(|unit| {
            unit.as_u64()
                .filter(|unit| *unit <= 0xffff)
                .map(|unit| unit as u16)
                .ok_or_else(|| "invalid file UTF-16 code unit".into())
        })
        .collect()
}
fn hex(unit: u16) -> Option<u8> {
    let unit = unit & 0xff;
    match unit {
        0x30..=0x39 => Some((unit - 0x30) as u8),
        0x41..=0x46 => Some((unit - 0x41 + 10) as u8),
        0x61..=0x66 => Some((unit - 0x61 + 10) as u8),
        _ => None,
    }
}
fn base64(unit: u16) -> Option<u32> {
    let unit = unit & 0xff;
    match unit {
        0x41..=0x5a => Some(u32::from(unit - 0x41)),
        0x61..=0x7a => Some(u32::from(unit - 0x61 + 26)),
        0x30..=0x39 => Some(u32::from(unit - 0x30 + 52)),
        0x2b | 0x2d => Some(62),
        0x2f | 0x5f => Some(63),
        _ => None,
    }
}
/// Returns None for a binary input, whose validation belongs to the byte path.
pub(super) fn encode(payload: &Value) -> Result<Option<Vec<u8>>, String> {
    let data = payload.get("data").ok_or("file data missing")?;
    if data.get("__weappBinary").is_some() {
        return Ok(None);
    }
    let units = units(data)?;
    let encoding = Encoding::read(payload, Some(Encoding::Utf8))?.expect("write default");
    let bytes = match encoding {
        // Node-style file encodings operate on JavaScript UTF-16 strings.
        // A lone surrogate becomes U+FFFD only for UTF-8; UTF-16LE, Latin-1,
        // ASCII, hex and Base64 retain their specified code-unit semantics.
        Encoding::Utf8 => String::from_utf16_lossy(&units).into_bytes(),
        Encoding::Utf16 => units.iter().flat_map(|unit| unit.to_le_bytes()).collect(),
        Encoding::Ascii | Encoding::Latin1 => units.iter().map(|unit| *unit as u8).collect(),
        Encoding::Hex => {
            let mut bytes = Vec::new();
            for pair in units.as_chunks::<2>().0 {
                let (Some(hi), Some(lo)) = (hex(pair[0]), hex(pair[1])) else {
                    break;
                };
                bytes.push(hi * 16 + lo);
            }
            bytes
        }
        Encoding::Base64 => {
            let mut bytes = Vec::new();
            let mut buffer = 0_u32;
            let mut bits = 0;
            for unit in units {
                if unit & 0xff == u16::from(b'=') {
                    break;
                }
                let Some(value) = base64(unit) else {
                    continue;
                };
                buffer = (buffer << 6) | value;
                bits += 6;
                if bits >= 8 {
                    bits -= 8;
                    bytes.push((buffer >> bits) as u8);
                }
            }
            bytes
        }
    };
    if bytes.len() > CHUNK {
        return Err("write exceeds one MiB chunk limit".into());
    }
    Ok(Some(bytes))
}
/// `None` means an ArrayBuffer read; every text result uses the typed
/// code-unit projection so UTF-16LE can round-trip unpaired surrogates.
pub(super) fn decode(payload: &Value, bytes: &[u8]) -> Result<Option<Value>, String> {
    let Some(encoding) = Encoding::read(payload, None)? else {
        return Ok(None);
    };
    let units: Vec<u16> = match encoding {
        Encoding::Utf8 => String::from_utf8_lossy(bytes).encode_utf16().collect(),
        Encoding::Utf16 => bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect(),
        Encoding::Ascii => bytes.iter().map(|byte| u16::from(byte & 0x7f)).collect(),
        Encoding::Latin1 => bytes.iter().map(|byte| u16::from(*byte)).collect(),
        Encoding::Hex => {
            const ALPHABET: &[u8] = b"0123456789abcdef";
            bytes
                .iter()
                .flat_map(|byte| {
                    [
                        u16::from(ALPHABET[usize::from(byte >> 4)]),
                        u16::from(ALPHABET[usize::from(byte & 15)]),
                    ]
                })
                .collect()
        }
        Encoding::Base64 => {
            const ALPHABET: &[u8] =
                b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let mut units = Vec::with_capacity(bytes.len().div_ceil(3) * 4);
            for part in bytes.chunks(3) {
                let n = (u32::from(part[0]) << 16)
                    | (u32::from(*part.get(1).unwrap_or(&0)) << 8)
                    | u32::from(*part.get(2).unwrap_or(&0));
                units.push(u16::from(ALPHABET[(n >> 18) as usize]));
                units.push(u16::from(ALPHABET[((n >> 12) & 63) as usize]));
                units.push(u16::from(if part.len() >= 2 {
                    ALPHABET[((n >> 6) & 63) as usize]
                } else {
                    b'='
                }));
                units.push(u16::from(if part.len() >= 3 {
                    ALPHABET[(n & 63) as usize]
                } else {
                    b'='
                }));
            }
            units
        }
    };
    Ok(Some(
        json!({"__weappSyncText":{"type":"UTF16","units":units}}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(encoding: &str, units: &[u16]) -> Value {
        json!({"encoding":encoding,"data":{"__weappSyncText":{"type":"UTF16","units":units}}})
    }
    #[test]
    fn fixed_aliases_and_unpaired_units_have_distinct_encoding_semantics() {
        let text = [0, 0xe9, 0xd800, 0x61, 0xdc00, 0xd83d, 0xde00];
        for alias in ["ucs2", "ucs-2", "utf16le", "utf-16le"] {
            let bytes = encode(&input(alias, &text)).unwrap().unwrap();
            assert_eq!(
                bytes,
                [0, 0, 0xe9, 0, 0, 0xd8, 0x61, 0, 0, 0xdc, 0x3d, 0xd8, 0, 0xde]
            );
            assert_eq!(
                decode(&json!({"encoding":alias}), &bytes).unwrap().unwrap()["__weappSyncText"]
                    ["units"],
                json!(text)
            );
        }
        for alias in ["binary", "latin1", "ascii"] {
            assert_eq!(
                encode(&input(alias, &text)).unwrap().unwrap(),
                [0, 0xe9, 0, 0x61, 0, 0x3d, 0]
            );
        }
        for alias in ["utf8", "utf-8"] {
            assert_eq!(
                encode(&input(alias, &text)).unwrap().unwrap(),
                "\0é�a�😀".as_bytes()
            );
        }
        assert_eq!(
            decode(&json!({"encoding":"ascii"}), &[0, 0xe9, 0xff])
                .unwrap()
                .unwrap()["__weappSyncText"]["units"],
            json!([0, 0x69, 0x7f])
        );
    }
    #[test]
    fn binary_hex_and_base64_paths_do_not_invent_data() {
        assert!(
            encode(&json!({"data":{"__weappBinary":{"type":"ArrayBuffer","bytes":[255]}}}))
                .unwrap()
                .is_none()
        );
        for (text, expected) in [
            ("4142ff", vec![65, 66, 255]),
            ("41xz42", vec![65]),
            ("abc", vec![0xab]),
        ] {
            assert_eq!(
                encode(&json!({"encoding":"hex","data":text}))
                    .unwrap()
                    .unwrap(),
                expected
            );
        }
        for text in ["AP8q", "A P\n8q", "AP8q=ignored", "AP8q!"] {
            assert_eq!(
                encode(&json!({"encoding":"base64","data":text}))
                    .unwrap()
                    .unwrap(),
                [0, 255, 42]
            );
        }
        assert_eq!(
            encode(&json!({"encoding":"base64","data":"-_8="}))
                .unwrap()
                .unwrap(),
            [251, 255]
        );
        assert_eq!(
            decode(&json!({"encoding":"hex"}), &[0, 255, 42])
                .unwrap()
                .unwrap()["__weappSyncText"]["units"],
            json!([48, 48, 102, 102, 50, 97])
        );
        for bytes in [vec![], vec![0], vec![0, 255], vec![0, 255, 42]] {
            let text = decode(&json!({"encoding":"base64"}), &bytes)
                .unwrap()
                .unwrap();
            assert_eq!(
                encode(&json!({"encoding":"base64","data":text}))
                    .unwrap()
                    .unwrap(),
                bytes
            );
        }
    }
    #[test]
    fn independent_node_buffer_vectors_cover_all_aliases_and_malformed_unicode() {
        let vectors: Value =
            serde_json::from_str(include_str!("sync-file-codec-vectors.json")).unwrap();
        for vector in vectors["encode"].as_array().unwrap() {
            let payload = json!({"encoding":vector["encoding"],"data":{"__weappSyncText":{"type":"UTF16","units":vector["units"]}}});
            assert_eq!(
                json!(encode(&payload).unwrap().unwrap()),
                vector["bytes"],
                "encode {vector}"
            );
        }
        for vector in vectors["decode"].as_array().unwrap() {
            let bytes: Vec<u8> = serde_json::from_value(vector["bytes"].clone()).unwrap();
            let result = decode(&json!({"encoding":vector["encoding"]}), &bytes)
                .unwrap()
                .unwrap();
            assert_eq!(
                result["__weappSyncText"]["units"], vector["units"],
                "decode {vector}"
            );
        }
    }
    #[test]
    fn malformed_projection_encoding_and_budget_are_explicit_errors() {
        for data in [
            json!({"__weappSyncText":{"type":"wrong","units":[]}}),
            json!({"__weappSyncText":{"type":"UTF16","units":[65536]}}),
            json!({"__weappSyncText":{"type":"UTF16","units":[1.5]}}),
            json!({"__weappSyncText":{"type":"UTF16","units":[]},"extra":true}),
        ] {
            assert!(encode(&json!({"data":data})).is_err());
        }
        assert!(encode(&input("unsupported", &[65])).is_err());
        assert!(decode(&json!({"encoding":false}), &[]).is_err());
        assert!(encode(&input("utf16le", &vec![65; CHUNK / 2 + 1])).is_err());
        assert_eq!(
            decode(&json!({"encoding":"utf16le"}), &[0, 0xd8, 1])
                .unwrap()
                .unwrap()["__weappSyncText"]["units"],
            json!([0xd800])
        );
    }
}
