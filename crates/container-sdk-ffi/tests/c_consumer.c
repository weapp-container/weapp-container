#include "weapp_container_sdk.h"
#include "weapp_container_sdk_gl.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static void consume(weapp_container_sdk_buffer *result, const char *expected) {
  assert(result->data != NULL && result->len > 0);
  if (expected != NULL) {
    int found = 0;
    size_t n = strlen(expected);
    for (size_t i = 0; i + n <= result->len; ++i) {
      if (memcmp(result->data + i, expected, n) == 0) found = 1;
    }
    if (!found) fwrite(result->data, 1, result->len, stderr);
    assert(found);
  }
  weapp_container_sdk_buffer_free(result);
  assert(result->data == NULL && result->len == 0);
}

int main(int argc, char **argv) {
  /* Every declaration must resolve against the independently linked library. */
  void (*volatile symbols[])(void) = {
      (void (*)(void))weapp_container_sdk_abi_version,
      (void (*)(void))weapp_container_sdk_version,
      (void (*)(void))weapp_container_sdk_session_new,
      (void (*)(void))weapp_container_sdk_session_command,
      (void (*)(void))weapp_container_sdk_session_close,
      (void (*)(void))weapp_container_sdk_session_destroy,
      (void (*)(void))weapp_container_sdk_buffer_free,
      (void (*)(void))weapp_container_sdk_frame_acquire,
      (void (*)(void))weapp_container_sdk_frame_retain,
      (void (*)(void))weapp_container_sdk_frame_release,
      (void (*)(void))weapp_container_sdk_frame_info,
      (void (*)(void))weapp_container_sdk_gles_attach,
      (void (*)(void))weapp_container_sdk_gles_present,
      (void (*)(void))weapp_container_sdk_gles_detach,
      (void (*)(void))weapp_container_sdk_gles_abandon,
      (void (*)(void))weapp_container_sdk_gl_attach_with_resolver,
      (void (*)(void))weapp_container_sdk_metal_attach,
      (void (*)(void))weapp_container_sdk_metal_present,
      (void (*)(void))weapp_container_sdk_metal_detach};
  assert(sizeof(symbols) / sizeof(symbols[0]) == 19);
  assert(weapp_container_sdk_abi_version() == WEAPP_CONTAINER_SDK_ABI_VERSION);
  assert(strcmp(weapp_container_sdk_version(), WEAPP_TEST_SDK_VERSION) == 0);

  weapp_container_sdk_session *session = NULL;
  weapp_container_sdk_buffer result = {NULL, 0};
  assert(weapp_container_sdk_session_new((const uint8_t *)"{", 1, &session, &result) == WEAPP_CONTAINER_SDK_ERROR);
  assert(session == NULL);
  uint8_t *occupied = result.data;
  assert(weapp_container_sdk_session_new((const uint8_t *)"{}", 2, &session, &result) == WEAPP_CONTAINER_SDK_INVALID_ARGUMENT);
  assert(session == NULL && result.data == occupied);
  consume(&result, "ERR_CONFIG");
  assert(weapp_container_sdk_session_new((const uint8_t *)"{}", 2, &session, &result) == WEAPP_CONTAINER_SDK_OK);
  assert(session != NULL);
  consume(&result, "\"ok\":true");

  const weapp_container_sdk_frame *frame = NULL;
  assert(weapp_container_sdk_frame_acquire(session, &frame, &result) == WEAPP_CONTAINER_SDK_ERROR);
  assert(frame == NULL);
  consume(&result, "ERR_NO_FRAME");
  assert(weapp_container_sdk_session_command(session, (const uint8_t *)"unknown", 7, (const uint8_t *)"{}", 2, &result) == WEAPP_CONTAINER_SDK_ERROR);
  consume(&result, "\"code\":");

  const weapp_container_sdk_frame *retained = NULL;
  weapp_container_sdk_frame_info_data before = {0};
  uint8_t first_pixel = 0;
  if (argc > 1) {
    /* Explicit ABI fixture observations. A production host must measure its
       display; an empty config must never invent screen dimensions or DPR. */
    const char *metrics = "{\"windowWidth\":375,\"windowHeight\":667,\"screenWidth\":375,\"screenHeight\":667,\"pixelRatio\":1,\"statusBarHeight\":0,\"screenTop\":0,\"deviceOrientation\":\"portrait\"}";
    int32_t metrics_status = weapp_container_sdk_session_command(session,
        (const uint8_t *)"windowMetrics", 13,
        (const uint8_t *)metrics, strlen(metrics), &result);
    if (metrics_status != WEAPP_CONTAINER_SDK_OK) fwrite(result.data, 1, result.len, stderr);
    assert(metrics_status == WEAPP_CONTAINER_SDK_OK);
    consume(&result, "\"ok\":true");
    int32_t status = weapp_container_sdk_session_command(session,
        (const uint8_t *)"load", 4, (const uint8_t *)argv[1], strlen(argv[1]), &result);
    if (status != WEAPP_CONTAINER_SDK_OK) fwrite(result.data, 1, result.len, stderr);
    assert(status == WEAPP_CONTAINER_SDK_OK);
    consume(&result, "\"ok\":true");
    assert(weapp_container_sdk_frame_acquire(session, &frame, &result) == WEAPP_CONTAINER_SDK_OK);
    consume(&result, "\"ok\":true");
    assert(weapp_container_sdk_frame_info(frame, &before, &result) == WEAPP_CONTAINER_SDK_OK);
    consume(&result, "\"ok\":true");
    assert(before.width > 0 && before.height > 0 && before.revision > 0);
    assert(before.stride == before.width * 4 && before.len == before.stride * before.height);
    assert(before.data != NULL);
    first_pixel = before.data[0];
    assert(weapp_container_sdk_frame_retain(frame, &retained, &result) == WEAPP_CONTAINER_SDK_OK);
    consume(&result, "\"ok\":true");
    assert(weapp_container_sdk_frame_release(&frame, &result) == WEAPP_CONTAINER_SDK_OK);
    assert(frame == NULL);
    consume(&result, "\"ok\":true");
  }
  assert(weapp_container_sdk_session_close(session, &result) == WEAPP_CONTAINER_SDK_OK);
  consume(&result, "\"ok\":true");
  assert(weapp_container_sdk_session_close(session, &result) == WEAPP_CONTAINER_SDK_OK);
  consume(&result, "\"ok\":true");
  assert(weapp_container_sdk_session_destroy(&session, &result) == WEAPP_CONTAINER_SDK_OK);
  assert(session == NULL);
  consume(&result, "\"ok\":true");
  assert(weapp_container_sdk_session_destroy(&session, &result) == WEAPP_CONTAINER_SDK_OK);
  consume(&result, "\"ok\":true");
  if (retained != NULL) {
    weapp_container_sdk_frame_info_data after = {0};
    assert(weapp_container_sdk_frame_info(retained, &after, &result) == WEAPP_CONTAINER_SDK_OK);
    consume(&result, "\"ok\":true");
    assert(after.width == before.width && after.height == before.height);
    assert(after.revision == before.revision && after.len == before.len);
    assert(after.data[0] == first_pixel);
    assert(weapp_container_sdk_frame_release(&retained, &result) == WEAPP_CONTAINER_SDK_OK);
    assert(retained == NULL);
    consume(&result, "\"ok\":true");
  }
  weapp_container_sdk_buffer_free(&result);
  return 0;
}
