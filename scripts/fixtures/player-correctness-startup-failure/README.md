# Candidate startup failure input

Copy the correctness fixture to a task-owned temporary project, replace only its
`app.js` with this file and let the existing development watcher publish it.
The onLaunch error is explicit and deterministic. Preserve the original project
and accepted generation. This file is outside the normal fixture build so it
cannot accidentally execute in the healthy pack. A rejected candidate must not
replace the accepted instance, storage owner or presentation authority. Capture
the actual typed error/attempt receipt, restore the healthy source and verify
recovery through Player UI. This input alone establishes no E2E result.
