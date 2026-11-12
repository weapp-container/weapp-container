use super::{V8Config, V8Engine};
use container_core::{CallTarget, JsEngine};

#[test]
fn external_native_termination_retires_the_retained_byte_owner_on_error_return() {
    let mut engine = V8Engine::new(V8Config::default());
    engine
        .set_capabilities(&std::collections::BTreeMap::from([
            ("wx.createBufferURL".into(), "full".into()),
            ("wx.revokeBufferURL".into(), "full".into()),
        ]))
        .unwrap();
    let module = engine
        .load_module(br#"exports.make=()=>wx.createBufferURL(new Uint8Array([0,128,255]));exports.spin=()=>{while(true){}};"#)
        .unwrap();
    let url = engine
        .call(
            CallTarget::Module {
                id: module,
                export: "make".into(),
            },
            vec![],
        )
        .unwrap()
        .remove(0)
        .as_str()
        .unwrap()
        .to_owned();
    let store = engine.buffer_url_store().unwrap();
    assert_eq!(&*store.resolve(&url).unwrap(), &[0, 128, 255]);
    let handle = engine.native.as_ref().unwrap().isolate.thread_safe_handle();
    let terminator = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(10));
        assert!(handle.terminate_execution());
    });
    assert!(engine
        .call(
            CallTarget::Module {
                id: module,
                export: "spin".into()
            },
            vec![]
        )
        .is_err());
    terminator.join().unwrap();
    // No Session retirement, subsequent engine call or engine Drop may hide
    // whether native termination itself retired the published byte owner.
    assert!(store.resolve(&url).is_err());
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&store.invoke_json("create", "00")).unwrap()
            ["ok"],
        false
    );
}
