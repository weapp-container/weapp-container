use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=WEAPP_SHOWCASE_POLICY");
    println!("cargo:rerun-if-env-changed=WEAPP_SHOWCASE_FONT");
    println!("cargo:rerun-if-env-changed=WEAPP_SHOWCASE_FONT_LICENSE");
    if env::var_os("CARGO_FEATURE_RESTRICTED_SHOWCASE").is_none() {
        return;
    }
    let path = PathBuf::from(
        env::var_os("WEAPP_SHOWCASE_POLICY")
            .expect("restricted-showcase requires an explicit WEAPP_SHOWCASE_POLICY file"),
    );
    assert!(path.is_absolute(), "WEAPP_SHOWCASE_POLICY must be absolute");
    println!("cargo:rerun-if-changed={}", path.display());
    let bytes = fs::read(&path).expect("cannot read showcase policy");
    assert!(bytes.len() <= 64 * 1024, "showcase policy exceeds 64 KiB");
    let mut value: serde_json::Value =
        serde_json::from_slice(&bytes).expect("invalid showcase policy JSON");
    let object = value
        .as_object_mut()
        .expect("showcase policy must be an object");
    assert!(
        object.len() == 3 && object.get("schemaVersion").and_then(|v| v.as_u64()) == Some(1),
        "showcase policy requires schemaVersion 1, allowedPackRoots and allowedApis only"
    );
    for field in ["allowedPackRoots", "allowedApis"] {
        let list = object
            .get_mut(field)
            .and_then(|v| v.as_array_mut())
            .expect("showcase policy requires arrays");
        assert!(
            !list.is_empty() && list.len() <= 1024,
            "showcase policy arrays must be nonempty and bounded"
        );
        for item in list.iter() {
            let text = item
                .as_str()
                .expect("showcase policy entries must be strings");
            if field == "allowedPackRoots" {
                assert!(
                    text.len() == 64
                        && text
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                    "invalid allowed pack root"
                );
            } else {
                assert!(
                    !text.is_empty()
                        && text.len() <= 128
                        && text
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"._:$-".contains(&b)),
                    "invalid allowed API"
                );
            }
        }
        list.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
        assert!(
            list.windows(2).all(|items| items[0] != items[1]),
            "duplicate showcase policy entry"
        );
    }
    let canonical = serde_json::to_vec(&value).expect("cannot canonicalize showcase policy");
    let hash = format!("{:x}", Sha256::digest(&canonical));
    let array = |field: &str| {
        value[field]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| format!("{:?}", item.as_str().unwrap()))
            .collect::<Vec<_>>()
            .join(",")
    };
    let marker = format!("weapp-container-distribution:restricted-showcase:{hash}\0");
    let mut source = format!("pub const POLICY_SHA256: &str = {hash:?};\npub const ALLOWED_PACK_ROOTS: &[&str] = &[{}];\npub const ALLOWED_APIS: &[&str] = &[{}];\n#[used]\n#[no_mangle]\npub static WEAPP_CONTAINER_DISTRIBUTION_IDENTITY: [u8; {}] = *b{:?};\n", array("allowedPackRoots"), array("allowedApis"), marker.len(), marker);
    // The restricted native runtime is a self-contained delivery. A process
    // font registration does not guarantee visibility to Skia's DirectWrite
    // manager, so compile the reviewed bytes and install them before layout.
    // Web keeps its explicit portable font owner and does not duplicate this
    // native resource in the WASM module.
    if env::var_os("CARGO_FEATURE_SKIA_BACKEND").is_some()
        && env::var("CARGO_CFG_TARGET_ARCH").unwrap() != "wasm32"
    {
        let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
        for (variable, file, size, sha256) in [
            (
                "WEAPP_SHOWCASE_FONT",
                "showcase-font.ttf",
                17_772_300,
                "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da",
            ),
            (
                "WEAPP_SHOWCASE_FONT_LICENSE",
                "showcase-font-OFL.txt",
                4_388,
                "1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9",
            ),
        ] {
            let input = PathBuf::from(
                env::var_os(variable)
                    .unwrap_or_else(|| panic!("restricted native Skia requires {variable}")),
            );
            assert!(input.is_absolute(), "{variable} must be absolute");
            println!("cargo:rerun-if-changed={}", input.display());
            let bytes = fs::read(&input).unwrap_or_else(|_| panic!("cannot read {variable}"));
            assert_eq!(bytes.len(), size, "{variable} size mismatch");
            assert_eq!(
                format!("{:x}", Sha256::digest(&bytes)),
                sha256,
                "{variable} is not the reviewed showcase font input"
            );
            fs::write(out.join(file), bytes).expect("cannot retain showcase native font input");
        }
        let marker = "weapp-container-native-font:a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da:1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9\0";
        source.push_str(&format!("pub static NATIVE_FONT_BYTES: &[u8] = include_bytes!(concat!(env!(\"OUT_DIR\"), \"/showcase-font.ttf\"));\n#[used]\n#[no_mangle]\npub static WEAPP_CONTAINER_NATIVE_FONT_IDENTITY: [u8; {}] = *b{:?};\n", marker.len(), marker));
    }
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("showcase_policy.rs"),
        source,
    )
    .expect("cannot generate showcase policy");
}
