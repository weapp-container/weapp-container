//! Build a genuine downstream C executable against Cargo's dynamic artifact.
//! This is independent of Rust's type checker and exercises the installed ABI.

#[cfg(unix)]
#[test]
fn public_c_header_compiles_links_and_runs() {
    use std::path::PathBuf;
    use std::process::Command;
    let crate_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace = crate_root.parent().unwrap().parent().unwrap();
    let deps = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let temporary = tempfile::tempdir().unwrap();
    let executable = temporary.path().join("c-consumer");
    let compiler = std::env::var_os("CC").unwrap_or_else(|| "cc".into());
    let result = Command::new(compiler)
        .args(["-std=c11", "-Wall", "-Wextra", "-Werror"])
        .arg(format!(
            "-DWEAPP_TEST_SDK_VERSION=\"{}\"",
            env!("CARGO_PKG_VERSION")
        ))
        .arg("-I")
        .arg(workspace.join("sdk/contract/include"))
        .arg(crate_root.join("tests/c_consumer.c"))
        .arg("-L")
        .arg(&deps)
        .arg(format!("-Wl,-rpath,{}", deps.display()))
        .arg("-lweapp_container_sdk")
        .arg("-o")
        .arg(&executable)
        .output()
        .expect("a C compiler is required for ABI consumer validation");
    assert!(
        result.status.success(),
        "C consumer failed to compile/link:\n{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let pack = workspace.join("examples/hosts/android/app/src/main/assets/portable-pack");
    let load = serde_json::json!({ "packPath": pack });
    let result = Command::new(executable)
        .arg(load.to_string())
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "C consumer failed:\n{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}

#[cfg(unix)]
#[test]
fn header_matches_actual_dynamic_exports() {
    use std::collections::BTreeSet;
    use std::path::PathBuf;
    use std::process::Command;
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let header = ["weapp_container_sdk.h", "weapp_container_sdk_gl.h"]
        .map(|name| {
            std::fs::read_to_string(workspace.join("sdk/contract/include").join(name)).unwrap()
        })
        .join("\n");
    let prefix = "weapp_container_sdk_";
    let mut declarations = BTreeSet::new();
    for (index, _) in header.match_indices(prefix) {
        let rest = &header[index..];
        let end = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(rest.len());
        if rest[end..].trim_start().starts_with('(') {
            declarations.insert(rest[..end].to_owned());
        }
    }
    let deps = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let mut command = Command::new("nm");
    #[cfg(target_os = "macos")]
    command
        .arg("-gU")
        .arg(deps.join("libweapp_container_sdk.dylib"));
    #[cfg(not(target_os = "macos"))]
    command
        .args(["-D", "--defined-only"])
        .arg(deps.join("libweapp_container_sdk.so"));
    let result = command
        .output()
        .expect("nm is required for C ABI export validation");
    assert!(
        result.status.success(),
        "nm failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    let exports: BTreeSet<String> = String::from_utf8(result.stdout)
        .unwrap()
        .lines()
        .filter_map(|line| line.split_whitespace().last())
        .map(|name| name.trim_start_matches('_'))
        .filter(|name| name.starts_with(prefix))
        .map(str::to_owned)
        .collect();
    assert_eq!(
        declarations, exports,
        "public header and linked C symbols differ"
    );
}
