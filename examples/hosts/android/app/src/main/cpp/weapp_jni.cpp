#include <jni.h>
#include <string>
#include "weapp_container_android_ffi.h"

static jbyteArray completeBuffer(JNIEnv* env, WeappContainerFfiBuffer& output) {
    jbyteArray response = env->NewByteArray(static_cast<jsize>(output.len));
    if (response != nullptr && output.len != 0) {
        env->SetByteArrayRegion(response, 0, static_cast<jsize>(output.len),
                                reinterpret_cast<const jbyte*>(output.data));
    }
    weapp_container_android_buffer_free(&output);
    return response;
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_sonofmagic_weapp_container_MainActivity_nativeInspectState(JNIEnv* env, jobject, jlong handle) {
    WeappContainerFfiBuffer output{nullptr, 0};
    weapp_container_android_host_inspect_state(reinterpret_cast<void*>(handle), &output);
    return completeBuffer(env, output);
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_sonofmagic_weapp_container_MainActivity_nativeResizeViewport(JNIEnv* env, jobject, jlong handle,
                                                                    jint width, jint height) {
    WeappContainerFfiBuffer output{nullptr, 0};
    weapp_container_android_host_resize_viewport(reinterpret_cast<void*>(handle),
        static_cast<uint32_t>(width), static_cast<uint32_t>(height), &output);
    return completeBuffer(env, output);
}

/** Validate and commit one complete observation in a single JNI transaction. */
extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_sonofmagic_weapp_container_MainActivity_nativeUpdateWindowMetrics(
    JNIEnv* env, jobject, jlong handle, jbyteArray observation) {
    const jsize length = env->GetArrayLength(observation);
    jbyte* bytes = env->GetByteArrayElements(observation, nullptr);
    if (bytes == nullptr) return nullptr;
    WeappContainerFfiBuffer output{nullptr, 0};
    weapp_container_android_host_update_window_metrics_json(
        reinterpret_cast<void*>(handle), reinterpret_cast<const uint8_t*>(bytes),
        static_cast<size_t>(length), &output);
    env->ReleaseByteArrayElements(observation, bytes, JNI_ABORT);
    return completeBuffer(env, output);
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_sonofmagic_weapp_container_MainActivity_nativePollTimers(JNIEnv* env, jobject, jlong handle, jlong now_ns) {
    WeappContainerFfiBuffer output{nullptr, 0};
    weapp_container_android_host_poll_timers(reinterpret_cast<void*>(handle), static_cast<uint64_t>(now_ns), &output);
    return completeBuffer(env, output);
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_sonofmagic_weapp_container_MainActivity_nativeCreate(JNIEnv*, jobject) {
    return reinterpret_cast<jlong>(weapp_container_android_host_new());
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_sonofmagic_weapp_container_MainActivity_nativeCapabilities(JNIEnv* env, jobject, jlong handle) {
    WeappContainerFfiBuffer output{nullptr, 0};
    const auto result = weapp_container_android_host_capabilities(reinterpret_cast<void*>(handle), &output);
    jbyteArray response = env->NewByteArray(static_cast<jsize>(output.len));
    if (response != nullptr && output.len != 0) {
        env->SetByteArrayRegion(response, 0, static_cast<jsize>(output.len),
                                reinterpret_cast<const jbyte*>(output.data));
    }
    (void)result;
    weapp_container_android_buffer_free(&output);
    return response;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_sonofmagic_weapp_container_MainActivity_nativeLoadManifest(JNIEnv* env, jobject, jlong handle,
                                                         jbyteArray manifest) {
    const jsize length = env->GetArrayLength(manifest);
    jbyte* bytes = env->GetByteArrayElements(manifest, nullptr);
    const auto result = weapp_container_android_host_load_manifest(
        reinterpret_cast<void*>(handle), reinterpret_cast<const uint8_t*>(bytes),
        static_cast<size_t>(length));
    env->ReleaseByteArrayElements(manifest, bytes, JNI_ABORT);
    return result;
}

/** Explicit engine/session startup with a structured JSON result and no fallback. */
extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_sonofmagic_weapp_container_MainActivity_nativeLoadManifestWithConfig(
    JNIEnv* env, jobject, jlong handle, jbyteArray manifest, jbyteArray config) {
    const jsize manifest_length = env->GetArrayLength(manifest);
    const jsize config_length = env->GetArrayLength(config);
    jbyte* manifest_bytes = env->GetByteArrayElements(manifest, nullptr);
    if (manifest_bytes == nullptr) return nullptr;
    jbyte* config_bytes = env->GetByteArrayElements(config, nullptr);
    if (config_bytes == nullptr) {
        env->ReleaseByteArrayElements(manifest, manifest_bytes, JNI_ABORT);
        return nullptr;
    }
    WeappContainerFfiBuffer output{nullptr, 0};
    const auto result = weapp_container_android_host_load_manifest_with_config(
        reinterpret_cast<void*>(handle), reinterpret_cast<const uint8_t*>(manifest_bytes),
        static_cast<size_t>(manifest_length), reinterpret_cast<const uint8_t*>(config_bytes),
        static_cast<size_t>(config_length), &output);
    env->ReleaseByteArrayElements(manifest, manifest_bytes, JNI_ABORT);
    env->ReleaseByteArrayElements(config, config_bytes, JNI_ABORT);
    const std::string success = "{\"ok\":true}";
    const std::string missing_error = "{\"ok\":false,\"error\":{\"code\":\"ERR_ENGINE\",\"message\":\"native configured load failed without JSON\"}}";
    const auto* bytes = result == 0 ? reinterpret_cast<const uint8_t*>(success.data())
        : output.len != 0 ? output.data : reinterpret_cast<const uint8_t*>(missing_error.data());
    const size_t length = result == 0 ? success.size() : output.len != 0 ? output.len : missing_error.size();
    jbyteArray response = env->NewByteArray(static_cast<jsize>(length));
    if (response != nullptr) env->SetByteArrayRegion(response, 0, static_cast<jsize>(length), reinterpret_cast<const jbyte*>(bytes));
    weapp_container_android_buffer_free(&output);
    return response;
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_sonofmagic_weapp_container_MainActivity_nativeStart(JNIEnv* env, jobject, jlong handle,
                                                  jbyteArray request_id) {
    const jsize length = env->GetArrayLength(request_id);
    jbyte* bytes = env->GetByteArrayElements(request_id, nullptr);
    WeappContainerFfiBuffer output{nullptr, 0};
    const auto result = weapp_container_android_host_start(
        reinterpret_cast<void*>(handle), reinterpret_cast<const uint8_t*>(bytes),
        static_cast<size_t>(length), &output);
    env->ReleaseByteArrayElements(request_id, bytes, JNI_ABORT);
    if (result != 0) {
        weapp_container_android_buffer_free(&output);
        return env->NewByteArray(0);
    }
    jbyteArray response = env->NewByteArray(static_cast<jsize>(output.len));
    if (response != nullptr && output.len != 0) {
        env->SetByteArrayRegion(response, 0, static_cast<jsize>(output.len),
                                reinterpret_cast<const jbyte*>(output.data));
    }
    weapp_container_android_buffer_free(&output);
    return response;
}

/** Dispatch one complete bridge envelope and return its JSON batch. */
extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_sonofmagic_weapp_container_MainActivity_nativeDispatch(JNIEnv* env, jobject, jlong handle,
                                                     jbyteArray envelope) {
    const jsize length = env->GetArrayLength(envelope);
    jbyte* bytes = env->GetByteArrayElements(envelope, nullptr);
    WeappContainerFfiBuffer output{nullptr, 0};
    const auto result = weapp_container_android_host_dispatch_json(
        reinterpret_cast<void*>(handle), reinterpret_cast<const uint8_t*>(bytes),
        static_cast<size_t>(length), &output);
    env->ReleaseByteArrayElements(envelope, bytes, JNI_ABORT);
    jbyteArray response = env->NewByteArray(static_cast<jsize>(output.len));
    if (response != nullptr && output.len != 0) {
        env->SetByteArrayRegion(response, 0, static_cast<jsize>(output.len),
                                reinterpret_cast<const jbyte*>(output.data));
    }
    // The JSON error body is intentionally returned even for a non-zero status
    // so the Kotlin harness can report the structured boundary failure.
    (void)result;
    weapp_container_android_buffer_free(&output);
    return response;
}

/** Return one complete RGBA8 render snapshot after render.commit. */
extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_sonofmagic_weapp_container_MainActivity_nativeRenderSnapshot(JNIEnv* env, jobject, jlong handle) {
    WeappContainerFfiBuffer output{nullptr, 0};
    const auto result = weapp_container_android_host_render_snapshot(reinterpret_cast<void*>(handle), &output);
    jbyteArray response = env->NewByteArray(static_cast<jsize>(output.len));
    if (response != nullptr && output.len != 0) {
        env->SetByteArrayRegion(response, 0, static_cast<jsize>(output.len),
                                reinterpret_cast<const jbyte*>(output.data));
    }
    (void)result;
    weapp_container_android_buffer_free(&output);
    return response;
}

/** Lightweight committed-frame metadata; no pixels or render nodes. */
extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_sonofmagic_weapp_container_MainActivity_nativeAcknowledgePresentation(JNIEnv* env, jobject, jlong handle, jlong revision) {
    WeappContainerFfiBuffer output{nullptr, 0};
    weapp_container_android_host_acknowledge_presentation(reinterpret_cast<void*>(handle), static_cast<uint64_t>(revision), &output);
    jbyteArray response = env->NewByteArray(static_cast<jsize>(output.len));
    if (response != nullptr && output.data != nullptr) {
        env->SetByteArrayRegion(response, 0, static_cast<jsize>(output.len), reinterpret_cast<const jbyte*>(output.data));
    }
    weapp_container_android_buffer_free(&output);
    return response;
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_sonofmagic_weapp_container_MainActivity_nativePresentationState(JNIEnv* env, jobject, jlong handle) {
    WeappContainerFfiBuffer output{nullptr, 0};
    const auto result = weapp_container_android_host_presentation_state(reinterpret_cast<void*>(handle), &output);
    jbyteArray response = env->NewByteArray(static_cast<jsize>(output.len));
    if (response != nullptr && output.len != 0) {
        env->SetByteArrayRegion(response, 0, static_cast<jsize>(output.len),
                                reinterpret_cast<const jbyte*>(output.data));
    }
    (void)result;
    weapp_container_android_buffer_free(&output);
    return response;
}

/** Attach the current EGL/GLES context to the shared Skia Ganesh renderer. */
extern "C" JNIEXPORT jint JNICALL
Java_com_sonofmagic_weapp_container_MainActivity_nativeAttachGlesContext(JNIEnv*, jobject, jlong handle) {
#ifdef WEAPP_CONTAINER_ANDROID_SKIA_GPU_GLES
    return weapp_container_android_host_attach_gles_context(reinterpret_cast<void*>(handle));
#else
    (void)handle;
    return -1;
#endif
}

/** Render the last committed frame directly into the current window FBO. */
extern "C" JNIEXPORT jint JNICALL
Java_com_sonofmagic_weapp_container_MainActivity_nativeRenderGlesFramebuffer(JNIEnv*, jobject, jlong handle,
                                                                  jint framebuffer, jint width,
                                                                  jint height) {
#ifdef WEAPP_CONTAINER_ANDROID_SKIA_GPU_GLES
    return weapp_container_android_host_render_gles_framebuffer(
        reinterpret_cast<void*>(handle), static_cast<uint32_t>(framebuffer),
        static_cast<uint32_t>(width), static_cast<uint32_t>(height));
#else
    (void)handle;
    (void)framebuffer;
    (void)width;
    (void)height;
    return -1;
#endif
}

/** Detach Skia before the EGL context is destroyed. */
extern "C" JNIEXPORT jint JNICALL
Java_com_sonofmagic_weapp_container_MainActivity_nativeDetachGlesContext(JNIEnv*, jobject, jlong handle) {
#ifdef WEAPP_CONTAINER_ANDROID_SKIA_GPU_GLES
    return weapp_container_android_host_detach_gles_context(reinterpret_cast<void*>(handle));
#else
    (void)handle;
    return -1;
#endif
}

/** Forget lost Skia GL resources without a current EGL context. */
extern "C" JNIEXPORT jint JNICALL
Java_com_sonofmagic_weapp_container_MainActivity_nativeAbandonGlesContext(JNIEnv*, jobject, jlong handle) {
#ifdef WEAPP_CONTAINER_ANDROID_SKIA_GPU_GLES
    return weapp_container_android_host_abandon_gles_context(reinterpret_cast<void*>(handle));
#else
    (void)handle;
    return -1;
#endif
}

/** Return one complete RGBA8 Canvas 2D snapshot by UTF-8 canvas id. */
extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_sonofmagic_weapp_container_MainActivity_nativeCanvasSnapshot(JNIEnv* env, jobject, jlong handle,
                                                           jbyteArray canvas_id) {
    const jsize length = env->GetArrayLength(canvas_id);
    jbyte* bytes = env->GetByteArrayElements(canvas_id, nullptr);
    WeappContainerFfiBuffer output{nullptr, 0};
    const auto result = weapp_container_android_host_canvas_snapshot(
        reinterpret_cast<void*>(handle), reinterpret_cast<const uint8_t*>(bytes),
        static_cast<size_t>(length), &output);
    env->ReleaseByteArrayElements(canvas_id, bytes, JNI_ABORT);
    jbyteArray response = env->NewByteArray(static_cast<jsize>(output.len));
    if (response != nullptr && output.len != 0) {
        env->SetByteArrayRegion(response, 0, static_cast<jsize>(output.len),
                                reinterpret_cast<const jbyte*>(output.data));
    }
    (void)result;
    weapp_container_android_buffer_free(&output);
    return response;
}

extern "C" JNIEXPORT void JNICALL
Java_com_sonofmagic_weapp_container_MainActivity_nativeFree(JNIEnv*, jobject, jlong handle) {
    weapp_container_android_host_free(reinterpret_cast<void*>(handle));
}
