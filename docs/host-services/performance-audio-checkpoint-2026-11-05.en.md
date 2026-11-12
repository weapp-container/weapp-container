<a id="性能和内音频源检查点--2026-11-05"></a>
# Performance and InnerAudio source checkpoint — 2026-11-05

[简体中文](performance-audio-checkpoint-2026-11-05.md) · **English**


Code commit: `77cb95cad79f582f646f443df417e893f368cea1`.

This checkpoint integrates the private Performance/module owner and runtime-owned InnerAudio listener removal from baseline `d3561c11a45ab25a113bd8d689abdd00963e86b9`.

Performance samples now come from retained native module/App entry points, with private module records, independent member admission, copied query snapshots and a native lifetime fence. Replacing diagnostic globals cannot create trusted samples or revive a retired owner. Exact producer, metadata, timing and fixed-WeChat parity gaps remain open; query rows remain Partial.

InnerAudio off methods remove the actual private subscription owner and cancel its creator before acknowledgement. Legacy SDK off declarations are accepted only for capability negotiation and never installed as native dispatch handlers. Destroy closes its callback receiver immediately; failed destroy keeps the native factory for later retirement without reopening listeners. Valid repeated typed retirement acknowledges absence; malformed object IDs remain rejected. Runtime-owned off keys publish Unsupported when the pack does not grant them.

The matrix update refreshes reviewed source identities and 84 Performance source/scope cells. All 8,855 implementation states and acceptance states are unchanged: 1,777 Available, 1,308 Partial, 86 RequiresHostService, 5,684 Missing; accepted 0 and platform-not-applicable 87. InnerAudio retains its existing 26 Available and 44 Missing cells. The proposed additional Audio credit is deferred.

Validation results and exact commands are recorded in [the checkpoint evidence](../archived-evidence.en.md). The final Node owner/audio suite passed 304 tests, the bootstrap/scheduler suite passed 570, the inventory/matrix suite passed 1,284, and real QuickJS/V8 Session integration passed 11 InnerAudio and 5 Performance tests. The five native capability policy tests and formatting passed. Node VM tests are composition evidence; native Session tests are engine evidence. This checkpoint adds no installed SDK/device/browser or WeChat oracle acceptance. The broader implementation goal remains paused.
