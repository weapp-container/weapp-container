#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct WeappContainerFfiBuffer {
    uint8_t* data;
    size_t len;
} WeappContainerFfiBuffer;

/* Initialize output to {NULL, 0}; release every non-empty result with
 * weapp_container_harmony_buffer_free before reusing it. */

enum {
    WEAPP_CONTAINER_FFI_OK = 0,
    WEAPP_CONTAINER_FFI_ERR = -1,
    WEAPP_CONTAINER_FFI_INVALID_ARGUMENT = -2,
};

void* weapp_container_harmony_host_new(void);
void weapp_container_harmony_host_free(void* host);
/* Releases the session but keeps the handle reusable; repeated calls succeed.
 * Dispatch lifecycle "unload" first when user lifecycle hooks must run. */
int32_t weapp_container_harmony_host_unload(void* host);
int32_t weapp_container_harmony_host_capabilities(const void* host, WeappContainerFfiBuffer* output);
/* Additive host-services 1.0 command lane. Invoke only on the runtime owner;
 * callbacks queue records and wait for the ArkTS drain to enter this lane. */
int32_t weapp_container_harmony_host_services_json(void* host, const uint8_t* command, size_t command_len, WeappContainerFfiBuffer* output);
int32_t weapp_container_harmony_host_load_manifest(void* host, const uint8_t* data, size_t len);
/* SessionConfig uses engine/session_id/host keys. Unavailable engines fail
 * explicitly with error.code ERR_ENGINE; invalid input preserves the session.
 * Success returns OK with an empty output; failure returns structured JSON. */
int32_t weapp_container_harmony_host_load_manifest_with_config(void* host,
                               const uint8_t* manifest, size_t manifest_len,
                               const uint8_t* config, size_t config_len,
                               WeappContainerFfiBuffer* output);
/* Debug-only page data observation; does not execute JS or transfer pixels. */
int32_t weapp_container_harmony_host_inspect_state(const void* host, WeappContainerFfiBuffer* output);
/* Logical CSS-pixel geometry, retaining the live session. Returns a bridge
 * batch of resize hooks; the owner commits/presents the subsequent frame. */
int32_t weapp_container_harmony_host_resize_viewport(void* host, uint32_t width, uint32_t height,
                               WeappContainerFfiBuffer* output);
int32_t weapp_container_harmony_host_start(void* host, const uint8_t* request_id, size_t request_id_len,
                               WeappContainerFfiBuffer* output);
int32_t weapp_container_harmony_host_lifecycle(void* host,
                               const uint8_t* request_id, size_t request_id_len,
                               const uint8_t* event, size_t event_len,
                               WeappContainerFfiBuffer* output);
int32_t weapp_container_harmony_host_dispatch_json(void* host, const uint8_t* data, size_t len,
                                       WeappContainerFfiBuffer* output);
int32_t weapp_container_harmony_host_dispatch_batch_json(void* host, const uint8_t* data, size_t len,
                                             WeappContainerFfiBuffer* output);
int32_t weapp_container_harmony_host_render_snapshot(void* host, WeappContainerFfiBuffer* output);
int32_t weapp_container_harmony_host_attach_gles_context(void* host, WeappContainerFfiBuffer* output);
int32_t weapp_container_harmony_host_render_gles_framebuffer(void* host, uint32_t framebuffer,
                                                 uint32_t width, uint32_t height,
                                                 WeappContainerFfiBuffer* output);
int32_t weapp_container_harmony_host_detach_gles_context(void* host, WeappContainerFfiBuffer* output);
/* Lost-context fallback: drops Skia ownership without GL calls. Normal detach
 * requires the owned EGL context current. Feature-disabled builds return ERR. */
int32_t weapp_container_harmony_host_abandon_gles_context(void* host);
int32_t weapp_container_harmony_host_canvas_snapshot(void* host, const uint8_t* canvas_id,
                                         size_t canvas_id_len, WeappContainerFfiBuffer* output);
/* now_ns is Unix-epoch nanoseconds, not uptime or session-relative time. */
int32_t weapp_container_harmony_host_poll_timers(void* host, uint64_t now_ns, WeappContainerFfiBuffer* output);
int32_t weapp_container_harmony_host_acknowledge_presentation(void* host, uint64_t revision, WeappContainerFfiBuffer* output);
void weapp_container_harmony_buffer_free(WeappContainerFfiBuffer* buffer);

#ifdef __cplusplus
}
#endif
