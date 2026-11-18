#pragma once

#include <stddef.h>
#include <stdint.h>

typedef struct WeappContainerFfiBuffer {
    uint8_t* data;
    size_t len;
} WeappContainerFfiBuffer;

/* Initialize output to {NULL, 0}; release every non-empty result with
 * weapp_container_ios_buffer_free before reusing it. */

enum {
    WEAPP_CONTAINER_FFI_OK = 0,
    WEAPP_CONTAINER_FFI_ERR = -1,
    WEAPP_CONTAINER_FFI_INVALID_ARGUMENT = -2,
};

void* weapp_container_ios_host_new(void);
void weapp_container_ios_host_free(void* host);
/* Idempotently release the runtime; retain the reusable host handle. Send
 * app.lifecycle(unload) first when user lifecycle hooks must run. */
int32_t weapp_container_ios_host_unload(void* host);
int32_t weapp_container_ios_host_capabilities(const void* host, WeappContainerFfiBuffer* output);
/* Lightweight schemaVersion/sessionId/viewport/page/frameId; no tree/pixels. */
int32_t weapp_container_ios_host_session_state(const void* host, WeappContainerFfiBuffer* output);
int32_t weapp_container_ios_host_acknowledge_presentation(void* host, uint64_t revision, WeappContainerFfiBuffer* output);
/* Development-only whole-page observation; no engine calls or pixel data. */
int32_t weapp_container_ios_host_inspect_state(const void* host, WeappContainerFfiBuffer* output);
/* Logical viewport size; returns one hook batch without committing a frame. */
int32_t weapp_container_ios_host_resize_viewport(void* host, uint32_t width, uint32_t height,
    WeappContainerFfiBuffer* output);
int32_t weapp_container_ios_host_load_manifest(void* host, const uint8_t* data, size_t len);
/* Explicit engine/session selection; JSON configuration is SessionConfig.
 * A failed load returns a JSON error in output, never a fallback engine. */
int32_t weapp_container_ios_host_load_manifest_with_config(void* host,
    const uint8_t* data, size_t len, const uint8_t* config, size_t config_len,
    WeappContainerFfiBuffer* output);
int32_t weapp_container_ios_host_start(void* host, const uint8_t* request_id, size_t request_id_len,
                           WeappContainerFfiBuffer* output);
int32_t weapp_container_ios_host_dispatch_json(void* host, const uint8_t* data, size_t len,
                                   WeappContainerFfiBuffer* output);
int32_t weapp_container_ios_host_dispatch_batch_json(void* host, const uint8_t* data, size_t len,
                                         WeappContainerFfiBuffer* output);
int32_t weapp_container_ios_host_render_snapshot(void* host, WeappContainerFfiBuffer* output);
/* Direct Skia Ganesh Metal path. The pointers are retained Objective-C
 * MTLDevice/MTLCommandQueue/MTLTexture objects owned by the Swift caller. */
int32_t weapp_container_ios_host_attach_metal_context(void* host, const void* device,
                                          const void* queue);
int32_t weapp_container_ios_host_render_metal_texture(void* host, const void* texture,
                                          uint32_t width, uint32_t height);
int32_t weapp_container_ios_host_detach_metal_context(void* host);
int32_t weapp_container_ios_host_canvas_snapshot(void* host, const uint8_t* canvas_id,
                                     size_t canvas_id_len, WeappContainerFfiBuffer* output);
/* now_ns uses Unix-epoch nanoseconds, not display-link uptime. */
int32_t weapp_container_ios_host_poll_timers(void* host, uint64_t now_ns, WeappContainerFfiBuffer* output);
void weapp_container_ios_buffer_free(WeappContainerFfiBuffer* buffer);
