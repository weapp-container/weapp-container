<a id="eventchannel-与-console-分组的实现范围"></a>
# Implementation Scope of EventChannel and Console Grouping

[简体中文](event-channel-implementation-scope.md) · **English**


The four methods `emit`, `on`, `once`, `off` of EventChannel are real-time synchronous calls within the AppService realm, and function and object references do not cross the native JSON transport. Events of wx.navigateTo are registered on the launch page; the navigation success/Promise result and the opener event channel returned by the target page use the same channel. An EmptyEventChannel is returned when no opener exists. Both Page and Component instances are equipped with public getters.

Channels are bound to the original engine request ID and the actual target page instance before onLoad; immediate
Both the immediate and trusted-page-mirror delayed submission paths have been integrated. Multiple instances of the same route maintain independence.
The binding function is a private native handle returned by bootstrap and captured by QuickJS/V8; guest global functions with the same name will not overwrite it. Channels are closed when either the target page or the originating page is unloaded, and retained channel handles reject subsequent calls. Failure to clean up observers does not bypass channel closure, and existing unloading errors are preserved.

Each realm can have at most 256 live channels, each channel can have up to 128 listeners and 64 unacknowledged events per emit. Each emit can have up to 32 parameters, with a recursion depth limit of 64. once is retired before invocation, supports recursion, off, and event caching during registration. Private indexes/arrays and captured built-in functions do not depend on guest prototypes. Serialization is completed before channel allocation; failed wire/Promise/enqueue does not retain pending or live channel quotas. Over-quota failures are explicitly failed.

Console group/groupEnd Use existing opt-in diagnostics queue, preserve groups and indentation across drain, with a hierarchy limit of 32; clear state after diagnostics are disabled. The queue remains subject to original count/character backpressure budget limits, does not perform attribute getter or user JSON hook, and does not act as a fictive implementation of LogManager/real-time logging service.

Runtime=runtime, host=host, session=session, frame=frame, receipt=receipt, acceptance=acceptance, surface=surface, presenter=presenter, flush storage=flush storage

Dual-engine primitives, on-the-fly navigation, and limited testing of deferred layout submission cannot replace testing from a publicly available SDK installed from a new archive.
Legacy on-the-fly navigation continues to use existing mutable page table/current setter; full public mirror integrity guarantee
applies only to the trusted-page-mirror deferred path and cannot be generalized to a two-mode scenario based solely on private binder.
No new strict identity/consent capabilities are declared, nor is the API acceptance state elevated.
