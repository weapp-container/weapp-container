//! Replay auxiliary Chrome CSS.supports observations, not WeChat truth.
//!
//! `Unsupported` is accepted syntax here. This test does not establish runtime
//! execution, WeChat DevTools parity, host rendering or inheritance behavior.

use container_ir::{parse_wxss_font_size, parse_wxss_line_height};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChromeCorpus {
    schema_version: u32,
    boundary: String,
    user_agent: String,
    cases: Vec<ChromeSyntaxCase>,
    // The original inheritance observations remain in the fixture as context.
    // They belong to runtime tests and are deliberately not replayed by the
    // IR's property-value grammar test.
    inherited: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct ChromeSyntaxCase {
    property: String,
    value: String,
    accepted: bool,
}

#[test]
fn auxiliary_chrome_css_supports_corpus_replays_syntax_without_wechat_parity_claim() {
    let corpus: ChromeCorpus =
        serde_json::from_str(include_str!("fixtures/text-values-chrome.json")).unwrap();
    assert_eq!(corpus.schema_version, 1);
    assert_eq!(corpus.cases.len(), 66);
    assert!(corpus.boundary.contains("Auxiliary Chrome"));
    assert!(corpus.boundary.contains("not WeChat DevTools"));
    assert!(corpus.user_agent.contains("HeadlessChrome/155."));
    assert_eq!(corpus.inherited.len(), 6);

    for case in corpus.cases {
        let accepted_syntax = match case.property.as_str() {
            "font-size" => parse_wxss_font_size(&case.value).is_ok(),
            "line-height" => parse_wxss_line_height(&case.value).is_ok(),
            unexpected => panic!("unexpected Chrome corpus property: {unexpected}"),
        };
        assert_eq!(
            accepted_syntax, case.accepted,
            "auxiliary Chrome syntax observation: {}: {}",
            case.property, case.value
        );
    }
}
