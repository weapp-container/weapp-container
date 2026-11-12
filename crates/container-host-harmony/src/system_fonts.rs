//! Font bytes belong to the installed host, never to a mini-program pack.
//! Read and validate bounded regular files once when preparing the first
//! native session. Skia owns the decoded faces and caches glyph selection.

use std::{fs::File, io::Read, path::Path, sync::Arc};

const MAX_FONT_BYTES: u64 = 64 * 1024 * 1024;

fn read_font(path: &Path) -> Result<Arc<[u8]>, String> {
    let file = File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let info = file
        .metadata()
        .map_err(|error| format!("{}: {error}", path.display()))?;
    if !info.is_file() || info.len() == 0 || info.len() > MAX_FONT_BYTES {
        return Err(format!(
            "{}: expected a regular font file of 1..={MAX_FONT_BYTES} bytes",
            path.display()
        ));
    }
    // Metadata can change during a read. Bound the actual allocation too.
    let mut bytes = Vec::with_capacity(info.len() as usize);
    file.take(MAX_FONT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_FONT_BYTES {
        return Err(format!(
            "{}: font file changed size while reading",
            path.display()
        ));
    }
    Ok(bytes.into())
}

#[cfg(all(feature = "skia-backend", target_env = "ohos"))]
pub(super) fn installed_sources(
) -> Result<Vec<container_render_skia::NativeFontData>, container_render_skia::RenderError> {
    // These are public installed platform fonts. No font bytes are copied
    // into the repository, portable pack or application package. Family-name
    // lookup alone cannot work with OHOS's empty default font manager.
    [
        "/system/fonts/HarmonyOS_Sans.ttf",
        "/system/fonts/HarmonyOS_Sans_SC.ttf",
    ]
    .into_iter()
    .map(|path| {
        read_font(Path::new(path))
            .map(|bytes| container_render_skia::NativeFontData::new(bytes, 0))
            .map_err(container_render_skia::RenderError::InvalidFont)
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn installed_font_reads_are_bounded_and_reject_missing_empty_or_nonfiles() {
        let directory = std::env::temp_dir().join(format!(
            "weapp-fonts-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&directory).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                std::fs::remove_dir_all(&self.0).unwrap();
            }
        }
        let _cleanup = Cleanup(directory.clone());
        assert!(read_font(&directory).is_err());
        let font = directory.join("font.ttf");
        assert!(read_font(&font).is_err());
        std::fs::write(&font, b"").unwrap();
        assert!(read_font(&font).is_err());
        File::options()
            .write(true)
            .open(&font)
            .unwrap()
            .set_len(MAX_FONT_BYTES + 1)
            .unwrap();
        assert!(read_font(&font).is_err());
        std::fs::write(
            &font,
            b"source bytes; decoder validation belongs to the renderer",
        )
        .unwrap();
        assert_eq!(
            &*read_font(&font).unwrap(),
            b"source bytes; decoder validation belongs to the renderer"
        );
    }
}
