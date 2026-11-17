#![cfg(all(feature = "quickjs-native", not(target_arch = "wasm32")))]

use container_core::{
    ViewEngine, ViewEngineErrorCode, ViewExecutionBudget, ViewExpressionTask, ViewModuleSource,
};
use container_engine_quickjs::{QuickJsConfig, QuickJsViewEngine};
use std::{
    collections::BTreeMap,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const CHILD: &str = "WEAPP_VIEW_DEADLINE_CHILD";

// The host may choose a larger finite batch allowance without disabling the
// VM interrupt or allowing a partially initialized View realm to run again.
#[test]
fn explicit_view_allowance_retains_interrupt_and_realm_retirement() {
    if std::env::var_os(CHILD).is_some() {
        let mut view = QuickJsViewEngine::new(QuickJsConfig::default()).unwrap();
        let budget = ViewExecutionBudget::new(Duration::from_millis(250));
        view.load_modules(
            &[ViewModuleSource {
                compilation: None,
                id: "wxs:loop.wxs".into(),
                source: "exports.run=function(){while(true){}}".into(),
                dependencies: vec![],
            }],
            &budget,
        )
        .unwrap();
        let task = ViewExpressionTask {
            task_id: "loop".into(),
            scope_id: "page:1".into(),
            document_id: "pages/index.wxml".into(),
            expression: "tools.run()".into(),
            data: serde_json::json!({}),
            bindings: BTreeMap::from([("tools".into(), "wxs:loop.wxs".into())]),
        };
        assert_eq!(
            view.evaluate_batch(&[task], &budget).unwrap_err().code,
            ViewEngineErrorCode::Timeout
        );
        assert_eq!(
            view.evaluate_batch(&[], &budget).unwrap_err().code,
            ViewEngineErrorCode::RequiresReset
        );
        view.reset().unwrap();
        view.load_modules(&[], &budget).unwrap();
        return;
    }

    // Bound the test itself independently of the VM behavior under test.
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "explicit_view_allowance_retains_interrupt_and_realm_retirement",
            "--nocapture",
        ])
        .env(CHILD, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stop = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            let output = child.wait_with_output().unwrap();
            assert!(
                status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            break;
        }
        if Instant::now() >= stop {
            child.kill().unwrap();
            let output = child.wait_with_output().unwrap();
            panic!(
                "View deadline exceeded external watchdog: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
