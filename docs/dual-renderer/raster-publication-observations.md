# Borrowed Raster publication facts

`WebFrameReservation::identity()` borrows a `CapturedWebFrameIdentity` created
inside the real capacity reservation critical section. Its fields are private;
there is no public constructor, `Clone`, `Serialize` or `Deserialize`. Session,
selected transport frame sequence, configuration generation, logical viewport,
physical size and the one shared preview epoch are captured from typed reserve
inputs and the actual store state, before encoding JSON output. No identity
field is reconstructed from a `Value` or the latest UI settings.

The identity keeps only a Weak allocation pin, not another state owner.
`belongs_to` checks that actual allocation, so equal-valued independent stores
are distinct and cloned handles remain equivalent. It acquires no mutex. The
new bounded session allocation and identity metadata are charged in the original
64 MiB capacity claim; reservation count, frame cap and all existing queue and
lease bounds are unchanged. Reading identity consumes no sequence or epoch.

These are captured candidate facts, not a current preview lease or a Session
page proof. A target session/configuration is the publication selected by the
real reservation; runtime validation must still compare it to the actual
Session. Callers must separately revalidate live `PreviewOwnerFence` authority
and current page/configuration before final acceptance. An accessor cannot
refresh a stale reservation, and final prepared-store checks remain mandatory.
No new HTTP/CLI admission, strict Raster policy, SSE token, ticket wire format
or browser behavior is enabled.

`PreparedDevRasterPresentation::accepted_page_observation()` borrows the same
accepted frame, physical target and already materialized pixels validated for
its ticket. It reuses the passive `AcceptedPageObservation` builder and splits
borrows of existing renderer and presentation-state fields. No Session, renderer
or frame owner is created, no pixel buffer is cloned, and no readback or View
execution occurs. The existing mutable Session preparation borrow pins these
references until candidate acceptance or drop; no second Session lookup is
needed while encoding the transport. The observation grants no ready/input or
browser presentation acknowledgment.

Source tests exercise actual reservation/publication identities, independent
stores and handle clones, stale competing publication, exact accepted frame
and pixel pointers, and a real QuickJS/V8 runtime-ticket plus Web-reservation
consumer that prepares transport from borrowed candidate pixels while the
Session remains exclusively borrowed. Publication still leaves input unready
until an exact runtime ticket acknowledgment. These are test definitions only
until the root integration lane compiles and executes them.

This source change does not modify page-frame acceptance or copy over the
root's Option idiom repair. The known raw C5 document Option replacement and
all previously disclosed lock/lifetime/strict-Web integration gaps remain
separate integration work.
