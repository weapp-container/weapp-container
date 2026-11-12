<a id="受管同步文件句柄的实现范围"></a>
# Scope of Implementation for Managed Synchronous File Handles

[简体中文](synchronous-file-descriptors.md) · **English**


This batch completes the actual native std::fs implementation for `openSync`, `closeSync`, `readSync`, `writeSync`, `fstatSync`, `ftruncateSync`, and `truncateSync`. Public calls route through FileSystemManager → shared sync facade → sealed native transport → ManagedSyncFileSystem. Standard input is locked to miniprogram-api-typings 5.2.3; asynchronous UI or cache writes are not spoofed as synchronous persistence.

Each execution owner independently generates an opaque fd string, up to 64 at a time, without exposing OS fd or actual paths.
All read/write operations share the same disk transaction lock with the native async adapter; write/truncate operations are synchronized and flushed to disk, and creation is synchronized to the parent directory. FDs belonging to closed or other owners are rejected; during normal retirement, all admitted synchronous calls are emptied and all file handles are released. Retire panic from custom providers is isolated, errors are retained in the explicit termination channel, and subsequent business calls are continuously rejected; resource failures are not counted as cleanup success. Custom providers must not re-enter the same binding within their synchronous invoke/retire.

readSync supports target buffer offset, read length, EOF short reads, and position; explicit position keeps the file pointer unchanged, while omission advances the current pointer. The returned arrayBuffer is the same instance as the one passed in by the caller.
writeSync supports UTF-8 text and ArrayBuffer range writes; text length is reported in bytes. append flags always write at the end of the file, and explicit position does not alter the subsequent file pointer. truncate shortens or extends the real file, with extended regions zero-filled. Synchronous FileSystemManager removes duplicate args from named payload to avoid double budgeting of the same ArrayBuffer.

<a id="显式限制与未验收项"></a>
## Explicit Limits and Unaccepted Items

- Available only when the managed_files_root lease is configured for native SDK and bound to a sync provider.
  Web/Worker currently lacks a corresponding sync persistence layer; this implementation is not considered.
- Each binary/UTF-8 chunk can be up to 1 MiB; the original scope quota is 32 MiB. Handle opening still retains a conservative byte reservation based on the current file length, limiting access to files that are renamed or unlinked; multiple handles for the same file result in repeated reservations, which are released upon close. This reservation only counts live handles from the current provider; there is currently no unified, isolated inode ledger when sharing the same directory across owners or across processes; therefore, it cannot be claimed that the total physical usage across all owners adheres to a hard quota. A shared registry or unified file service is required for future support.
- Currently only UTF-8 text encoding is accepted; other missing features include locked encoding, recursive stat, asynchronous fd peer interfaces, compression/zip, and others. This batch is not elevated to a complete FileSystemManager.
- Limited testing of native lifecycle/file operations and real QuickJS/V8 environments does not replace SDKs' new archive installations, multi-end system permissions, physical device access, or release acceptance.
