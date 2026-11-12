//! External embedding consumer: this must compile without access to private
//! queue entries, connection admissions or the simulator's internal modules.
use container_simulator::web::{QueuedBridgeRequest, WebSurface};

#[test]
fn external_preview_request_literal_remains_compatible_with_public_validation() {
    let request = QueuedBridgeRequest {
        body: br#"{}"#.to_vec(),
        preview: None,
    };
    let surface = WebSurface::localhost(0).unwrap();
    assert!(surface.handle().validate_preview_request(&request).is_ok());
    assert_eq!(request.body, br#"{}"#);
    assert!(request.preview.is_none());
}
