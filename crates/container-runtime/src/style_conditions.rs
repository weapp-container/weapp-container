//! Evaluate media queries against the logical render viewport. This deliberately
//! has no dependency on host window dimensions or a browser CSS implementation.
use super::{BridgeError, BridgeErrorCode};
use container_render_skia::Rect;

const MAX_CONDITION_BYTES: usize = 65_536;
const MAX_NESTING: usize = 64;

fn render_error(message: impl Into<String>) -> BridgeError {
    BridgeError::new(BridgeErrorCode::Render, message)
}

#[derive(Debug)]
enum ConditionError {
    Invalid { _reason: String },
    ResourceLimit(&'static str),
}

fn invalid(message: impl Into<String>) -> ConditionError {
    ConditionError::Invalid {
        _reason: message.into(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Match {
    False,
    True,
    Unknown,
}

impl From<bool> for Match {
    fn from(value: bool) -> Self {
        if value {
            Self::True
        } else {
            Self::False
        }
    }
}

impl std::ops::Not for Match {
    type Output = Self;
    fn not(self) -> Self {
        match self {
            Self::False => Self::True,
            Self::True => Self::False,
            Self::Unknown => Self::Unknown,
        }
    }
}

impl std::ops::BitAndAssign for Match {
    fn bitand_assign(&mut self, other: Self) {
        *self = match (*self, other) {
            (Self::False, _) | (_, Self::False) => Self::False,
            (Self::True, Self::True) => Self::True,
            _ => Self::Unknown,
        };
    }
}

impl std::ops::BitOrAssign for Match {
    fn bitor_assign(&mut self, other: Self) {
        *self = match (*self, other) {
            (Self::True, _) | (_, Self::True) => Self::True,
            (Self::False, Self::False) => Self::False,
            _ => Self::Unknown,
        };
    }
}

/// `prelude` is the query list following `@media`, or the media qualifier of an
/// `@import`. Media types use the container's screen environment. Features use
/// MQ4 three-valued logic: unknown or invalid features stay unknown under `not`
/// and become false only at the query boundary. An invalid query list member
/// does not prevent a different member from matching.
pub(super) fn media_matches(prelude: &str, viewport: Rect) -> Result<bool, BridgeError> {
    if !viewport.width.is_finite()
        || !viewport.height.is_finite()
        || viewport.width < 0.0
        || viewport.height < 0.0
    {
        return Err(render_error(
            "media query viewport dimensions must be finite and non-negative",
        ));
    }
    if prelude.len() > MAX_CONDITION_BYTES {
        return Err(render_error("media query exceeds the condition size limit"));
    }
    let mut matched = Match::False;
    for query in split_queries(prelude) {
        match tokenize(query).and_then(|tokens| query_matches(&tokens, viewport)) {
            Ok(value) => matched |= value,
            Err(ConditionError::Invalid { .. }) => {}
            Err(ConditionError::ResourceLimit(message)) => {
                return Err(render_error(message));
            }
        }
    }
    Ok(matched == Match::True)
}

fn split_queries(source: &str) -> Vec<&str> {
    let bytes = source.as_bytes();
    let mut output = Vec::new();
    let mut start = 0;
    let mut index = 0;
    let mut depth = 0usize;
    while index < bytes.len() {
        if source[index..].starts_with("/*") {
            index = source[index + 2..]
                .find("*/")
                .map_or(bytes.len(), |end| index + end + 4);
            continue;
        }
        match bytes[index] {
            b'\'' | b'"' => {
                let quote = bytes[index];
                index += 1;
                while index < bytes.len() && bytes[index] != quote {
                    if bytes[index] == b'\\' {
                        index += 1;
                    }
                    index += 1;
                }
            }
            b'(' => depth += 1,
            b')' => depth = depth.saturating_sub(1),
            b',' if depth == 0 => {
                output.push(&source[start..index]);
                start = index + 1;
            }
            _ => {}
        }
        // Byte scanning must not slice the source at a non-UTF-8 boundary.
        index += 1;
        while index < bytes.len() && !source.is_char_boundary(index) {
            index += 1;
        }
    }
    output.push(&source[start..]);
    output
}

/// A future declaration evaluator must use the renderer's actual property/value
/// support boundary. Guessing from a property name would incorrectly turn on
/// layout branches (including `not` branches) that the renderer cannot honor.
pub(super) fn supports_matches(_prelude: &str) -> Result<bool, BridgeError> {
    Err(BridgeError::new(
        BridgeErrorCode::UnsupportedCapability,
        "WXSS @supports evaluation is not implemented by the renderer",
    ))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Comparison {
    Less,
    LessEqual,
    Equal,
    GreaterEqual,
    Greater,
}

impl Comparison {
    fn direction(self) -> i8 {
        match self {
            Self::Less | Self::LessEqual => -1,
            Self::Greater | Self::GreaterEqual => 1,
            Self::Equal => 0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Token<'a> {
    Atom(&'a str),
    Quoted,
    Open,
    Close,
    Colon,
    Comma,
    Slash,
    Comparison(Comparison),
}

impl Token<'_> {
    fn is_keyword(self, keyword: &str) -> bool {
        matches!(self, Self::Atom(value) if value.eq_ignore_ascii_case(keyword))
    }
}

fn tokenize(source: &str) -> Result<Vec<Token<'_>>, ConditionError> {
    if source.len() > MAX_CONDITION_BYTES {
        return Err(invalid("media query exceeds the condition size limit"));
    }
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    let mut depth = 0;
    while index < bytes.len() {
        if bytes[index].is_ascii_whitespace() {
            index += 1;
            continue;
        }
        if source[index..].starts_with("/*") {
            let end = source[index + 2..]
                .find("*/")
                .ok_or_else(|| invalid("unterminated media query comment"))?;
            index += end + 4;
            continue;
        }
        let token = match bytes[index] {
            b'(' => {
                depth += 1;
                if depth > MAX_NESTING {
                    return Err(ConditionError::ResourceLimit(
                        "media query exceeds the nesting limit",
                    ));
                }
                Token::Open
            }
            b')' => {
                if depth == 0 {
                    return Err(invalid("unmatched ')' in media query"));
                }
                depth -= 1;
                Token::Close
            }
            b':' => Token::Colon,
            b',' => Token::Comma,
            b'/' => Token::Slash,
            b'=' => Token::Comparison(Comparison::Equal),
            b'<' | b'>' => {
                let greater = bytes[index] == b'>';
                let equal = bytes.get(index + 1) == Some(&b'=');
                if equal {
                    index += 1;
                }
                Token::Comparison(match (greater, equal) {
                    (false, false) => Comparison::Less,
                    (false, true) => Comparison::LessEqual,
                    (true, true) => Comparison::GreaterEqual,
                    (true, false) => Comparison::Greater,
                })
            }
            b'\'' | b'"' => {
                let quote = bytes[index];
                index += 1;
                loop {
                    let byte = *bytes
                        .get(index)
                        .ok_or_else(|| invalid("unterminated media query string"))?;
                    if byte == quote {
                        break;
                    }
                    if byte == b'\\' {
                        index += 1;
                        if index == bytes.len() {
                            return Err(invalid("unterminated media query string escape"));
                        }
                    } else if byte == b'\n' || byte == b'\r' {
                        return Err(invalid("newline in media query string"));
                    }
                    index += 1;
                }
                Token::Quoted
            }
            b';' | b'{' | b'}' | b'[' | b']' | b'\\' => {
                return Err(invalid("unsupported or malformed media query token"));
            }
            _ => {
                let start = index;
                while index < bytes.len()
                    && !bytes[index].is_ascii_whitespace()
                    && !b"():,/<>='\";{}[]\\".contains(&bytes[index])
                {
                    index += 1;
                }
                if index == start {
                    return Err(invalid("malformed media query token"));
                }
                tokens.push(Token::Atom(&source[start..index]));
                continue;
            }
        };
        tokens.push(token);
        index += 1;
    }
    if depth != 0 {
        return Err(invalid("unclosed '(' in media query"));
    }
    Ok(tokens)
}

fn identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_alphabetic()
        || first == '_'
        || (first == '-'
            && chars
                .clone()
                .next()
                .is_some_and(|next| next.is_alphabetic() || matches!(next, '_' | '-'))))
        && chars.all(|character| character.is_alphanumeric() || matches!(character, '_' | '-'))
        && value != "-"
}

fn is_boolean_keyword(token: Token<'_>) -> bool {
    token.is_keyword("not")
        || token.is_keyword("only")
        || token.is_keyword("and")
        || token.is_keyword("or")
        || token.is_keyword("layer")
}

fn query_matches(tokens: &[Token<'_>], viewport: Rect) -> Result<Match, ConditionError> {
    if tokens.is_empty() {
        return Err(invalid("media query list has an empty query"));
    }
    let mut offset = 0;
    let mut negate = false;
    if tokens[0].is_keyword("only") {
        offset = 1;
    } else if tokens[0].is_keyword("not")
        && matches!(tokens.get(1), Some(Token::Atom(value)) if identifier(value) && !is_boolean_keyword(tokens[1]))
    {
        // A query modifier negates the whole media-type query, whereas `not`
        // before a parenthesis is a unary condition operator.
        offset = 1;
        negate = true;
    }
    if let Some(Token::Atom(media_type)) = tokens.get(offset) {
        if identifier(media_type) && !is_boolean_keyword(tokens[offset]) {
            let mut matched = Match::from(
                media_type.eq_ignore_ascii_case("all") || media_type.eq_ignore_ascii_case("screen"),
            );
            if tokens.len() > offset + 1 {
                if !tokens[offset + 1].is_keyword("and") {
                    return Err(invalid(
                        "media type must be followed by 'and' and a condition",
                    ));
                }
                if top_level_tokens(&tokens[offset + 2..]).any(|(_, token)| token.is_keyword("or"))
                {
                    return Err(invalid(
                        "media-type queries require parentheses around an 'or' condition",
                    ));
                }
                matched &= ConditionParser::evaluate(&tokens[offset + 2..], viewport)?;
            }
            return Ok(if negate { !matched } else { matched });
        }
    }
    if offset != 0 {
        return Err(invalid("media query 'only' requires a media type"));
    }
    ConditionParser::evaluate(tokens, viewport)
}

struct ConditionParser<'a, 'source> {
    tokens: &'a [Token<'source>],
    index: usize,
    viewport: Rect,
}

impl<'a, 'source> ConditionParser<'a, 'source> {
    fn evaluate(tokens: &'a [Token<'source>], viewport: Rect) -> Result<Match, ConditionError> {
        if tokens.is_empty() {
            return Err(invalid("media condition cannot be empty"));
        }
        let mut parser = Self {
            tokens,
            index: 0,
            viewport,
        };
        let matched = parser.parse_condition()?;
        if parser.index != tokens.len() {
            return Err(invalid("unexpected token after media condition"));
        }
        Ok(matched)
    }

    fn consume_keyword(&mut self, keyword: &str) -> bool {
        if self
            .tokens
            .get(self.index)
            .is_some_and(|token| token.is_keyword(keyword))
        {
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn parse_condition(&mut self) -> Result<Match, ConditionError> {
        if self.consume_keyword("not") {
            return Ok(!self.parse_primary()?);
        }
        let mut matched = self.parse_primary()?;
        let conjunction = if self.consume_keyword("and") {
            true
        } else if self.consume_keyword("or") {
            false
        } else {
            return Ok(matched);
        };
        loop {
            let operand = self.parse_primary()?;
            if conjunction {
                matched &= operand;
            } else {
                matched |= operand;
            }
            if !self.consume_keyword(if conjunction { "and" } else { "or" }) {
                break;
            }
        }
        Ok(matched)
    }

    fn parse_primary(&mut self) -> Result<Match, ConditionError> {
        if self.tokens.get(self.index) != Some(&Token::Open) {
            return Err(invalid("media conditions require parenthesized features"));
        }
        let start = self.index + 1;
        let mut depth = 1;
        self.index += 1;
        while self.index < self.tokens.len() {
            match self.tokens[self.index] {
                Token::Open => depth += 1,
                Token::Close => {
                    depth -= 1;
                    if depth == 0 {
                        let inner = &self.tokens[start..self.index];
                        self.index += 1;
                        if inner.is_empty() {
                            return Err(invalid("empty media condition parentheses"));
                        }
                        let result = if inner[0] == Token::Open || inner[0].is_keyword("not") {
                            Self::evaluate(inner, self.viewport)
                        } else {
                            feature_matches(inner, self.viewport)
                        };
                        return match result {
                            Err(ConditionError::Invalid { .. }) => Ok(Match::Unknown),
                            result => result,
                        };
                    }
                }
                _ => {}
            }
            self.index += 1;
        }
        Err(invalid("unclosed media condition parentheses"))
    }
}

fn top_level_tokens<'a, 'source>(
    tokens: &'a [Token<'source>],
) -> impl Iterator<Item = (usize, Token<'source>)> + 'a {
    let mut depth = 0;
    tokens
        .iter()
        .copied()
        .enumerate()
        .filter(move |(_, token)| match token {
            Token::Open => {
                depth += 1;
                false
            }
            Token::Close => {
                depth -= 1;
                false
            }
            _ => depth == 0,
        })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Feature {
    Width,
    Height,
    AspectRatio,
    Orientation,
}

fn feature_name(name: &str) -> Option<(Feature, Comparison)> {
    let (name, comparison) = if let Some(name) = name.strip_prefix("min-") {
        (name, Comparison::GreaterEqual)
    } else if let Some(name) = name.strip_prefix("max-") {
        (name, Comparison::LessEqual)
    } else {
        (name, Comparison::Equal)
    };
    let feature = match name {
        "width" => Feature::Width,
        "height" => Feature::Height,
        "aspect-ratio" => Feature::AspectRatio,
        "orientation" if comparison == Comparison::Equal => Feature::Orientation,
        _ => return None,
    };
    Some((feature, comparison))
}

fn feature_matches(tokens: &[Token<'_>], viewport: Rect) -> Result<Match, ConditionError> {
    // Comparison syntax has no colons. Keep it separate from colon syntax so
    // invalid known expressions cannot fall through to an unknown-feature false.
    if top_level_tokens(tokens).any(|(_, token)| matches!(token, Token::Comparison(_))) {
        return range_matches(tokens, viewport);
    }
    let Some(Token::Atom(name)) = tokens.first() else {
        return Err(invalid("media feature must have a name"));
    };
    if !identifier(name) || is_boolean_keyword(tokens[0]) {
        return Err(invalid("invalid media feature name"));
    }
    let lower_name = name.to_ascii_lowercase();
    let known = feature_name(&lower_name);
    if known.is_some_and(|(feature, _)| feature == Feature::AspectRatio)
        && viewport.width == 0.0
        && viewport.height == 0.0
    {
        return Ok(Match::Unknown);
    }
    if tokens.len() == 1 {
        return match known {
            Some((feature, Comparison::Equal)) => Ok(Match::from(match feature {
                Feature::Width => viewport.width != 0.0,
                Feature::Height => viewport.height != 0.0,
                Feature::AspectRatio => viewport.width != 0.0,
                Feature::Orientation => true,
            })),
            Some(_) => Err(invalid("min-/max- media features require a value")),
            None => Ok(Match::Unknown),
        };
    }
    if tokens[1] != Token::Colon {
        // General-enclosed future syntax remains unknown, so negation cannot
        // enable a branch whose feature is unavailable.
        if known.is_none() && tokens[1] == Token::Open && enclosed_function(tokens) {
            return Ok(Match::Unknown);
        }
        return Err(invalid("media feature requires ':' before its value"));
    }
    if tokens.len() == 2
        || top_level_tokens(&tokens[2..])
            .any(|(_, token)| matches!(token, Token::Colon | Token::Comma))
    {
        return Err(invalid("media feature has an empty or malformed value"));
    }
    let Some((feature, comparison)) = known else {
        return Ok(Match::Unknown);
    };
    if feature == Feature::Orientation {
        return match tokens.get(2..) {
            Some([Token::Atom(value)]) if value.eq_ignore_ascii_case("portrait") => {
                Ok(Match::from(viewport.height >= viewport.width))
            }
            Some([Token::Atom(value)]) if value.eq_ignore_ascii_case("landscape") => {
                Ok(Match::from(viewport.width > viewport.height))
            }
            _ => Err(invalid(
                "orientation media feature requires portrait or landscape",
            )),
        };
    }
    let target = numeric_value(feature, &tokens[2..], viewport)?;
    let actual = actual_value(feature, viewport);
    Ok(Match::from(compare_values(actual, comparison, target)))
}

fn enclosed_function(tokens: &[Token<'_>]) -> bool {
    let mut depth = 0;
    for (index, token) in tokens.iter().enumerate().skip(1) {
        match token {
            Token::Open => depth += 1,
            Token::Close => {
                depth -= 1;
                if depth == 0 {
                    return index == tokens.len() - 1;
                }
            }
            _ => {}
        }
    }
    false
}

#[derive(Clone, Copy)]
struct NumericValue {
    numerator: f64,
    denominator: f64,
    scale: f64,
}

fn actual_value(feature: Feature, viewport: Rect) -> NumericValue {
    NumericValue {
        numerator: match feature {
            Feature::Width | Feature::AspectRatio => f64::from(viewport.width),
            Feature::Height => f64::from(viewport.height),
            Feature::Orientation => unreachable!("orientation is not a numeric media feature"),
        },
        denominator: if feature == Feature::AspectRatio {
            f64::from(viewport.height)
        } else {
            1.0
        },
        scale: 1.0,
    }
}

// Compare exact products of the finite binary inputs. Dividing responsive units
// first makes 750rpx differ from width at otherwise ordinary viewport sizes;
// multiplying floating ratios directly can overflow to infinity on both sides.
// Three 53-bit significands fit in the fixed 192-bit product without allocation.
struct Product {
    negative: bool,
    words: [u64; 3],
    exponent: i32,
}

impl Product {
    fn new(factors: [f64; 3]) -> Self {
        let mut product = Self {
            negative: false,
            words: [1, 0, 0],
            exponent: 0,
        };
        for factor in factors {
            let bits = factor.to_bits();
            product.negative ^= bits >> 63 != 0;
            let exponent = ((bits >> 52) & 0x7ff) as i32;
            let significand =
                (bits & ((1u64 << 52) - 1)) | if exponent == 0 { 0 } else { 1u64 << 52 };
            product.exponent += if exponent == 0 {
                -1074
            } else {
                exponent - 1023 - 52
            };
            let mut carry = 0u128;
            for word in &mut product.words {
                let value = u128::from(*word) * u128::from(significand) + carry;
                *word = value as u64;
                carry = value >> 64;
            }
            debug_assert_eq!(carry, 0);
        }
        if product.words == [0; 3] {
            product.negative = false;
        }
        product
    }

    fn bit_len(&self) -> i32 {
        self.words
            .iter()
            .enumerate()
            .rev()
            .find_map(|(index, word)| {
                (*word != 0).then(|| index as i32 * 64 + 64 - word.leading_zeros() as i32)
            })
            .unwrap_or(0)
    }

    fn bit(&self, index: i32) -> bool {
        index >= 0 && self.words[index as usize / 64] & (1u64 << (index as usize % 64)) != 0
    }

    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        use std::cmp::Ordering;
        if self.negative != other.negative {
            return if self.negative {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        let left_len = self.bit_len();
        let right_len = other.bit_len();
        let magnitude = if left_len == 0 || right_len == 0 {
            left_len.cmp(&right_len)
        } else {
            (left_len + self.exponent)
                .cmp(&(right_len + other.exponent))
                .then_with(|| {
                    for offset in 0..left_len.max(right_len) {
                        let compared = self
                            .bit(left_len - 1 - offset)
                            .cmp(&other.bit(right_len - 1 - offset));
                        if compared != Ordering::Equal {
                            return compared;
                        }
                    }
                    Ordering::Equal
                })
        };
        if self.negative {
            magnitude.reverse()
        } else {
            magnitude
        }
    }
}

fn compare_values(left: NumericValue, comparison: Comparison, right: NumericValue) -> bool {
    use std::cmp::Ordering;
    let order = Product::new([left.numerator, left.scale, right.denominator]).cmp(&Product::new([
        right.numerator,
        right.scale,
        left.denominator,
    ]));
    match comparison {
        Comparison::Less => order == Ordering::Less,
        Comparison::LessEqual => order != Ordering::Greater,
        Comparison::Equal => order == Ordering::Equal,
        Comparison::GreaterEqual => order != Ordering::Less,
        Comparison::Greater => order == Ordering::Greater,
    }
}

fn numeric_value(
    feature: Feature,
    tokens: &[Token<'_>],
    viewport: Rect,
) -> Result<NumericValue, ConditionError> {
    if feature == Feature::AspectRatio {
        let (numerator, denominator) = match tokens {
            [Token::Atom(numerator)] => (number(numerator)?, 1.0),
            [Token::Atom(numerator), Token::Slash, Token::Atom(denominator)] => {
                (number(numerator)?, number(denominator)?)
            }
            _ => return Err(invalid("aspect-ratio requires a number or number/number")),
        };
        if numerator < 0.0 || denominator <= 0.0 {
            return Err(invalid(
                "aspect-ratio requires a non-negative numerator and positive denominator",
            ));
        }
        return Ok(NumericValue {
            numerator,
            denominator,
            scale: 1.0,
        });
    }
    let [Token::Atom(value)] = tokens else {
        return Err(invalid("width/height media feature requires one length"));
    };
    length(value, viewport)
}

fn number(source: &str) -> Result<f64, ConditionError> {
    let bytes = source.as_bytes();
    let mut index = usize::from(
        bytes
            .first()
            .is_some_and(|byte| matches!(byte, b'+' | b'-')),
    );
    let integer_start = index;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
    }
    let has_integer = index > integer_start;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let fractional_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if fractional_start == index {
            return Err(invalid("media feature number needs digits after '.'"));
        }
    } else if !has_integer {
        return Err(invalid("media feature number needs digits"));
    }
    if bytes
        .get(index)
        .is_some_and(|byte| matches!(byte, b'e' | b'E'))
    {
        index += 1;
        if bytes
            .get(index)
            .is_some_and(|byte| matches!(byte, b'+' | b'-'))
        {
            index += 1;
        }
        let exponent_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if exponent_start == index {
            return Err(invalid("media feature number needs exponent digits"));
        }
    }
    if index != bytes.len() {
        return Err(invalid("unexpected character in media feature number"));
    }
    source
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
        .ok_or_else(|| invalid("media feature number must be finite"))
}

fn length(source: &str, viewport: Rect) -> Result<NumericValue, ConditionError> {
    let source = source.to_ascii_lowercase();
    for (unit, scale, denominator) in [
        ("rpx", f64::from(viewport.width), 750.0),
        ("rem", 16.0, 1.0),
        ("px", 1.0, 1.0),
        ("vw", f64::from(viewport.width), 100.0),
        ("vh", f64::from(viewport.height), 100.0),
    ] {
        if let Some(value) = source.strip_suffix(unit) {
            return Ok(NumericValue {
                numerator: number(value)?,
                denominator,
                scale,
            });
        }
    }
    if number(&source).is_ok_and(|value| value == 0.0) {
        return Ok(NumericValue {
            numerator: 0.0,
            denominator: 1.0,
            scale: 1.0,
        });
    }
    Err(invalid("unsupported media length unit"))
}

fn range_matches(tokens: &[Token<'_>], viewport: Rect) -> Result<Match, ConditionError> {
    let comparisons = top_level_tokens(tokens)
        .filter_map(|(index, token)| {
            if let Token::Comparison(comparison) = token {
                Some((index, comparison))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    if comparisons.is_empty() || comparisons.len() > 2 {
        return Err(invalid("media range requires one or two comparisons"));
    }
    let (first_index, first_comparison) = comparisons[0];
    let (left, middle, right) = if comparisons.len() == 2 {
        let (second_index, second_comparison) = comparisons[1];
        if first_comparison.direction() == 0
            || first_comparison.direction() != second_comparison.direction()
        {
            return Err(invalid(
                "media range comparisons must point in the same direction",
            ));
        }
        (
            &tokens[..first_index],
            &tokens[first_index + 1..second_index],
            Some((&tokens[second_index + 1..], second_comparison)),
        )
    } else {
        (&tokens[..first_index], &tokens[first_index + 1..], None)
    };
    if left.is_empty() || middle.is_empty() || right.is_some_and(|(tokens, _)| tokens.is_empty()) {
        return Err(invalid("media range has a missing operand"));
    }
    let operand_feature = |tokens: &[Token<'_>]| match tokens {
        [Token::Atom(name)] if identifier(name) => Some(name.to_ascii_lowercase()),
        _ => None,
    };
    let (name, reverse) = if right.is_some() {
        (operand_feature(middle), true)
    } else if let Some(name) = operand_feature(left) {
        (Some(name), false)
    } else {
        (operand_feature(middle), true)
    };
    let name = name.ok_or_else(|| invalid("media range requires a feature name operand"))?;
    let Some((feature, legacy_comparison)) = feature_name(&name) else {
        return Ok(Match::Unknown);
    };
    if legacy_comparison != Comparison::Equal || feature == Feature::Orientation {
        return Err(invalid(
            "media range requires unprefixed width, height or aspect-ratio",
        ));
    }
    if feature == Feature::AspectRatio && viewport.width == 0.0 && viewport.height == 0.0 {
        return Ok(Match::Unknown);
    }
    let actual = actual_value(feature, viewport);
    if reverse {
        let lower = numeric_value(feature, left, viewport)?;
        let matched = compare_values(lower, first_comparison, actual);
        if let Some((right, comparison)) = right {
            let upper = numeric_value(feature, right, viewport)?;
            Ok(Match::from(
                matched & compare_values(actual, comparison, upper),
            ))
        } else {
            Ok(Match::from(matched))
        }
    } else {
        let target = numeric_value(feature, middle, viewport)?;
        Ok(Match::from(compare_values(
            actual,
            first_comparison,
            target,
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn viewport(width: f32, height: f32) -> Rect {
        Rect {
            x: 300.0,
            y: -50.0,
            width,
            height,
        }
    }
    fn matches(query: &str) -> bool {
        media_matches(query, viewport(375.0, 750.0)).unwrap()
    }

    #[test]
    fn media_types_lists_and_modifiers() {
        for query in [
            "screen",
            "ALL",
            "print, only screen and (min-width: 375px)",
            "not screen and (min-width: 376px)",
            "not print and (min-width: 1px)",
            "not future-device",
        ] {
            assert!(matches(query), "{query}");
        }
        for query in [
            "print",
            "not screen and (min-width: 375px)",
            "only future-device and (width:375px)",
            "not layer",
        ] {
            assert!(!matches(query), "{query}");
        }
    }

    #[test]
    fn nested_logic_preserves_unknown_under_negation() {
        for query in [
            "(future-feature: enabled)",
            "not (future-feature: enabled)",
            "not all and (future-feature:value)",
            "(future-feature) and (width:375px)",
            "not (future-function(thing, more))",
            "(future-feature: fn(thing, more >= 3))",
            "not (width:bad-value)",
        ] {
            assert!(!matches(query), "{query}");
        }
        for query in [
            "((min-width:376px) or ((orientation:portrait) and (not (width:376px))))",
            "(future-feature) or (width:375px)",
            "screen/**/and (MIN-WIDTH:375PX)",
            "not(width:123px)",
            "not print and (future-feature)",
        ] {
            assert!(matches(query), "{query}");
        }
    }

    #[test]
    fn dimensions_use_the_logical_viewport_and_initial_rem() {
        for query in [
            "(width:750rpx)",
            "(width:100vw)",
            "(height:100vh)",
            "(width:23.4375rem)",
            "(height:46.875rem)",
            "(width:375px)",
            "(height:1500rpx)",
            "(min-width:375px) and (max-width:375px)",
            "(width > -1px)",
            "(-1px < width)",
        ] {
            assert!(matches(query), "{query}");
        }
        for query in [
            "(width:375rpx)",
            "(height:750rpx)",
            "(max-width:374.999px)",
            "(min-height:750.001px)",
        ] {
            assert!(!matches(query), "{query}");
        }
        assert!(media_matches("(width:0) and (not (width))", viewport(0.0, 750.0)).unwrap());
        for width in [377.0, 402.0, 1001.0, 0.125] {
            for query in [
                "(width:750rpx)",
                "(width:100vw)",
                "(min-width:750rpx)",
                "(max-width:100vw)",
                "(750rpx <= width <= 100vw)",
            ] {
                assert!(
                    media_matches(query, viewport(width, 751.0)).unwrap(),
                    "width {width}, {query}"
                );
            }
        }
    }

    #[test]
    fn orientation_square_is_portrait_and_ratios_preserve_boundaries() {
        assert!(matches("(orientation:portrait)"));
        assert!(!matches("(orientation:landscape)"));
        assert!(media_matches("(orientation:portrait)", viewport(300.0, 300.0)).unwrap());
        for query in [
            "(aspect-ratio:1/2)",
            "(aspect-ratio:0.5)",
            "(min-aspect-ratio:1/3) and (max-aspect-ratio:1/2)",
            "(1/3 < aspect-ratio <= 1/2)",
            "(aspect-ratio >= 1/2)",
            "(aspect-ratio < 1e308/1e308)",
        ] {
            assert!(matches(query), "{query}");
        }
        for query in ["(min-aspect-ratio:2/3)", "(aspect-ratio:1e308/1e308)"] {
            assert!(!matches(query), "{query}");
        }
        assert!(!media_matches("(aspect-ratio:1e-308/1e308)", viewport(0.0, 750.0)).unwrap());
        assert!(media_matches("(aspect-ratio < 1e-308/1e308)", viewport(0.0, 750.0)).unwrap());
        for query in [
            "(aspect-ratio:42/7)",
            "not (aspect-ratio:42/7)",
            "(aspect-ratio)",
            "(aspect-ratio > 1)",
        ] {
            assert!(
                !media_matches(query, viewport(0.0, 0.0)).unwrap(),
                "{query}"
            );
        }
    }

    #[test]
    fn ranges_accept_both_directions_and_preserve_inclusive_edges() {
        for query in [
            "(300px < width <= 375px)",
            "(375px >= width > 300px)",
            "(width = 375px)",
            "(375px = width)",
            "(width >= 375px)",
        ] {
            assert!(matches(query), "{query}");
        }
        for query in [
            "(300px < width < 375px)",
            "(750px < height)",
            "(10 < future-feature <= 20)",
            "not (10 < future-feature <= 20)",
        ] {
            assert!(!matches(query), "{query}");
        }
    }

    #[test]
    fn malformed_or_unsupported_queries_do_not_fail_rendering_or_enable_negation() {
        for query in [
            "",
            "only (width:375px)",
            "screen or (width:375px)",
            "screen and",
            "screenish (width:375px)",
            "screen and (width) or (height)",
            "(width) and (height) or (width)",
            "not not (width)",
            "(width) and not (height)",
            "(width:)",
            "(width:banana)",
            "(width:375)",
            "(width:1em)",
            "(width:NaNpx)",
            "(width:1e999px)",
            "(width:1 px)",
            "(width:375.px)",
            "(width 375px)",
            "(min-width)",
            "(orientation:diagonal)",
            "(aspect-ratio:1/0)",
            "(aspect-ratio:-1/2)",
            "(aspect-ratio:NaN)",
            "(width == 375px)",
            "(100px < width > 200px)",
            "(width <)",
            "(width < height)",
            "(min-width >= 100px)",
            "(width:375px) trailing",
            "(width:375px",
            "(width:375px))",
            "()",
            "not",
            "(width:375px) and",
            "print and (width:broken)",
            "not (width:broken)",
            "not (width:375.px)",
            "/* missing",
        ] {
            assert!(!matches(query), "{query}");
        }
        for query in [
            "screen,",
            ",screen",
            "screen, (width:broken)",
            "screen, (",
            "(width:375px) or (width:broken)",
        ] {
            assert!(matches(query), "{query}");
        }
    }

    #[test]
    fn bounds_and_viewport_are_the_only_fatal_conditions() {
        for (query, size) in [
            (
                format!(
                    "{}(width){}",
                    "(".repeat(MAX_NESTING),
                    ")".repeat(MAX_NESTING)
                ),
                viewport(1.0, 1.0),
            ),
            ("s".repeat(MAX_CONDITION_BYTES + 1), viewport(1.0, 1.0)),
            ("screen".into(), viewport(f32::NAN, 1.0)),
            ("screen".into(), viewport(1.0, -1.0)),
        ] {
            assert_eq!(
                media_matches(&query, size).unwrap_err().code,
                BridgeErrorCode::Render
            );
        }
    }

    #[test]
    fn numeric_lexing_accepts_css_decimals_and_exponents_only() {
        for source in ["0", "-0", ".5", "+.5", "1e2", "-1.2e-3"] {
            assert!(number(source).is_ok(), "{source}");
        }
        for source in [
            "", ".", "1.", "1.e2", "e2", "NaN", "inf", "1e", "1_0", "1e999",
        ] {
            assert!(number(source).is_err(), "{source}");
        }
    }

    #[test]
    fn exact_product_comparison_preserves_tiny_and_huge_ratios() {
        use std::cmp::Ordering;
        assert_eq!(
            Product::new([1e308, 750.0, 1.0]).cmp(&Product::new([1e308, 375.0, 1.0])),
            Ordering::Greater
        );
        assert_eq!(
            Product::new([1e-308, 1e-308, 1.0]).cmp(&Product::new([0.0, 1.0, 1.0])),
            Ordering::Greater
        );
        assert_eq!(
            Product::new([-1.0, 1.0, 1.0]).cmp(&Product::new([0.0, 1.0, 1.0])),
            Ordering::Less
        );
        assert_eq!(
            Product::new([750.0, 377.0, 1.0]).cmp(&Product::new([377.0, 750.0, 1.0])),
            Ordering::Equal
        );
    }

    #[test]
    fn supports_cannot_claim_a_declaration_is_supported() {
        assert_eq!(
            supports_matches("(display:flex)").unwrap_err().code,
            BridgeErrorCode::UnsupportedCapability
        );
        assert_eq!(
            supports_matches("not (display:grid)").unwrap_err().code,
            BridgeErrorCode::UnsupportedCapability
        );
    }
}
