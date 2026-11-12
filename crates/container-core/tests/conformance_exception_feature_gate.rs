use container_core::app_service_environment_bootstrap;
#[cfg(not(feature = "conformance-observation"))]
#[test]
fn normal_core_bootstrap_has_no_exception_journal_or_request_endpoint() {
    let source = app_service_environment_bootstrap("");
    assert!(source.contains("const __container_conformance_exceptions = null;"));
    assert!(source.contains("const __container_conformance_runtime_logs = null;"));
    assert!(!source.contains("function snapshot(reset)"));
    assert!(!source.contains("realm-exceptions-1"));
    assert!(!source.contains("kind\") === \"conformance-exceptions"));
    assert!(!source.contains("function record(message)"));
}
#[cfg(feature = "conformance-observation")]
#[test]
fn observation_bootstrap_includes_private_journal_and_retained_transport() {
    let source = app_service_environment_bootstrap("");
    assert!(source.contains("const __container_conformance_exceptions = (function()"));
    assert!(source.contains("realm-exceptions-1"));
    assert!(source.contains("const __container_conformance_runtime_logs = (function()"));
    assert!(!source.contains("globalThis.__container_conformance_runtime_logs ="));
    assert!(source.contains("return __container_conformance_exceptions.capture"));
    assert!(!source.contains("globalThis.__container_conformance_exceptions ="));
}
