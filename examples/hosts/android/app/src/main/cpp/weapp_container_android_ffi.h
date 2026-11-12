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
 * weapp_container_android_buffer_free before reusing it. */

enum {
    WEAPP_CONTAINER_FFI_OK = 0,
    WEAPP_CONTAINER_FFI_ERR = -1,
    WEAPP_CONTAINER_FFI_INVALID_ARGUMENT = -2,
};

void* weapp_container_android_host_new(void);
void weapp_container_android_host_free(void* host);
int32_t weapp_container_android_host_capabilities(const void* host, WeappContainerFfiBuffer* output);
int32_t weapp_container_android_host_load_manifest(void* host, const uint8_t* data, size_t len);
int32_t weapp_container_android_host_load_manifest_with_config(void* host, const uint8_t* data, size_t len,
                                                            const uint8_t* config, size_t config_len,
                                                            WeappContainerFfiBuffer* output);
int32_t weapp_container_android_host_start(void* host, const uint8_t* request_id, size_t request_id_len,
                               WeappContainerFfiBuffer* output);
int32_t weapp_container_android_host_dispatch_json(void* host, const uint8_t* data, size_t len,
                                       WeappContainerFfiBuffer* output);
int32_t weapp_container_android_host_dispatch_batch_json(void* host, const uint8_t* data, size_t len,
                                             WeappContainerFfiBuffer* output);
int32_t weapp_container_android_host_render_snapshot(void* host, WeappContainerFfiBuffer* output);
/* Normal presentation metadata; never creates a page raster/readback. */
int32_t weapp_container_android_host_presentation_state(const void* host, WeappContainerFfiBuffer* output);
int32_t weapp_container_android_host_acknowledge_presentation(void* host, uint64_t revision, WeappContainerFfiBuffer* output);
int32_t weapp_container_android_host_canvas_snapshot(void* host, const uint8_t* canvas_id,
                                         size_t canvas_id_len, WeappContainerFfiBuffer* output);
#ifdef WEAPP_CONTAINER_ANDROID_SKIA_GPU_GLES
int32_t weapp_container_android_host_attach_gles_context(void* host);
int32_t weapp_container_android_host_render_gles_framebuffer(void* host, uint32_t framebuffer,
                                                 uint32_t width, uint32_t height);
int32_t weapp_container_android_host_detach_gles_context(void* host);
/* Context-loss cleanup; does not require a current EGL context. */
int32_t weapp_container_android_host_abandon_gles_context(void* host);
#endif
int32_t weapp_container_android_host_poll_timers(void* host, uint64_t now_ns, WeappContainerFfiBuffer* output);
int32_t weapp_container_android_host_resize_viewport(void* host, uint32_t width, uint32_t height, WeappContainerFfiBuffer* output);
int32_t weapp_container_android_host_update_window_metrics_json(void* host, const uint8_t* data,
                                                              size_t len, WeappContainerFfiBuffer* output);
int32_t weapp_container_android_host_inspect_state(void* host, WeappContainerFfiBuffer* output);
void weapp_container_android_buffer_free(WeappContainerFfiBuffer* buffer);

#ifdef __cplusplus
}
#endif
