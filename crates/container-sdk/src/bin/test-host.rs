//! One owner thread, one session, bounded JSONL messages. stdout is protocol only.
use container_sdk::testing::TestSession;
use serde_json::{json, Value};
use std::io::{self, BufRead, Read, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut session = TestSession::new()?;
    let mut output = io::BufWriter::new(io::stdout().lock());
    writeln!(
        output,
        "{}",
        json!({"protocolVersion":1,"engine":"quickjs","testing":true})
    )?;
    output.flush()?;
    let mut input = io::stdin().lock();
    loop {
        let mut line = String::new();
        let read = input
            .by_ref()
            .take(8 * 1024 * 1024 + 1)
            .read_line(&mut line)?;
        if read == 0 {
            session.command("close", json!({}))?;
            break;
        }
        if read > 8 * 1024 * 1024 {
            return Err("RPC input exceeds 8 MiB".into());
        }
        let request: Value = serde_json::from_str(&line)?;
        let operation = request["method"].as_str().unwrap_or("");
        let result = session.command(
            operation,
            request.get("params").cloned().unwrap_or(json!({})),
        );
        let response = match result {
            Ok(value) => json!({"id":request["id"],"result":value,"events":session.take_events()}),
            Err(error) => json!({"id":request["id"],"error":error,"events":session.take_events()}),
        };
        writeln!(output, "{response}")?;
        output.flush()?;
        if operation == "close" {
            break;
        }
    }
    Ok(())
}
