//! Property-specific CSS/WXSS text values, independent of viewport or fonts.
//!
//! Validation happens before cascade comparison. Invalid declarations must not
//! erase an earlier valid value, while valid syntax outside the runtime's
//! current implementation remains observable as an explicit unsupported value.

use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WxssTextLengthUnit {
    Px,
    Rpx,
    Rem,
    Em,
    Vw,
    Vh,
    Vmin,
    Vmax,
    Percent,
    In,
    Cm,
    Mm,
    Q,
    Pt,
    Pc,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WxssTextLength {
    pub value: f32,
    pub unit: WxssTextLengthUnit,
}

#[derive(Clone, Debug, PartialEq)]
pub enum WxssFontSize {
    Initial,
    Inherit,
    Unset,
    Length(WxssTextLength),
    /// A known keyword/unit or deferred function accepted by the bounded
    /// numeric grammar. No function is evaluated by this parser.
    Unsupported(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum WxssLineHeight {
    Initial,
    Inherit,
    Unset,
    Normal,
    Number(f32),
    Length(WxssTextLength),
    /// A known keyword/unit or deferred function accepted by the bounded
    /// numeric grammar. No function is evaluated by this parser.
    Unsupported(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WxssWhiteSpace {
    Initial,
    Inherit,
    Unset,
    Normal,
    Nowrap,
    Pre,
    PreWrap,
    PreLine,
    BreakSpaces,
    Unsupported(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WxssWordBreak {
    Initial,
    Inherit,
    Unset,
    Normal,
    BreakAll,
    KeepAll,
    Unsupported(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WxssTextAlign {
    Initial,
    Inherit,
    Unset,
    Start,
    End,
    Left,
    Right,
    Center,
    Unsupported(String),
}

/// Direction is validated even in the current LTR-only text-flow subset.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WxssTextDirection {
    Initial,
    Inherit,
    Unset,
    Ltr,
    Unsupported(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WxssUnicodeBidi {
    Initial,
    Inherit,
    Unset,
    Normal,
    Unsupported(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WxssTextValueError {
    Empty,
    Invalid(String),
}

impl fmt::Display for WxssTextValueError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("WXSS text value cannot be empty"),
            Self::Invalid(value) => write!(formatter, "invalid WXSS text value: {value}"),
        }
    }
}

impl std::error::Error for WxssTextValueError {}

pub(crate) enum NumericTextValue {
    Number(f32),
    Length(WxssTextLength),
    Unsupported,
}

pub(crate) fn css_whitespace(character: char) -> bool {
    matches!(character, ' ' | '\t' | '\n' | '\r' | '\u{c}')
}

fn source_value(source: &str) -> Result<&str, WxssTextValueError> {
    let source = source.trim_matches(css_whitespace);
    if source.is_empty() {
        Err(WxssTextValueError::Empty)
    } else {
        Ok(source)
    }
}

/// Split a CSS numeric token into its signed/exponent number and adjacent
/// suffix. Callers validate dimensions and representability independently.
pub(crate) fn css_numeric_token(source: &str) -> Option<(&str, &str)> {
    let bytes = source.as_bytes();
    let mut end = usize::from(matches!(bytes.first(), Some(b'+') | Some(b'-')));
    let integer_start = end;
    while bytes.get(end).is_some_and(u8::is_ascii_digit) {
        end += 1;
    }
    let has_integer = end > integer_start;
    let mut has_fraction = false;
    if bytes.get(end) == Some(&b'.') && bytes.get(end + 1).is_some_and(u8::is_ascii_digit) {
        end += 1;
        let fraction_start = end;
        while bytes.get(end).is_some_and(u8::is_ascii_digit) {
            end += 1;
        }
        has_fraction = end > fraction_start;
    }
    if !has_integer && !has_fraction {
        return None;
    }
    if matches!(bytes.get(end), Some(b'e') | Some(b'E')) {
        let mut exponent = end + 1;
        if matches!(bytes.get(exponent), Some(b'+') | Some(b'-')) {
            exponent += 1;
        }
        if bytes.get(exponent).is_some_and(u8::is_ascii_digit) {
            end = exponent + 1;
            while bytes.get(end).is_some_and(u8::is_ascii_digit) {
                end += 1;
            }
        }
    }
    Some((&source[..end], &source[end..]))
}

/// The CSS number grammar, deliberately narrower than Rust's float parser.
/// Keeping the suffix adjacent rejects `1 px`; exponent signs are part of the
/// number only when followed by a digit, so `1em` retains its `em` unit.
pub(crate) fn numeric_value(source: &str) -> Result<NumericTextValue, WxssTextValueError> {
    let (number, _) =
        css_numeric_token(source).ok_or_else(|| WxssTextValueError::Invalid(source.into()))?;
    let end = number.len();
    let nonzero_mantissa = number
        .split(['e', 'E'])
        .next()
        .unwrap_or(number)
        .bytes()
        .any(|byte| matches!(byte, b'1'..=b'9'));
    let numeric = source[..end]
        .parse::<f64>()
        .map_err(|_| WxssTextValueError::Invalid(source.into()))?;
    let value = numeric as f32;
    if !numeric.is_finite()
        || !value.is_finite()
        || numeric < 0.0
        || (nonzero_mantissa && (source.starts_with('-') || value == 0.0))
    {
        // Neither overflow nor underflow may turn an invalid negative length
        // or a nonzero unitless font-size into an accepted zero declaration.
        return Err(WxssTextValueError::Invalid(source.into()));
    }
    let unit = match source[end..].to_ascii_lowercase().as_str() {
        "" => return Ok(NumericTextValue::Number(value)),
        "px" => WxssTextLengthUnit::Px,
        "rpx" => WxssTextLengthUnit::Rpx,
        "rem" => WxssTextLengthUnit::Rem,
        "em" => WxssTextLengthUnit::Em,
        "vw" => WxssTextLengthUnit::Vw,
        "vh" => WxssTextLengthUnit::Vh,
        "vmin" => WxssTextLengthUnit::Vmin,
        "vmax" => WxssTextLengthUnit::Vmax,
        "%" => WxssTextLengthUnit::Percent,
        "in" => WxssTextLengthUnit::In,
        "cm" => WxssTextLengthUnit::Cm,
        "mm" => WxssTextLengthUnit::Mm,
        "q" => WxssTextLengthUnit::Q,
        "pt" => WxssTextLengthUnit::Pt,
        "pc" => WxssTextLengthUnit::Pc,
        // These are CSS length units but require font metrics, writing mode,
        // a dynamic viewport or a container-query environment we do not have.
        "ex" | "ch" | "cap" | "ic" | "lh" | "rlh" | "rex" | "rch" | "rcap" | "ric" | "vi"
        | "vb" | "svw" | "svh" | "svi" | "svb" | "svmin" | "svmax" | "lvw" | "lvh" | "lvi"
        | "lvb" | "lvmin" | "lvmax" | "dvw" | "dvh" | "dvi" | "dvb" | "dvmin" | "dvmax" | "cqw"
        | "cqh" | "cqi" | "cqb" | "cqmin" | "cqmax" => return Ok(NumericTextValue::Unsupported),
        _ => return Err(WxssTextValueError::Invalid(source.into())),
    };
    Ok(NumericTextValue::Length(WxssTextLength { value, unit }))
}

/// Read one complete function token; property-specific argument validation is
/// performed separately below.
pub(crate) fn complete_function(source: &str) -> Option<(&str, &str)> {
    let open = source.find('(')?;
    if !css_identifier(&source[..open])
        || !source.ends_with(')')
        || source[open + 1..source.len() - 1]
            .trim_matches(css_whitespace)
            .is_empty()
    {
        return None;
    }
    let mut delimiters = Vec::new();
    let mut quote = None;
    let mut escaped = false;
    for (index, character) in source[open..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if let Some(expected) = quote {
            if character == expected {
                quote = None;
            }
            continue;
        }
        match character {
            '\'' | '"' => quote = Some(character),
            '(' => delimiters.push(')'),
            '[' => delimiters.push(']'),
            ')' | ']' => {
                if delimiters.pop() != Some(character) {
                    return None;
                }
                if delimiters.is_empty() && open + index + character.len_utf8() != source.len() {
                    return None;
                }
            }
            ';' | '{' | '}' | '!' => return None,
            _ => {}
        }
    }
    (!escaped && quote.is_none() && delimiters.is_empty())
        .then_some((&source[..open], &source[open + 1..source.len() - 1]))
}

pub(crate) fn css_identifier(source: &str) -> bool {
    let mut characters = source.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    let start =
        |character: char| character == '_' || character.is_alphabetic() || !character.is_ascii();
    if first == '-' {
        let Some(second) = characters.next() else {
            return false;
        };
        if second != '-' && !start(second) {
            return false;
        }
    } else if !start(first) {
        return false;
    }
    characters.all(|character| start(character) || character.is_ascii_digit() || character == '-')
}

pub(crate) fn top_level_arguments(source: &str) -> Option<Vec<&str>> {
    let mut result = Vec::new();
    let mut depth = 0usize;
    let mut quote = None;
    let mut escaped = false;
    let mut start = 0;
    for (index, character) in source.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if let Some(expected) = quote {
            if character == expected {
                quote = None;
            }
            continue;
        }
        match character {
            '\'' | '"' => quote = Some(character),
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.checked_sub(1)?,
            ',' if depth == 0 => {
                result.push(source[start..index].trim_matches(css_whitespace));
                start = index + 1;
            }
            _ => {}
        }
    }
    if depth != 0 || quote.is_some() || escaped {
        return None;
    }
    result.push(source[start..].trim_matches(css_whitespace));
    Some(result)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NumericKind {
    Number,
    Length,
    Percent,
    LengthPercent,
    Angle,
    Dimension([i8; 6]),
    Deferred,
}

fn multiply_kind(left: NumericKind, right: NumericKind, divide: bool) -> Option<NumericKind> {
    use NumericKind::*;
    let dimensions = |kind| match kind {
        Number => [0; 6],
        Length | Percent | LengthPercent => [1, 0, 0, 0, 0, 0],
        Angle => [0, 1, 0, 0, 0, 0],
        Dimension(dimensions) => dimensions,
        Deferred => unreachable!(),
    };
    if left == Deferred || right == Deferred {
        return Some(Deferred);
    }
    // Scaling preserves a percentage's property-specific type. Treating it
    // as a length here makes valid opacity math disappear before cascade.
    if right == Number {
        return Some(left);
    }
    if !divide && left == Number {
        return Some(right);
    }
    let mut result = dimensions(left);
    for (left, right) in result.iter_mut().zip(dimensions(right)) {
        *left = if divide {
            left.checked_sub(right)?
        } else {
            left.checked_add(right)?
        };
    }
    Some(match result {
        [0, 0, 0, 0, 0, 0] => Number,
        [1, 0, 0, 0, 0, 0] => Length,
        [0, 1, 0, 0, 0, 0] => Angle,
        _ => Dimension(result),
    })
}

fn add_kind(left: NumericKind, right: NumericKind) -> Option<NumericKind> {
    use NumericKind::*;
    match (left, right) {
        (Deferred, _) | (_, Deferred) => Some(Deferred),
        (Length | Percent | LengthPercent, Length | Percent | LengthPercent) => {
            Some(if left == right { left } else { LengthPercent })
        }
        _ if left == right => Some(left),
        _ => None,
    }
}

pub(crate) fn function_kind(source: &str) -> Option<NumericKind> {
    function_kind_bounded(source, 0)
}

fn function_kind_bounded(source: &str, depth: usize) -> Option<NumericKind> {
    if depth >= 64 {
        return None;
    }
    use NumericKind::*;
    let (name, body) = complete_function(source)?;
    let name = name.to_ascii_lowercase();
    let args = top_level_arguments(body)?;
    if matches!(name.as_str(), "var" | "env" | "attr") {
        let first = *args.first()?;
        match name.as_str() {
            "var" => {
                if !first.starts_with("--") || first.len() <= 2 || !css_identifier(first) {
                    return None;
                }
            }
            "env" => {
                let mut parts = first.split_ascii_whitespace();
                if !css_identifier(parts.next()?)
                    || parts.any(|part| {
                        part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit())
                    })
                {
                    return None;
                }
            }
            "attr" => {
                let mut parts = first.splitn(2, css_whitespace);
                if !css_identifier(parts.next()?) {
                    return None;
                }
                if let Some(kind) = parts.next().map(str::trim).filter(|part| !part.is_empty()) {
                    if let Some((function, syntax)) = complete_function(kind) {
                        if !function.eq_ignore_ascii_case("type")
                            || !matches!(
                                syntax.trim(),
                                "*" | "<length>"
                                    | "<length-percentage>"
                                    | "<number>"
                                    | "<integer>"
                                    | "<percentage>"
                                    | "<angle>"
                            )
                        {
                            return None;
                        }
                    } else if !matches!(
                        kind.to_ascii_lowercase().as_str(),
                        "raw-string"
                            | "string"
                            | "number"
                            | "integer"
                            | "px"
                            | "rpx"
                            | "em"
                            | "rem"
                            | "vw"
                            | "vh"
                            | "pt"
                            | "cm"
                            | "mm"
                            | "in"
                            | "pc"
                            | "q"
                            | "%"
                    ) {
                        return None;
                    }
                }
            }
            _ => unreachable!(),
        }
        return Some(Deferred);
    }
    let expression = |source: &str| TextMathParser::new(source, depth).parse();
    let mut kinds = Vec::new();
    let mut args = args.as_slice();
    if name == "round"
        && args.first().is_some_and(|arg| {
            matches!(
                arg.to_ascii_lowercase().as_str(),
                "nearest" | "up" | "down" | "to-zero"
            )
        })
    {
        args = &args[1..];
    }
    for (index, arg) in args.iter().enumerate() {
        kinds.push(
            if name == "clamp" && matches!(index, 0 | 2) && arg.eq_ignore_ascii_case("none") {
                Deferred
            } else {
                expression(arg)?
            },
        );
    }
    match name.as_str() {
        "calc" if kinds.len() == 1 => Some(kinds[0]),
        "min" | "max" | "hypot" if !kinds.is_empty() => kinds[1..]
            .iter()
            .try_fold(kinds[0], |left, right| add_kind(left, *right)),
        "clamp" if kinds.len() == 3 => add_kind(add_kind(kinds[0], kinds[1])?, kinds[2]),
        "round" if matches!(kinds.len(), 1 | 2) => {
            if kinds.len() == 1 {
                // CSS Values 4: when B is omitted, A must be a number;
                // only then can the omitted rounding interval default to 1.
                matches!(kinds[0], Number | Deferred).then_some(kinds[0])
            } else {
                add_kind(kinds[0], kinds[1])
            }
        }
        "mod" | "rem" if kinds.len() == 2 => add_kind(kinds[0], kinds[1]),
        "abs" if kinds.len() == 1 => Some(kinds[0]),
        "sign" if kinds.len() == 1 => Some(Number),
        "pow" if kinds.len() == 2 && kinds.iter().all(|kind| matches!(kind, Number | Deferred)) => {
            Some(Number)
        }
        "sqrt" | "exp" if kinds.len() == 1 && matches!(kinds[0], Number | Deferred) => Some(Number),
        "log"
            if matches!(kinds.len(), 1 | 2)
                && kinds.iter().all(|kind| matches!(kind, Number | Deferred)) =>
        {
            Some(Number)
        }
        "sin" | "cos" | "tan"
            if kinds.len() == 1 && matches!(kinds[0], Number | Angle | Deferred) =>
        {
            Some(Number)
        }
        "asin" | "acos" | "atan" if kinds.len() == 1 && matches!(kinds[0], Number | Deferred) => {
            Some(Angle)
        }
        "atan2" if kinds.len() == 2 && add_kind(kinds[0], kinds[1]).is_some() => Some(Angle),
        _ => None,
    }
}

struct TextMathParser<'a> {
    source: &'a str,
    position: usize,
    depth: usize,
}

impl<'a> TextMathParser<'a> {
    fn new(source: &'a str, depth: usize) -> Self {
        Self {
            source,
            position: 0,
            depth,
        }
    }
    fn whitespace(&mut self) {
        while self.source[self.position..]
            .chars()
            .next()
            .is_some_and(css_whitespace)
        {
            self.position += 1;
        }
    }
    fn parse(mut self) -> Option<NumericKind> {
        let kind = self.sum()?;
        self.whitespace();
        (self.position == self.source.len()).then_some(kind)
    }
    fn sum(&mut self) -> Option<NumericKind> {
        let mut kind = self.product()?;
        loop {
            let before_space = self.position;
            self.whitespace();
            if !matches!(
                self.source.as_bytes().get(self.position),
                Some(b'+') | Some(b'-')
            ) {
                return Some(kind);
            }
            if before_space == self.position
                || !self
                    .source
                    .as_bytes()
                    .get(self.position + 1)
                    .is_some_and(|byte| css_whitespace(*byte as char))
            {
                return None;
            }
            self.position += 1;
            kind = add_kind(kind, self.product()?)?;
        }
    }
    fn product(&mut self) -> Option<NumericKind> {
        let mut kind = self.atom()?;
        loop {
            let before_space = self.position;
            self.whitespace();
            let Some(operator @ (b'*' | b'/')) = self.source.as_bytes().get(self.position).copied()
            else {
                self.position = before_space;
                return Some(kind);
            };
            self.position += 1;
            let right = self.atom()?;
            kind = multiply_kind(kind, right, operator == b'/')?;
        }
    }
    fn atom(&mut self) -> Option<NumericKind> {
        use NumericKind::*;
        self.whitespace();
        let remaining = &self.source[self.position..];
        if remaining.starts_with('(') {
            if self.depth >= 64 {
                return None;
            }
            self.depth += 1;
            self.position += 1;
            let kind = self.sum()?;
            self.whitespace();
            if self.source.as_bytes().get(self.position) != Some(&b')') {
                return None;
            }
            self.position += 1;
            self.depth -= 1;
            return Some(kind);
        }
        if remaining
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
        {
            let end = remaining
                .find(|character: char| {
                    !character.is_ascii_alphanumeric() && character != '-' && character != '_'
                })
                .unwrap_or(remaining.len());
            let name = &remaining[..end];
            if remaining.as_bytes().get(end) == Some(&b'(') {
                let mut depth = 0usize;
                let mut close = None;
                for (index, character) in remaining[end..].char_indices() {
                    if character == '(' {
                        depth += 1;
                    }
                    if character == ')' {
                        depth = depth.checked_sub(1)?;
                        if depth == 0 {
                            close = Some(end + index + 1);
                            break;
                        }
                    }
                }
                let close = close?;
                let kind = function_kind_bounded(&remaining[..close], self.depth + 1)?;
                self.position += close;
                return Some(kind);
            }
            if matches!(
                name.to_ascii_lowercase().as_str(),
                "e" | "pi" | "infinity" | "nan"
            ) {
                self.position += end;
                return Some(Number);
            }
            return None;
        }
        let bytes = remaining.as_bytes();
        let mut end = usize::from(matches!(bytes.first(), Some(b'+') | Some(b'-')));
        let number_start = end;
        while bytes.get(end).is_some_and(u8::is_ascii_digit) {
            end += 1;
        }
        let mut digits = end > number_start;
        if bytes.get(end) == Some(&b'.') && bytes.get(end + 1).is_some_and(u8::is_ascii_digit) {
            digits = true;
            end += 1;
            while bytes.get(end).is_some_and(u8::is_ascii_digit) {
                end += 1;
            }
        }
        if !digits {
            return None;
        }
        if matches!(bytes.get(end), Some(b'e') | Some(b'E')) {
            let mut exponent = end + 1;
            if matches!(bytes.get(exponent), Some(b'+') | Some(b'-')) {
                exponent += 1;
            }
            if bytes.get(exponent).is_some_and(u8::is_ascii_digit) {
                end = exponent + 1;
                while bytes.get(end).is_some_and(u8::is_ascii_digit) {
                    end += 1;
                }
            }
        }
        let number_end = end;
        while bytes.get(end).is_some_and(u8::is_ascii_alphabetic) {
            end += 1;
        }
        if bytes.get(end) == Some(&b'%') {
            end += 1;
        }
        let kind = match remaining[number_end..end].to_ascii_lowercase().as_str() {
            "" => Number,
            "%" => Percent,
            "deg" | "rad" | "grad" | "turn" => Angle,
            "s" | "ms" => Dimension([0, 0, 1, 0, 0, 0]),
            "hz" | "khz" => Dimension([0, 0, 0, 1, 0, 0]),
            "dpi" | "dpcm" | "dppx" | "x" => Dimension([0, 0, 0, 0, 1, 0]),
            "fr" => Dimension([0, 0, 0, 0, 0, 1]),
            unit => match numeric_value(&format!("1{unit}")).ok()? {
                NumericTextValue::Length(_) | NumericTextValue::Unsupported => Length,
                NumericTextValue::Number(_) => return None,
            },
        };
        self.position += end;
        Some(kind)
    }
}

fn font_size_function(source: &str) -> bool {
    matches!(
        function_kind(source),
        Some(
            NumericKind::Length
                | NumericKind::Percent
                | NumericKind::LengthPercent
                | NumericKind::Deferred
        )
    )
}

/// Top-level substitutions can stand for several shorthand components. Their
/// grammar is checked here, while expansion waits until a runtime supports it.
pub(crate) fn font_substitution(source: &str) -> Option<bool> {
    let (name, _) = complete_function(source)?;
    matches!(name.to_ascii_lowercase().as_str(), "var" | "env" | "attr")
        .then(|| function_kind(source).is_some())
}

/// Parse `font-size` without choosing a viewport or parent font size.
pub fn parse_wxss_font_size(source: &str) -> Result<WxssFontSize, WxssTextValueError> {
    let source = source_value(source)?;
    let value = match source.to_ascii_lowercase().as_str() {
        "initial" | "medium" => WxssFontSize::Initial,
        "inherit" => WxssFontSize::Inherit,
        "unset" => WxssFontSize::Unset,
        "revert" | "revert-layer" | "xx-small" | "x-small" | "small" | "large" | "x-large"
        | "xx-large" | "xxx-large" | "larger" | "smaller" | "math" => {
            WxssFontSize::Unsupported(source.into())
        }
        _ if font_size_function(source) => WxssFontSize::Unsupported(source.into()),
        _ => match numeric_value(source)? {
            NumericTextValue::Number(0.0) => WxssFontSize::Length(WxssTextLength {
                value: 0.0,
                unit: WxssTextLengthUnit::Px,
            }),
            NumericTextValue::Number(_) => {
                return Err(WxssTextValueError::Invalid(source.into()));
            }
            NumericTextValue::Length(length) => WxssFontSize::Length(length),
            NumericTextValue::Unsupported => WxssFontSize::Unsupported(source.into()),
        },
    };
    Ok(value)
}

/// Parse `line-height`. Unitless numbers stay multipliers; unlike percentages
/// and lengths, their used value depends on the descendant's own font size.
pub fn parse_wxss_line_height(source: &str) -> Result<WxssLineHeight, WxssTextValueError> {
    let source = source_value(source)?;
    let value = match source.to_ascii_lowercase().as_str() {
        "initial" => WxssLineHeight::Initial,
        "inherit" => WxssLineHeight::Inherit,
        "unset" => WxssLineHeight::Unset,
        "normal" => WxssLineHeight::Normal,
        "revert" | "revert-layer" => WxssLineHeight::Unsupported(source.into()),
        _ if matches!(
            function_kind(source),
            Some(
                NumericKind::Number
                    | NumericKind::Length
                    | NumericKind::Percent
                    | NumericKind::LengthPercent
                    | NumericKind::Deferred
            )
        ) =>
        {
            WxssLineHeight::Unsupported(source.into())
        }
        _ => match numeric_value(source)? {
            NumericTextValue::Number(number) => WxssLineHeight::Number(number),
            NumericTextValue::Length(length) => WxssLineHeight::Length(length),
            NumericTextValue::Unsupported => WxssLineHeight::Unsupported(source.into()),
        },
    };
    Ok(value)
}

/// Deferred keyword substitutions are retained, never executed or replaced
/// with a default. Numeric math functions cannot produce these keywords.
pub(crate) fn text_keyword_substitution(source: &str) -> bool {
    font_substitution(source) == Some(true)
}

// CSS Text 4 also permits longhand combinations in the white-space shorthand.
// Keep recognized, but not yet implemented, syntax in the winning declaration
// so the runtime explicitly rejects it instead of reviving an earlier value.
fn white_space_longhands(value: &str) -> bool {
    let mut collapse = false;
    let mut wrap = false;
    let mut none = false;
    let mut trim = 0u8;
    for token in value
        .split(css_whitespace)
        .filter(|token| !token.is_empty())
    {
        match token {
            "collapse" | "discard" | "preserve" | "preserve-breaks" | "preserve-spaces"
            | "break-spaces"
                if !collapse =>
            {
                collapse = true
            }
            "wrap" | "nowrap" if !wrap => wrap = true,
            "none" if !none && trim == 0 => none = true,
            "discard-before" if !none && trim & 1 == 0 => trim |= 1,
            "discard-after" if !none && trim & 2 == 0 => trim |= 2,
            "discard-inner" if !none && trim & 4 == 0 => trim |= 4,
            _ => return false,
        }
    }
    collapse || wrap || none || trim != 0
}

pub fn parse_wxss_white_space(source: &str) -> Result<WxssWhiteSpace, WxssTextValueError> {
    let source = source_value(source)?;
    Ok(match source.to_ascii_lowercase().as_str() {
        "initial" => WxssWhiteSpace::Initial,
        "inherit" => WxssWhiteSpace::Inherit,
        "unset" => WxssWhiteSpace::Unset,
        "normal" => WxssWhiteSpace::Normal,
        "nowrap" => WxssWhiteSpace::Nowrap,
        "pre" => WxssWhiteSpace::Pre,
        "pre-wrap" => WxssWhiteSpace::PreWrap,
        "pre-line" => WxssWhiteSpace::PreLine,
        "break-spaces" => WxssWhiteSpace::BreakSpaces,
        "revert" | "revert-layer" => WxssWhiteSpace::Unsupported(source.into()),
        value if white_space_longhands(value) || text_keyword_substitution(source) => {
            WxssWhiteSpace::Unsupported(source.into())
        }
        _ => return Err(WxssTextValueError::Invalid(source.into())),
    })
}

pub fn parse_wxss_word_break(source: &str) -> Result<WxssWordBreak, WxssTextValueError> {
    let source = source_value(source)?;
    Ok(match source.to_ascii_lowercase().as_str() {
        "initial" => WxssWordBreak::Initial,
        "inherit" => WxssWordBreak::Inherit,
        "unset" => WxssWordBreak::Unset,
        "normal" => WxssWordBreak::Normal,
        "break-all" => WxssWordBreak::BreakAll,
        "keep-all" => WxssWordBreak::KeepAll,
        "break-word" | "auto-phrase" | "manual" | "revert" | "revert-layer" => {
            WxssWordBreak::Unsupported(source.into())
        }
        _ if text_keyword_substitution(source) => WxssWordBreak::Unsupported(source.into()),
        _ => return Err(WxssTextValueError::Invalid(source.into())),
    })
}

pub fn parse_wxss_text_align(source: &str) -> Result<WxssTextAlign, WxssTextValueError> {
    let source = source_value(source)?;
    Ok(match source.to_ascii_lowercase().as_str() {
        "initial" => WxssTextAlign::Initial,
        "inherit" => WxssTextAlign::Inherit,
        "unset" => WxssTextAlign::Unset,
        "start" => WxssTextAlign::Start,
        "end" => WxssTextAlign::End,
        "left" => WxssTextAlign::Left,
        "right" => WxssTextAlign::Right,
        "center" => WxssTextAlign::Center,
        "justify" | "justify-all" | "match-parent" | "revert" | "revert-layer" => {
            WxssTextAlign::Unsupported(source.into())
        }
        _ if text_keyword_substitution(source) => WxssTextAlign::Unsupported(source.into()),
        _ => return Err(WxssTextValueError::Invalid(source.into())),
    })
}

pub fn parse_wxss_text_direction(source: &str) -> Result<WxssTextDirection, WxssTextValueError> {
    let source = source_value(source)?;
    Ok(match source.to_ascii_lowercase().as_str() {
        "initial" => WxssTextDirection::Initial,
        "inherit" => WxssTextDirection::Inherit,
        "unset" => WxssTextDirection::Unset,
        "ltr" => WxssTextDirection::Ltr,
        "rtl" | "revert" | "revert-layer" => WxssTextDirection::Unsupported(source.into()),
        _ if text_keyword_substitution(source) => WxssTextDirection::Unsupported(source.into()),
        _ => return Err(WxssTextValueError::Invalid(source.into())),
    })
}

pub fn parse_wxss_unicode_bidi(source: &str) -> Result<WxssUnicodeBidi, WxssTextValueError> {
    let source = source_value(source)?;
    Ok(match source.to_ascii_lowercase().as_str() {
        "initial" => WxssUnicodeBidi::Initial,
        "inherit" => WxssUnicodeBidi::Inherit,
        "unset" => WxssUnicodeBidi::Unset,
        "normal" => WxssUnicodeBidi::Normal,
        "embed" | "isolate" | "bidi-override" | "isolate-override" | "plaintext" | "revert"
        | "revert-layer" => WxssUnicodeBidi::Unsupported(source.into()),
        _ if text_keyword_substitution(source) => WxssUnicodeBidi::Unsupported(source.into()),
        _ => return Err(WxssTextValueError::Invalid(source.into())),
    })
}

pub(crate) fn number_function(source: &str) -> bool {
    matches!(
        function_kind(source),
        Some(NumericKind::Number | NumericKind::Deferred)
    )
}

pub(crate) fn opacity_function(source: &str) -> bool {
    matches!(
        function_kind(source),
        Some(NumericKind::Number | NumericKind::Percent | NumericKind::Deferred)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_text_flow_keywords_and_globals_without_selecting_a_renderer() {
        for (source, expected) in [
            (" normal ", WxssWhiteSpace::Normal),
            ("NOWRAP", WxssWhiteSpace::Nowrap),
            ("pre", WxssWhiteSpace::Pre),
            ("pre-wrap", WxssWhiteSpace::PreWrap),
            ("pre-line", WxssWhiteSpace::PreLine),
            ("break-spaces", WxssWhiteSpace::BreakSpaces),
            ("initial", WxssWhiteSpace::Initial),
            ("inherit", WxssWhiteSpace::Inherit),
            ("unset", WxssWhiteSpace::Unset),
        ] {
            assert_eq!(parse_wxss_white_space(source), Ok(expected), "{source}");
        }
        for (source, expected) in [
            ("normal", WxssWordBreak::Normal),
            ("BREAK-ALL", WxssWordBreak::BreakAll),
            ("keep-all", WxssWordBreak::KeepAll),
            ("initial", WxssWordBreak::Initial),
            ("inherit", WxssWordBreak::Inherit),
            ("unset", WxssWordBreak::Unset),
        ] {
            assert_eq!(parse_wxss_word_break(source), Ok(expected), "{source}");
        }
        for (source, expected) in [
            ("start", WxssTextAlign::Start),
            ("end", WxssTextAlign::End),
            ("left", WxssTextAlign::Left),
            ("right", WxssTextAlign::Right),
            ("CENTER", WxssTextAlign::Center),
            ("initial", WxssTextAlign::Initial),
            ("inherit", WxssTextAlign::Inherit),
            ("unset", WxssTextAlign::Unset),
        ] {
            assert_eq!(parse_wxss_text_align(source), Ok(expected), "{source}");
        }
        assert_eq!(parse_wxss_text_direction("LTR"), Ok(WxssTextDirection::Ltr));
        assert_eq!(
            parse_wxss_unicode_bidi("NORMAL"),
            Ok(WxssUnicodeBidi::Normal)
        );
    }

    #[test]
    fn invalid_text_flow_tokens_are_distinct_from_valid_unimplemented_syntax() {
        type Parser = fn(&str) -> Result<(), WxssTextValueError>;
        let parsers: [Parser; 5] = [
            |value| parse_wxss_white_space(value).map(|_| ()),
            |value| parse_wxss_word_break(value).map(|_| ()),
            |value| parse_wxss_text_align(value).map(|_| ()),
            |value| parse_wxss_text_direction(value).map(|_| ()),
            |value| parse_wxss_unicode_bidi(value).map(|_| ()),
        ];
        for parse in parsers {
            for value in [
                "",
                "banana",
                "1",
                "normal normal",
                "calc(1 + 1)",
                "var(name)",
                "var(--x) extra",
                "env()",
                "inherit normal",
                "normal\u{a0}",
            ] {
                assert!(parse(value).is_err(), "invalid flow value: {value:?}");
            }
            for value in [
                "revert",
                "revert-layer",
                "var(--Flow, normal)",
                "var(--x,)",
                "env(preferred-flow, normal)",
                "attr(data-flow)",
            ] {
                assert!(parse(value).is_ok(), "valid deferred value: {value:?}");
            }
        }
        for source in [
            "collapse",
            "preserve nowrap",
            "wrap preserve-breaks",
            "break-spaces nowrap",
            "preserve wrap discard-before discard-inner",
            "none",
        ] {
            assert_eq!(
                parse_wxss_white_space(source),
                Ok(WxssWhiteSpace::Unsupported(source.into()))
            );
        }
        for source in [
            "collapse preserve",
            "wrap nowrap",
            "pre wrap",
            "discard-before discard-before",
            "none discard-after",
        ] {
            assert!(parse_wxss_white_space(source).is_err(), "{source}");
        }
        for source in ["break-word", "auto-phrase", "manual"] {
            assert_eq!(
                parse_wxss_word_break(source),
                Ok(WxssWordBreak::Unsupported(source.into()))
            );
        }
        for source in ["justify", "justify-all", "match-parent"] {
            assert_eq!(
                parse_wxss_text_align(source),
                Ok(WxssTextAlign::Unsupported(source.into()))
            );
        }
        assert_eq!(
            parse_wxss_text_direction("rtl"),
            Ok(WxssTextDirection::Unsupported("rtl".into()))
        );
        for source in [
            "embed",
            "isolate",
            "bidi-override",
            "isolate-override",
            "plaintext",
        ] {
            assert_eq!(
                parse_wxss_unicode_bidi(source),
                Ok(WxssUnicodeBidi::Unsupported(source.into()))
            );
        }
    }

    #[test]
    fn parses_font_lengths_as_single_css_numeric_tokens() {
        for (source, value, unit) in [
            ("  +1.25E+1PX\n", 12.5, WxssTextLengthUnit::Px),
            (".5rPx", 0.5, WxssTextLengthUnit::Rpx),
            ("1e-1em", 0.1, WxssTextLengthUnit::Em),
            ("2REM", 2.0, WxssTextLengthUnit::Rem),
            ("1e2%", 100.0, WxssTextLengthUnit::Percent),
            ("12pt", 12.0, WxssTextLengthUnit::Pt),
            ("2.54cm", 2.54, WxssTextLengthUnit::Cm),
            ("25.4mm", 25.4, WxssTextLengthUnit::Mm),
            ("40Q", 40.0, WxssTextLengthUnit::Q),
            ("1in", 1.0, WxssTextLengthUnit::In),
            ("1pc", 1.0, WxssTextLengthUnit::Pc),
            ("2vw", 2.0, WxssTextLengthUnit::Vw),
            ("3vh", 3.0, WxssTextLengthUnit::Vh),
            ("4vmin", 4.0, WxssTextLengthUnit::Vmin),
            ("5vmax", 5.0, WxssTextLengthUnit::Vmax),
            ("-0", 0.0, WxssTextLengthUnit::Px),
            ("0e-999px", 0.0, WxssTextLengthUnit::Px),
        ] {
            assert_eq!(
                parse_wxss_font_size(source),
                Ok(WxssFontSize::Length(WxssTextLength { value, unit })),
                "{source}"
            );
        }
        assert_eq!(parse_wxss_font_size("MEDIUM"), Ok(WxssFontSize::Initial));
        assert_eq!(parse_wxss_font_size("initial"), Ok(WxssFontSize::Initial));
        assert_eq!(parse_wxss_font_size("InHerit"), Ok(WxssFontSize::Inherit));
        assert_eq!(parse_wxss_font_size("unset"), Ok(WxssFontSize::Unset));
    }

    #[test]
    fn line_height_keeps_multipliers_distinct_from_lengths() {
        assert_eq!(parse_wxss_line_height("Normal"), Ok(WxssLineHeight::Normal));
        assert_eq!(
            parse_wxss_line_height("1.25"),
            Ok(WxssLineHeight::Number(1.25))
        );
        assert_eq!(parse_wxss_line_height("0"), Ok(WxssLineHeight::Number(0.0)));
        assert_eq!(
            parse_wxss_line_height("1E-1"),
            Ok(WxssLineHeight::Number(0.1))
        );
        assert_eq!(
            parse_wxss_line_height("100%"),
            Ok(WxssLineHeight::Length(WxssTextLength {
                value: 100.0,
                unit: WxssTextLengthUnit::Percent,
            }))
        );
        assert_eq!(
            parse_wxss_line_height("0px"),
            Ok(WxssLineHeight::Length(WxssTextLength {
                value: 0.0,
                unit: WxssTextLengthUnit::Px,
            }))
        );
        assert_eq!(
            parse_wxss_line_height("initial"),
            Ok(WxssLineHeight::Initial)
        );
        assert_eq!(
            parse_wxss_line_height("inherit"),
            Ok(WxssLineHeight::Inherit)
        );
        assert_eq!(parse_wxss_line_height("unset"), Ok(WxssLineHeight::Unset));
    }

    #[test]
    fn rejects_invalid_numbers_units_and_incomplete_function_tokens() {
        for source in [
            "",
            " ",
            "-1px",
            "-2%",
            "-1",
            "NaN",
            "NaNpx",
            "inf",
            "infinitypx",
            "1e999px",
            "-1e-99px",
            "1e-99px",
            "-1e-999px",
            "1e-999px",
            "1e-99",
            "1e-999",
            "1 px",
            "1\tpx",
            "1e+ px",
            "1.px",
            "1.e2px",
            ".px",
            "1e+px",
            "1e--2px",
            "1e2.5px",
            "1bananas",
            "1e2 px",
            "++1px",
            "--1px",
            "2px 3px",
            "100%%",
            "auto",
            "normal",
            "\u{a0}12px",
            "garbage(10px)",
            "calc()",
            "calc(1px",
            "calc(1px))",
            "calc(1px) 2px",
            "calc (1px)",
            "var(--size)garbage(1)",
            "var()",
            "calc([1px))",
            "calc(1px;2px)",
        ] {
            assert!(parse_wxss_font_size(source).is_err(), "font-size: {source}");
        }
        for source in [
            "-1",
            "medium",
            "-1em",
            "1 px",
            "NaN",
            "1e999",
            "garbage(1)",
            "-1e-99",
            "1e-99",
            "-1e-999",
            "1e-999",
        ] {
            assert!(
                parse_wxss_line_height(source).is_err(),
                "line-height: {source}"
            );
        }
        assert!(parse_wxss_font_size("1").is_err());
        assert!(parse_wxss_font_size("1.2").is_err());
    }

    #[test]
    fn retains_valid_deferred_or_unimplemented_values_for_explicit_runtime_failure() {
        for source in [
            "calc(1em + 2px)",
            "VAR(--font, 10px)",
            "clamp(10px, 2vw, 20px)",
            "env(font-size)",
            "attr(data-font type(<length>), 12px)",
            "2ch",
            "1svh",
            "revert",
            "revert-layer",
            "smaller",
            "xx-large",
            "math",
        ] {
            assert_eq!(
                parse_wxss_font_size(source),
                Ok(WxssFontSize::Unsupported(source.into())),
                "{source}"
            );
        }
        for source in ["calc(100% + 2px)", "var(--line)", "2lh", "revert-layer"] {
            assert_eq!(
                parse_wxss_line_height(source),
                Ok(WxssLineHeight::Unsupported(source.into())),
                "{source}"
            );
        }
    }

    #[test]
    fn deferred_functions_validate_numeric_types_and_substitution_grammar() {
        for invalid in [
            "calc(red)",
            "calc(1px + red)",
            "calc(1px+2px)",
            "calc(1px +2px)",
            "calc(1px + 2)",
            "calc(1px * 1px)",
            "calc(1px / 1s)",
            "min(1px, 2)",
            "max()",
            "clamp(1px, 2px)",
            "round(1px, 2)",
            "round(1px)",
            "round(up, 1px)",
            "var(12)",
            "var(--)",
            "var(--x garbage)",
            "env(12)",
            "env(safe-area-inset-top -1)",
            "attr(12)",
            "attr(data-font garbage)",
            "pow(1px, 2)",
            "sin(1px)",
            "sign(1px)",
            "calc(0)",
        ] {
            assert!(parse_wxss_font_size(invalid).is_err(), "{invalid}");
        }
        for valid in [
            "calc((1em + 2px) * 2)",
            "calc(1px * 1px / 1px)",
            "calc(1s / 1s * 1px)",
            "min(10px, 2em, 100%)",
            "clamp(10px, 20%, 30px)",
            "calc(sin(45deg) * 1px)",
            "calc(var(--font) * 1px)",
            "abs(-1px)",
            "calc(0px)",
            "env(safe-area-inset-top, 12px)",
            "env(viewport-segment-width 0 0)",
            "var(--font, red)",
            "attr(data-font type(<length>), 12px)",
            "round(1px, .5px)",
        ] {
            assert_eq!(
                parse_wxss_font_size(valid),
                Ok(WxssFontSize::Unsupported(valid.into())),
                "{valid}"
            );
        }
        for invalid in ["round(1px)", "round(up, 1px)"] {
            assert!(parse_wxss_line_height(invalid).is_err(), "{invalid}");
        }
        for valid in [
            "calc(1.2)",
            "sign(-1px)",
            "max(1, 2)",
            "round(1.5)",
            "round(UP, 1.5)",
        ] {
            assert_eq!(
                parse_wxss_line_height(valid),
                Ok(WxssLineHeight::Unsupported(valid.into())),
                "{valid}"
            );
        }
        let nested = format!("{}1px{}", "calc(".repeat(70), ")".repeat(70));
        assert!(parse_wxss_font_size(&nested).is_err());
    }
}
