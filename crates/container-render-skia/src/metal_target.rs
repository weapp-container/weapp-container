//! Validation of host-owned Metal targets, including offscreen Flutter textures.
use crate::RenderError;
use objc2::{rc::Retained, runtime::ProtocolObject};
use objc2_metal::{
    MTLCommandQueue, MTLPixelFormat, MTLResource, MTLTexture, MTLTextureType, MTLTextureUsage,
};
use std::ffi::c_void;

/// The caller guarantees that both pointers name live Objective-C objects of
/// the documented protocol. Validate their relationship before creating Skia.
pub(crate) unsafe fn context_device(
    device: *const c_void,
    queue: *const c_void,
) -> Result<usize, RenderError> {
    let queue = unsafe { &*queue.cast::<ProtocolObject<dyn MTLCommandQueue>>() };
    let queue_device = queue.device();
    if Retained::as_ptr(&queue_device).cast::<c_void>() != device {
        return Err(RenderError::Unsupported("skia-gpu-metal-device-mismatch"));
    }
    Ok(device as usize)
}

/// Texture lifetime remains with the host until GPU completion, not merely
/// until this synchronous validation or the Skia submission returns.
pub(crate) unsafe fn validate(
    texture: *const c_void,
    width: u32,
    height: u32,
    device: usize,
) -> Result<(), RenderError> {
    let texture = unsafe { &*texture.cast::<ProtocolObject<dyn MTLTexture>>() };
    if texture.width() != width as usize || texture.height() != height as usize {
        return Err(RenderError::Unsupported("skia-gpu-metal-texture-size"));
    }
    if texture.pixelFormat() != MTLPixelFormat::BGRA8Unorm
        || texture.textureType() != MTLTextureType::MTLTextureType2D
        || texture.sampleCount() != 1
        || !texture.usage().contains(MTLTextureUsage::RenderTarget)
        || texture.isFramebufferOnly()
    {
        return Err(RenderError::Unsupported("skia-gpu-metal-texture-format"));
    }
    if Retained::as_ptr(&texture.device()).cast::<c_void>() as usize != device {
        return Err(RenderError::Unsupported("skia-gpu-metal-device-mismatch"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Color, Rect, RenderFrame, RenderNode, Renderer, SkiaRenderer};
    use objc2_metal::{
        MTLCommandBuffer, MTLCreateSystemDefaultDevice, MTLDevice, MTLOrigin, MTLRegion, MTLSize,
        MTLStorageMode, MTLTextureDescriptor,
    };
    use std::{collections::BTreeMap, ptr::NonNull};

    #[test]
    #[ignore = "requires a real Metal device; run explicitly for native SDK validation"]
    fn offscreen_texture_renders_pixels_and_rejects_incompatible_targets() {
        let device = unsafe { Retained::from_raw(MTLCreateSystemDefaultDevice()) }
            .expect("real Metal device");
        let queue = device.newCommandQueue().expect("Metal queue");
        let descriptor = unsafe {
            MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
                MTLPixelFormat::BGRA8Unorm,
                2,
                2,
                false,
            )
        };
        descriptor.setUsage(MTLTextureUsage::RenderTarget | MTLTextureUsage::ShaderRead);
        descriptor.setStorageMode(MTLStorageMode::Shared);
        let texture = device.newTextureWithDescriptor(&descriptor).unwrap();
        let mut renderer = SkiaRenderer::new_native_gpu().unwrap();
        let bounds = Rect {
            x: 0.0,
            y: 0.0,
            width: 2.0,
            height: 2.0,
        };
        let mut root = RenderNode::new("sdk-offscreen", bounds);
        root.background = Some(Color {
            red: 20,
            green: 40,
            blue: 80,
            alpha: 255,
        });
        renderer
            .commit(RenderFrame {
                images: BTreeMap::new(),
                frame_id: 1,
                viewport: bounds,
                root,
            })
            .unwrap();
        assert!(
            renderer.snapshot().is_none(),
            "GPU commit must not read pixels back"
        );
        assert!(!renderer.has_native_surface());
        unsafe {
            renderer
                .attach_metal_context(
                    Retained::as_ptr(&device).cast(),
                    Retained::as_ptr(&queue).cast(),
                )
                .unwrap();
            assert!(renderer
                .render_last_frame_to_metal_texture(Retained::as_ptr(&texture).cast(), 3, 2)
                .is_err());
            renderer
                .render_last_frame_to_metal_texture(Retained::as_ptr(&texture).cast(), 2, 2)
                .unwrap();
        }
        // A barrier on the same queue completes after the submitted Skia work.
        // Only then is a separate consumer allowed to read or publish pixels.
        let barrier = queue.commandBuffer().unwrap();
        barrier.commit();
        unsafe { barrier.waitUntilCompleted() };
        let mut bytes = [0u8; 16];
        unsafe {
            texture.getBytes_bytesPerRow_fromRegion_mipmapLevel(
                NonNull::new(bytes.as_mut_ptr().cast()).unwrap(),
                8,
                MTLRegion {
                    origin: MTLOrigin { x: 0, y: 0, z: 0 },
                    size: MTLSize {
                        width: 2,
                        height: 2,
                        depth: 1,
                    },
                },
                0,
            );
        }
        assert_eq!(
            bytes,
            [80, 40, 20, 255, 80, 40, 20, 255, 80, 40, 20, 255, 80, 40, 20, 255]
        );
        descriptor.setPixelFormat(MTLPixelFormat::RGBA8Unorm);
        let invalid = device.newTextureWithDescriptor(&descriptor).unwrap();
        assert!(unsafe {
            renderer.render_last_frame_to_metal_texture(Retained::as_ptr(&invalid).cast(), 2, 2)
        }
        .is_err());
        renderer.detach_metal_context();
        assert!(!renderer.has_gpu_surface());
    }
}
