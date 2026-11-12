//! Numeric projection for the Node startup JSON boundary.
//!
//! Node parses every JSON number as IEEE754 binary64, then JSON.stringify
//! removes negative zero and may change a number's decimal spelling. Comparing
//! serde_json's integer/float representations directly does not model that
//! boundary. In particular, integers above 2^53 can already have rounded before
//! the generated startup JSON is written.
//!
//! Always project ORIGINAL bytes with semantic_value_from_json. Merely casting
//! numbers from an already parsed Value cannot recover the original decimal
//! lexeme, and serde_json's optional float-roundtrip parser is not required by
//! the workspace. This projection parses each original numeric token with
//! Rust's correctly rounded binary64 parser. A JSON visitor then fills those
//! numbers into a zero-number skeleton in source order. Strings are never
//! rewritten, and the JSON parser still validates the complete structure.
//!
//! This is a comparison/typed-decoding projection, NEVER a hash input. Keep the
//! original startup intent, generated JSON, and generated module byte buffers
//! and their three distinct pins. No API here serializes or hashes this Value.
//! This visitor itself rejects duplicate decoded keys at every object depth;
//! startup does not need a preceding StrictJson numeric parse. The caller must
//! enforce its raw-byte limit BEFORE projection and its node/depth budgets on
//! the returned tree BEFORE typed decoding. Those outer checks remain required;
//! this module does not claim a pre-decode allocation/RSS bound. Other metadata
//! can retain its separate StrictJson path without using this numeric projection.

use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::Deserializer;
use serde_json::{Map, Number, Value};
use std::fmt;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Debug)]
pub(crate) enum NumberSemanticsError {
    Json(serde_json::Error),
    Number(&'static str),
}

impl fmt::Display for NumberSemanticsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(error) => write!(formatter, "invalid numeric JSON projection: {error}"),
            Self::Number(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for NumberSemanticsError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Json(error) => Some(error),
            Self::Number(_) => None,
        }
    }
}

impl From<serde_json::Error> for NumberSemanticsError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

/// Decode original JSON into a finite binary64 comparison projection.
///
/// Every projected Number is created from f64, including integral numbers.
/// Thus projected Values can be compared directly with ==, or passed directly
/// to serde_json::from_value for typed startup decoding. Do not serialize the
/// projection and feed it back through a decimal JSON parser; that would both
/// discard the original-byte domain and introduce an unnecessary second float
/// parsing boundary. Object key order is not part of this structural comparison.
pub(super) fn semantic_value_from_json(bytes: &[u8]) -> Result<Value, NumberSemanticsError> {
    let (skeleton, numbers) = numeric_skeleton(bytes)?;
    let mut numbers = numbers.into_iter();
    let mut deserializer = serde_json::Deserializer::from_slice(&skeleton);
    let value = SemanticSeed {
        numbers: &mut numbers,
    }
    .deserialize(&mut deserializer)?;
    deserializer.end()?;
    if numbers.next().is_some() {
        return Err(NumberSemanticsError::Number(
            "numeric JSON projection left unused source numbers",
        ));
    }
    Ok(value)
}

/// Structural comparison across Node's finite JSON parse/stringify boundary.
/// Raw bytes may differ even when this returns true; their pins remain distinct.
#[cfg(test)]
pub(super) fn equivalent_json(left: &[u8], right: &[u8]) -> Result<bool, NumberSemanticsError> {
    Ok(semantic_value_from_json(left)? == semantic_value_from_json(right)?)
}

fn finite_number(value: f64) -> Result<f64, NumberSemanticsError> {
    if !value.is_finite() {
        return Err(NumberSemanticsError::Number(
            "startup JSON requires finite IEEE754 numbers",
        ));
    }
    // JSON.stringify(-0) is "0", including negative underflow to zero.
    Ok(if value == 0.0 { 0.0 } else { value })
}

fn numeric_skeleton(bytes: &[u8]) -> Result<(Vec<u8>, Vec<f64>), NumberSemanticsError> {
    let mut skeleton = Vec::with_capacity(bytes.len());
    let mut numbers = Vec::new();
    let mut cursor = 0;
    let mut in_string = false;
    while cursor < bytes.len() {
        let byte = bytes[cursor];
        if in_string {
            skeleton.push(byte);
            cursor += 1;
            if byte == b'\\' {
                // Copy one escaped byte without interpreting it. The complete
                // JSON parser below validates escapes, UTF-8 and string ends.
                if cursor < bytes.len() {
                    skeleton.push(bytes[cursor]);
                    cursor += 1;
                }
            } else if byte == b'"' {
                in_string = false;
            }
        } else if byte == b'"' {
            in_string = true;
            skeleton.push(byte);
            cursor += 1;
        } else if byte == b'-' || byte.is_ascii_digit() {
            let start = cursor;
            while cursor < bytes.len() && !json_boundary(bytes[cursor]) {
                cursor += 1;
            }
            let token = &bytes[start..cursor];
            if !json_number_token(token) {
                return Err(NumberSemanticsError::Number(
                    "invalid original JSON number token",
                ));
            }
            let token = std::str::from_utf8(token)
                .map_err(|_| NumberSemanticsError::Number("non-ASCII JSON number token"))?;
            let number = token.parse::<f64>().map_err(|_| {
                NumberSemanticsError::Number("invalid original IEEE754 number token")
            })?;
            numbers.push(finite_number(number)?);
            skeleton.push(b'0');
        } else {
            skeleton.push(byte);
            cursor += 1;
        }
    }
    Ok((skeleton, numbers))
}

fn json_boundary(byte: u8) -> bool {
    matches!(
        byte,
        b' ' | b'\t' | b'\r' | b'\n' | b',' | b'[' | b']' | b'{' | b'}' | b':' | b'"'
    )
}

/// Validate JSON's grammar before using str::parse, which also accepts some
/// spellings (for example a leading plus) that are not JSON number tokens.
fn json_number_token(token: &[u8]) -> bool {
    let mut cursor = usize::from(token.first() == Some(&b'-'));
    match token.get(cursor) {
        Some(b'0') => cursor += 1,
        Some(b'1'..=b'9') => {
            cursor += 1;
            while token.get(cursor).is_some_and(u8::is_ascii_digit) {
                cursor += 1;
            }
        }
        _ => return false,
    }
    if token.get(cursor) == Some(&b'.') {
        cursor += 1;
        let start = cursor;
        while token.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        if cursor == start {
            return false;
        }
    }
    if matches!(token.get(cursor), Some(b'e' | b'E')) {
        cursor += 1;
        if matches!(token.get(cursor), Some(b'+' | b'-')) {
            cursor += 1;
        }
        let start = cursor;
        while token.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        if cursor == start {
            return false;
        }
    }
    cursor == token.len()
}

struct SemanticSeed<'a> {
    numbers: &'a mut std::vec::IntoIter<f64>,
}

impl SemanticSeed<'_> {
    fn placeholder<E: de::Error>(self, value: f64) -> Result<Value, E> {
        if value != 0.0 || !value.is_finite() {
            return Err(E::custom(
                "numeric projection encountered a nonzero placeholder",
            ));
        }
        let value = self
            .numbers
            .next()
            .ok_or_else(|| E::custom("numeric projection exhausted source numbers"))?;
        let number = Number::from_f64(value)
            .ok_or_else(|| E::custom("numeric projection encountered a non-finite number"))?;
        Ok(Value::Number(number))
    }
}

impl<'de> DeserializeSeed<'de> for SemanticSeed<'_> {
    type Value = Value;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for SemanticSeed<'_> {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("JSON with zero-number placeholders and unique object keys")
    }

    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_none<E: de::Error>(self) -> Result<Value, E> {
        self.visit_unit()
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Value, E> {
        Ok(Value::String(value.to_owned()))
    }

    fn visit_string<E: de::Error>(self, value: String) -> Result<Value, E> {
        Ok(Value::String(value))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Value, E> {
        self.placeholder(value as f64)
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Value, E> {
        self.placeholder(value as f64)
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Value, E> {
        self.placeholder(value)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut access: A) -> Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = access.next_element_seed(SemanticSeed {
            numbers: &mut *self.numbers,
        })? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Value, A::Error> {
        let mut values = Map::new();
        while let Some(key) = access.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(de::Error::custom("duplicate JSON object key"));
            }
            let value = access.next_value_seed(SemanticSeed {
                numbers: &mut *self.numbers,
            })?;
            values.insert(key, value);
        }
        Ok(Value::Object(values))
    }
}

fn safe_unsigned(value: f64) -> Result<u64, &'static str> {
    if !value.is_finite() || value < 0.0 || value > MAX_SAFE_INTEGER || value.fract() != 0.0 {
        return Err("expected a finite nonnegative Number.isSafeInteger value");
    }
    // This cast is exact after the finite, safe, unsigned integer checks.
    Ok(value as u64)
}

/// Model a nonnegative Number.isSafeInteger field, accepting 375.0 and 3.75e2.
/// For original decimal-token accuracy, feed the containing DTO with
/// serde_json::from_value(semantic_value_from_json(original_bytes)?).
/// Schema equality, positivity and viewport limits remain caller policy.
pub(super) fn deserialize_safe_u64<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<u64, D::Error> {
    struct SafeIntegerVisitor;

    impl<'de> Visitor<'de> for SafeIntegerVisitor {
        type Value = u64;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a finite nonnegative safe integer JSON number")
        }

        fn visit_u64<E: de::Error>(self, value: u64) -> Result<u64, E> {
            safe_unsigned(value as f64).map_err(E::custom)
        }

        fn visit_i64<E: de::Error>(self, value: i64) -> Result<u64, E> {
            safe_unsigned(value as f64).map_err(E::custom)
        }

        fn visit_f64<E: de::Error>(self, value: f64) -> Result<u64, E> {
            safe_unsigned(value).map_err(E::custom)
        }
    }

    deserializer.deserialize_any(SafeIntegerVisitor)
}

/// The same safe-integer boundary, followed by checked u32 conversion.
pub(super) fn deserialize_safe_u32<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<u32, D::Error> {
    let value = deserialize_safe_u64(deserializer)?;
    u32::try_from(value).map_err(|_| de::Error::custom("safe integer exceeds u32 range"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use sha2::{Digest, Sha256};

    #[derive(Debug, Deserialize)]
    struct Unsigned32 {
        #[serde(deserialize_with = "deserialize_safe_u32")]
        value: u32,
    }

    #[derive(Debug, Deserialize)]
    struct Unsigned64 {
        #[serde(deserialize_with = "deserialize_safe_u64")]
        value: u64,
    }

    fn u32_field(json: &str) -> Option<u32> {
        let value = semantic_value_from_json(json.as_bytes()).ok()?;
        serde_json::from_value::<Unsigned32>(value)
            .ok()
            .map(|field| field.value)
    }

    fn u64_field(json: &str) -> Option<u64> {
        let value = semantic_value_from_json(json.as_bytes()).ok()?;
        serde_json::from_value::<Unsigned64>(value)
            .ok()
            .map(|field| field.value)
    }

    #[test]
    fn integer_decimal_and_exponent_spellings_compare_equally() {
        for json in [b"1".as_slice(), b"1.0", b"1e0", b"0.1e1"] {
            assert!(equivalent_json(json, b"1").unwrap());
            let projected = semantic_value_from_json(json).unwrap();
            assert!(projected.as_number().unwrap().is_f64());
        }
    }

    #[test]
    fn negative_zero_and_underflow_match_stringified_zero() {
        for json in [b"-0".as_slice(), b"-0.0", b"-1e-400", b"1e-400"] {
            let value = semantic_value_from_json(json).unwrap();
            assert_eq!(value.as_f64().unwrap().to_bits(), 0.0_f64.to_bits());
            assert!(equivalent_json(json, b"0").unwrap());
        }
    }

    #[test]
    fn original_large_integer_tokens_round_like_binary64() {
        assert!(equivalent_json(b"9007199254740993", b"9007199254740992").unwrap());
        assert!(equivalent_json(b"-9007199254740993", b"-9007199254740992").unwrap());
        assert!(equivalent_json(b"18446744073709551615", b"18446744073709552000").unwrap());
        assert!(!equivalent_json(b"9007199254740991", b"9007199254740992").unwrap());
    }

    #[test]
    fn decimal_halfway_rounding_uses_the_original_token() {
        let midpoint = b"1.00000000000000011102230246251565404236316680908203125";
        let above = b"1.00000000000000011102230246251565404236316680908203126";
        assert!(equivalent_json(midpoint, b"1").unwrap());
        assert!(equivalent_json(above, b"1.0000000000000002").unwrap());
        assert!(!equivalent_json(above, b"1").unwrap());
    }

    #[test]
    fn nested_numbers_follow_source_order_before_object_maps_are_sorted() {
        let left = br#"{"z":1.0,"a":[2e0,{"n":9007199254740993}],"s":"3e4"}"#;
        let right = br#"{"s":"3e4","a":[2,{"n":9007199254740992}],"z":1}"#;
        assert!(equivalent_json(left, right).unwrap());
        assert!(
            !equivalent_json(left, br#"{"z":2,"a":[1,{"n":9007199254740992}],"s":"3e4"}"#).unwrap()
        );
    }

    #[test]
    fn strings_escapes_and_proto_keys_remain_plain_json_data() {
        let json = br#"{"__proto__":{"n":1.0},"s":"12 \\\" -3e4 \\u0031","quoted\"9":2}"#;
        let projected = semantic_value_from_json(json).unwrap();
        let ordinary: Value = serde_json::from_slice(json).unwrap();
        assert_eq!(projected["s"], ordinary["s"]);
        assert_eq!(projected["quoted\"9"].as_f64(), Some(2.0));
        assert_eq!(projected["__proto__"]["n"].as_f64(), Some(1.0));
    }

    #[test]
    fn arrays_and_meaningful_value_differences_are_preserved() {
        assert!(!equivalent_json(b"[1,2]", b"[2,1]").unwrap());
        assert!(!equivalent_json(b"1", br#""1""#).unwrap());
        assert!(!equivalent_json(br#"{"a":null}"#, b"{}").unwrap());
        assert!(!equivalent_json(b"true", b"false").unwrap());
        assert!(equivalent_json(b"[null,true,\"x\"]", b"[null,true,\"x\"]").unwrap());
    }

    #[test]
    fn arbitrary_data_accepts_finite_numbers_above_the_safe_integer_range() {
        let value = semantic_value_from_json(br#"{"large":1e100,"small":5e-324}"#).unwrap();
        assert_eq!(value["large"].as_f64(), Some(1e100));
        assert_eq!(value["small"].as_f64(), Some(f64::from_bits(1)));
    }

    #[test]
    fn nonfinite_numbers_are_rejected_instead_of_becoming_null() {
        for json in [
            b"1e309".as_slice(),
            b"-1e309",
            b"[1e9999]",
            b"NaN",
            b"Infinity",
        ] {
            assert!(semantic_value_from_json(json).is_err());
        }
        for number in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(finite_number(number).is_err());
            assert!(safe_unsigned(number).is_err());
        }
    }

    #[test]
    fn invalid_number_grammar_and_incomplete_json_are_rejected() {
        for json in [
            "01",
            "-01",
            "+1",
            ".1",
            "1.",
            "1e",
            "1e+",
            "1.0.1",
            "1e2true",
            "--1",
            "[1 2]",
            "[1,]",
            "{\"n\":1}x",
            "\"unterminated",
            "",
            "1\u{00a0}",
        ] {
            assert!(semantic_value_from_json(json.as_bytes()).is_err(), "{json}");
        }
    }

    #[test]
    fn duplicate_keys_are_not_erased_by_the_projection() {
        for json in [
            br#"{"a":1,"a":2}"#.as_slice(),
            br#"{"nested":{"a":1,"\u0061":2}}"#,
        ] {
            assert!(semantic_value_from_json(json).is_err());
        }
    }

    #[test]
    fn integer_fields_accept_integral_float_and_exponent_spellings() {
        for json in [
            r#"{"value":375}"#,
            r#"{"value":375.0}"#,
            r#"{"value":3.75e2}"#,
            r#"{"value":375.0000000000000000001}"#,
        ] {
            assert_eq!(u32_field(json), Some(375));
            assert_eq!(u64_field(json), Some(375));
        }
        assert_eq!(u32_field(r#"{"value":-0.0}"#), Some(0));
        assert_eq!(u32_field(r#"{"value":0.99999999999999999999}"#), Some(1));
        assert_eq!(u32_field(r#"{"value":1e-400}"#), Some(0));
    }

    #[test]
    fn integer_fields_reject_fractional_negative_unsafe_and_wrong_types() {
        for json in [
            r#"{"value":375.5}"#,
            r#"{"value":-1}"#,
            r#"{"value":9007199254740992}"#,
            r#"{"value":9007199254740993}"#,
            r#"{"value":1e309}"#,
            r#"{"value":"375"}"#,
            r#"{"value":true}"#,
            r#"{"value":null}"#,
            r#"{"value":[]}"#,
            r#"{"value":{}}"#,
        ] {
            assert_eq!(u32_field(json), None, "{json}");
            assert_eq!(u64_field(json), None, "{json}");
        }
    }

    #[test]
    fn integer_destination_and_safe_integer_limits_are_checked_separately() {
        assert_eq!(u32_field(r#"{"value":4294967295.0}"#), Some(u32::MAX));
        assert_eq!(u32_field(r#"{"value":4294967296}"#), None);
        assert_eq!(
            u64_field(r#"{"value":9007199254740991}"#),
            Some(9_007_199_254_740_991)
        );
        assert_eq!(
            u64_field(r#"{"value":9007199254740991.4}"#),
            Some(9_007_199_254_740_991)
        );
        assert_eq!(u64_field(r#"{"value":9007199254740991.5}"#), None);
        assert_eq!(u64_field(r#"{"value":18446744073709551615}"#), None);
    }

    #[test]
    fn semantic_equality_does_not_merge_original_hash_domains() {
        let intent = br#"{"n":1.0,"z":-0,"large":9007199254740993}"#;
        let generated = b"{\n  \"n\": 1,\n  \"z\": 0,\n  \"large\": 9007199254740992\n}\n";
        assert!(equivalent_json(intent, generated).unwrap());
        assert_ne!(Sha256::digest(intent), Sha256::digest(generated));
        // The real module pin is a third independent ORIGINAL byte domain.
        let module = b"export const config = JSON.parse(\"{\\\"n\\\":1}\")\n";
        assert_ne!(Sha256::digest(generated), Sha256::digest(module));
    }
}
