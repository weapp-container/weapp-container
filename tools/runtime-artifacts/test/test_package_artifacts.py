"""Boundary tests use authored structural markers, never runnable runtime binaries."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import struct
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("artifact_packager", ROOT / "tools/package_artifacts.py")
packager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(packager)
SOURCE = "1" * 40
LINUX = "x86_64-unknown-linux-gnu"
ANDROID = ["aarch64-linux-android", "x86_64-linux-android"]
IOS = ["aarch64-apple-ios", "aarch64-apple-ios-sim", "x86_64-apple-ios"]
sha = lambda data: hashlib.sha256(data).hexdigest()

class PackagerBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="runtime-artifact-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.native, self.licenses, self.out = [self.root / name for name in ["native", "licenses", "archives"]]
        self.native.mkdir(); self.licenses.mkdir()
        (self.native / "RUNTIME-LICENSE").write_bytes((ROOT / "RUNTIME-LICENSE").read_bytes())
        self.receipts = {}

    def write_json(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(packager.canonical(value))

    def make_native(self, target):
        platform, arch, required, features = packager.TARGETS[target]
        folder = self.native / target
        folder.mkdir()
        for name in required:
            if name.endswith((".a", ".lib")):
                data = b"!<arch>\n" + target.encode() + b" isolated structural fixture, not executable\n"
            elif name.endswith(".so"):
                data = bytearray(64)
                data[:6] = b"\x7fELF\x02\x01"
                struct.pack_into("<H", data, 18, 183 if target.startswith("aarch64") else 62)
                data.extend(name.encode() + b" isolated fixture")
                data = bytes(data)
            elif name.endswith(".dll"):
                data = bytearray(70)
                data[:2] = b"MZ"
                struct.pack_into("<I", data, 60, 64)
                data[64:70] = b"PE\0\0\x64\x86"
                data = bytes(data)
            else:
                data = bytearray(64)
                data[:4] = b"\xcf\xfa\xed\xfe"
                struct.pack_into("<I", data, 4, 0x100000c if target.startswith("aarch64") else 0x1000007)
                data = bytes(data)
            (folder / name).write_bytes(data)
        (folder / "weapp_container_sdk.h").write_bytes((ROOT / "test/fixtures/weapp_container_sdk.h").read_bytes())
        (folder / "weapp_container_sdk_gl.h").write_bytes((ROOT / "test/fixtures/weapp_container_sdk_gl.h").read_bytes())
        (folder / "RUNTIME-LICENSE").write_bytes((ROOT / "RUNTIME-LICENSE").read_bytes())
        names = required + ["weapp_container_sdk.h", "weapp_container_sdk_gl.h"]
        if platform == "android":
            (folder / "platform-notices").mkdir()
            name = "platform-notices/android-ndk-fixture-NOTICE"
            (folder / name).write_text("Public fixture NDK notice\n")
            names.append(name)
        receipt = {"schemaVersion":1,"sdkVersion":packager.VERSION,"abiVersion":1,"status":"built","exitCode":0,
                   "sourceCommit":SOURCE,"sourceDirty":False,"target":target,"platform":platform,"profile":"release","features":features,
                   "artifacts":[{"file":name,"bytes":(folder/name).stat().st_size,"sha256":sha((folder/name).read_bytes())} for name in names]}
        self.receipts[target] = receipt
        self.write_json(folder / "build.json", receipt)
        (folder / "cargo-build.jsonl").write_text("Sensitive compiler output deliberately excluded\n")
        notices = self.licenses / target
        notice_path = notices / "fixture-dependency-1.0.0/LICENSE"
        notice_path.parent.mkdir(parents=True)
        notice_path.write_text("Authored public test license\n")
        (notices / "README.txt").write_text("Fixture dependency inventory\n")
        self.write_json(notices / "licenses.json", {"schemaVersion":1,"target":target,"features":features,"packages":[
            {"name":"fixture-dependency","version":"1.0.0","license":"MIT","files":[{"path":"fixture-dependency-1.0.0/LICENSE","sha256":sha(notice_path.read_bytes())}]}]})
        return receipt

    def options(self, **changes):
        values = dict(source_commit=SOURCE,native_root=str(self.native),licenses_root=str(self.licenses),out_dir=str(self.out),
                      target=None,component="runtime",platform=None,arch=None,architectures=None,install_dir=None)
        values.update(changes)
        return types.SimpleNamespace(**values)

    def package(self, **changes):
        return packager.package(self.options(**changes))

    def save_receipt(self, target):
        self.write_json(self.native / target / "build.json", self.receipts[target])

    def repin(self, target, name):
        entry = next(item for item in self.receipts[target]["artifacts"] if item["file"] == name)
        data = (self.native / target / name).read_bytes()
        entry.update(bytes=len(data),sha256=sha(data));self.save_receipt(target)

    def identity(self, target):
        keys = ["schemaVersion","sdkVersion","abiVersion","status","target","platform","profile","features","sourceCommit","sourceDirty","artifacts"]
        return {key:copy.deepcopy(self.receipts[target][key]) for key in keys}

    def assert_rejected(self, message, **options):
        with self.assertRaisesRegex((packager.PackagingError, FileNotFoundError), message):
            self.package(**options)
        self.assertFalse((self.out / ".packaging.lock").exists())
        if self.out.exists():
            self.assertEqual(list(self.out.glob(".packaging-*")), [])

    def test_runtime_archive_is_portable_exact_and_excludes_compiler_output(self):
        self.make_native(LINUX)
        result = self.package()
        self.assertFalse(result["compiled"]);self.assertFalse(result["published"])
        manifest = json.loads((self.out / "manifest.json").read_text())
        self.assertEqual(set(manifest), {"schemaVersion","runtimeVersion","abiVersion","source","artifacts"})
        self.assertEqual(manifest["source"], {"repository":packager.REPOSITORY,"releaseTag":packager.RELEASE_TAG})
        pin = manifest["artifacts"][0]
        archive = self.out / pin["fileName"]
        self.assertEqual(pin["sha256"],sha(archive.read_bytes()))
        with tarfile.open(archive,"r:gz") as tar:
            names = tar.getnames()
            self.assertIn("build.json",names);self.assertIn("licenses/licenses.json",names)
            self.assertNotIn("cargo-build.jsonl",names)
            self.assertEqual(sha(tar.extractfile("SDK-CONTRACT-LICENSE").read()),packager.CONTRACT_LICENSE_SHA256)
            contract=json.load(tar.extractfile("SDK-CONTRACT-NOTICE.json"))
            self.assertEqual(contract["repository"],"weapp-container/sdk-contract")
            self.assertEqual(contract["headerSha256"],packager.HEADER_SHA256)
            self.assertEqual(tar.extractfile("weapp_container_sdk.h").read(),(ROOT/"test/fixtures/weapp_container_sdk.h").read_bytes())
            self.assertEqual(sha(tar.extractfile("weapp_container_sdk_gl.h").read()),packager.GL_HEADER_SHA256)
            for member in tar:
                self.assertTrue(member.isfile());self.assertFalse(member.name.startswith("/"));self.assertEqual(member.mtime,0)
        provenance = json.loads((self.out/"provenance.json").read_text())
        self.assertEqual(provenance["sourceCommit"],SOURCE)
        self.assertEqual(provenance["headerSha256"],packager.HEADER_SHA256)
        self.assertNotIn(str(self.root),(self.out/"provenance.json").read_text())
        self.assertIn("manifest.json",(self.out/"SHA256SUMS").read_text())

    def test_packager_requires_the_actual_native_producer_feature_plan(self):
        result = subprocess.run(["node", "--input-type=module", "-e",
            "import {NATIVE_TARGETS,nativeBuildPlan} from './scripts/lib/sdk-native-features.mjs'; console.log(JSON.stringify(Object.fromEntries(Object.keys(NATIVE_TARGETS).map(target=>[target,nativeBuildPlan(target).features]))));"],
            cwd=ROOT.parents[1], check=True, capture_output=True, text=True)
        plans = json.loads(result.stdout)
        self.assertEqual(set(plans), set(packager.TARGETS))
        for target, plan in plans.items():
            self.assertEqual(set(plan), set(packager.TARGETS[target][3]), target)

    def test_windows_archive_keeps_the_dll_and_import_library_required_by_consumers(self):
        target = "x86_64-pc-windows-msvc"
        self.make_native(target)
        self.package()
        pin = json.loads((self.out / "manifest.json").read_text())["artifacts"][0]
        with tarfile.open(self.out / pin["fileName"], "r:gz") as archive:
            self.assertTrue({"weapp_container_sdk.dll", "weapp_container_sdk.dll.lib"}.issubset(archive.getnames()))
        (self.native / target / "weapp_container_sdk.dll").write_bytes(b"wrong architecture")
        self.repin(target, "weapp_container_sdk.dll")
        self.assert_rejected("PE image")

    def test_extension_header_cannot_be_replaced_even_with_a_rewritten_receipt(self):
        self.make_native(LINUX)
        (self.native / LINUX / "weapp_container_sdk_gl.h").write_text("altered public extension")
        self.repin(LINUX, "weapp_container_sdk_gl.h")
        self.assert_rejected("GL extension header")

    def test_html_is_limited_to_complete_legal_notices_in_license_trees(self):
        self.make_native(LINUX)
        folder = self.licenses / LINUX
        notice = folder / "fixture-dependency-1.0.0/license.html"
        notice.write_text("<html><body>Authored complete legal notice fixture</body></html>\n")
        inventory = json.loads((folder / "licenses.json").read_text())
        inventory["packages"][0]["files"].append({"path":notice.relative_to(folder).as_posix(),"sha256":sha(notice.read_bytes())})
        self.write_json(folder / "licenses.json", inventory)
        self.package()
        pin = json.loads((self.out / "manifest.json").read_text())["artifacts"][0]
        with tarfile.open(self.out / pin["fileName"], "r:gz") as archive:
            self.assertIn("licenses/fixture-dependency-1.0.0/license.html",archive.getnames())
        self.assertEqual(packager.safe_name("share/weapp-container/licenses/native/dep/LICENSE.html"),"share/weapp-container/licenses/native/dep/LICENSE.html")
        for name in ["source/private.html", "source/LICENSE.html", "licenses/dep/private.html"]:
            with self.assertRaisesRegex(packager.PackagingError,"HTML"):
                packager.safe_name(name)

    def test_notice_classifier_rejects_source_even_when_receipted_as_a_license(self):
        for name in ["LICENSE.MIT","LICENSE-APACHE","NOTICE.txt","COPYING.LIB","license.html"]:
            self.assertTrue(packager.is_notice_filename(name),name)
        for name in ["copying.rs","COPYING.js","LICENSE.cpp","NOTICE.swift","LICENSE.json","../LICENSE"]:
            self.assertFalse(packager.is_notice_filename(name),name)
        self.make_native(LINUX)
        folder=self.licenses/LINUX
        source=folder/"fixture-dependency-1.0.0/COPYING.js";source.write_text("private implementation fixture")
        inventory=json.loads((folder/"licenses.json").read_text())
        inventory["packages"][0]["files"].append({"path":source.relative_to(folder).as_posix(),"sha256":sha(source.read_bytes())})
        self.write_json(folder/"licenses.json",inventory)
        self.assert_rejected("non-notice filename")

    def test_license_collector_identity_is_distinct_from_native_source(self):
        self.make_native(LINUX)
        inventory_path=self.licenses/LINUX/"licenses.json"
        inventory=json.loads(inventory_path.read_text())
        collector={"algorithm":"sha256","sourceFiles":[{"path":"scripts/sdk-licenses.mjs","sha256":"b"*64}]}
        inventory["collector"]=collector;self.write_json(inventory_path,inventory)
        self.package()
        provenance=json.loads((self.out/"provenance.json").read_text())
        self.assertEqual(provenance["sourceCommit"],SOURCE)
        self.assertEqual(provenance["artifacts"][0]["nativeReceipts"][0]["licenseCollector"],collector)

    def test_only_target_distribution_libraries_are_selected_from_build_output(self):
        for target, extra in [(IOS[0],"libweapp_container_sdk.dylib"),(ANDROID[0],"libweapp_container_sdk.a")]:
            self.make_native(target)
            path=self.native/target/extra
            path.write_bytes(b"Undistributed build output with local install name /Users/private/build\n")
            self.receipts[target]["artifacts"].append({"file":extra,"bytes":path.stat().st_size,"sha256":sha(path.read_bytes())})
            self.save_receipt(target)
        self.package()
        manifest=json.loads((self.out/"manifest.json").read_text())
        provenance=json.loads((self.out/"provenance.json").read_text())
        for pin in manifest["artifacts"]:
            excluded="libweapp_container_sdk.dylib" if pin["platform"]=="ios" else "libweapp_container_sdk.a"
            with tarfile.open(self.out/pin["fileName"],"r:gz") as archive:
                self.assertNotIn(excluded,archive.getnames())
                self.assertIn("build.json",archive.getnames())
                producer_bytes=archive.extractfile("build.json").read()
                producer=json.loads(producer_bytes)
                selection=json.load(archive.extractfile("runtime-distribution.json"))
                self.assertEqual(selection["producerReceipt"],{"file":"build.json","sha256":sha(producer_bytes)})
                self.assertEqual(selection["target"],producer["target"])
                self.assertEqual(selection["sourceCommit"],SOURCE)
                self.assertEqual({item["file"] for item in selection["selectedArtifacts"]} | {item["file"] for item in selection["omittedArtifacts"]},{item["file"] for item in producer["artifacts"]})
                self.assertEqual([item["file"] for item in selection["omittedArtifacts"]],[excluded])
                self.assertIn(excluded,[item["file"] for item in producer["artifacts"]])
            source=next(item for item in provenance["artifacts"] if item["fileName"]==pin["fileName"])
            item=source["excludedNativeBuildArtifacts"][0]["artifacts"][0]
            self.assertEqual(item["file"],excluded)
            self.assertEqual(item["validation"],"producer-receipt-only-not-distributed")

    def test_deterministic_repack_and_incremental_merge(self):
        self.make_native(LINUX)
        self.package(target=LINUX)
        old = (self.out/"manifest.json").read_bytes()
        self.assertEqual(self.package(target=LINUX)["archivesAdded"],[])
        self.assertEqual((self.out/"manifest.json").read_bytes(),old)
        other = self.root/"another-output"
        self.package(target=LINUX,out_dir=str(other))
        self.assertEqual((other/"manifest.json").read_bytes(),old)
        self.make_native(ANDROID[0])
        self.package(target=ANDROID[0])
        self.assertEqual(len(json.loads((self.out/"manifest.json").read_text())["artifacts"]),2)

    def test_same_name_different_bytes_is_rejected_without_losing_previous_release(self):
        self.make_native(LINUX);self.package()
        before = (self.out/"manifest.json").read_bytes()
        path=self.native/LINUX/"libweapp_container_sdk.a";path.write_bytes(path.read_bytes()+b"changed")
        self.repin(LINUX,path.name)
        self.assert_rejected("different bytes")
        self.assertEqual((self.out/"manifest.json").read_bytes(),before)

    def test_cannot_mix_selected_source_commits_in_existing_output(self):
        self.make_native(LINUX);self.package()
        self.assert_rejected("provenance policy mismatch",source_commit="2"*40)

    def test_rejects_dirty_wrong_source_nonrelease_or_failed_build(self):
        for field,value,message in [("sourceDirty",True,"clean commit"),("sourceCommit","2"*40,"clean commit"),
                                    ("profile","dev","target/profile"),("status","failed","successful"),("exitCode",1,"exit status")]:
            with self.subTest(field=field):
                if not self.receipts:self.make_native(LINUX)
                original=self.receipts[LINUX][field];self.receipts[LINUX][field]=value;self.save_receipt(LINUX)
                self.assert_rejected(message)
                self.receipts[LINUX][field]=original;self.save_receipt(LINUX)

    def test_rejects_unpinned_header_and_library_corruption(self):
        self.make_native(LINUX)
        header=self.native/LINUX/"weapp_container_sdk.h";original=header.read_bytes();header.write_text("fake header")
        self.repin(LINUX,header.name);self.assert_rejected("reviewed contract")
        header.write_bytes(original);self.repin(LINUX,header.name)
        library=self.native/LINUX/"libweapp_container_sdk.so";library.write_bytes(library.read_bytes()+b"unreceipted")
        self.assert_rejected("build receipt")

    def test_rejects_missing_or_unlisted_license_files(self):
        self.make_native(LINUX)
        extra=self.licenses/LINUX/"unlisted.txt";extra.write_text("unreviewed")
        self.assert_rejected("unlisted files");extra.unlink()
        (self.licenses/LINUX/"fixture-dependency-1.0.0/LICENSE").unlink()
        self.assert_rejected("No such file")

    def test_rejects_source_artifacts_symlinks_credentials_and_local_paths(self):
        self.make_native(LINUX)
        self.receipts[LINUX]["artifacts"].append({"file":"private.rs","bytes":1,"sha256":"0"*64});self.save_receipt(LINUX)
        self.assert_rejected("Private source")
        self.receipts[LINUX]["artifacts"].pop();self.save_receipt(LINUX)
        library=self.native/LINUX/"libweapp_container_sdk.a";original=library.read_bytes();library.unlink();library.symlink_to(self.native/LINUX/"libweapp_container_sdk.so")
        self.assert_rejected("Symlink");library.unlink();library.write_bytes(original)
        for suffix,message in [(b"ghp_"+b"a"*30,"Credential material"),(b"/Users/private-person/project/core.rs","private/local path")]:
            library.write_bytes(original+suffix);self.repin(LINUX,library.name);self.assert_rejected(message)
        library.write_bytes(original);self.repin(LINUX,library.name)
        self.receipts[LINUX]["toolchain"]={"path":"/unlisted/local/compiler"};self.save_receipt(LINUX)
        self.assert_rejected("Absolute local path")

    def test_rejects_existing_archive_tampering_and_unknown_target(self):
        self.make_native(LINUX);self.package()
        manifest=json.loads((self.out/"manifest.json").read_text());(self.out/manifest["artifacts"][0]["fileName"]).write_bytes(b"damaged")
        self.assert_rejected("Existing release archive")
        self.assert_rejected("Existing release archive",target="unknown-runtime")

    def make_desktop(self, target=LINUX):
        self.make_native(target)
        windows = target.endswith("-windows-msvc")
        install=self.root/"desktop-install"
        for name in ["lib","include","share/weapp-container"] + (["bin"] if windows else []):(install/name).mkdir(parents=True,exist_ok=True)
        if windows:
            for folder, name in [("lib", "weapp_container_sdk.dll.lib"), ("bin", "weapp_container_sdk.dll")]:
                (install/folder/name).write_bytes((self.native/target/name).read_bytes())
        else:
            (install/"lib/libweapp_container_sdk.a").write_bytes((self.native/target/"libweapp_container_sdk.a").read_bytes())
        (install/"lib/libweapp_container_desktop.a").write_bytes(b"!<arch>\npublic wrapper fixture")
        (install/"include/weapp_container_sdk.h").write_bytes((ROOT/"test/fixtures/weapp_container_sdk.h").read_bytes())
        (install/"share/weapp-container/README.md").write_text("Public installed wrapper fixture\n")
        receipt={"schemaVersion":1,"sdkVersion":packager.VERSION,"status":"verified","platform":"windows-x64" if windows else "linux-x64","sourceCommit":"a"*40,"sourceDirty":False,"native":[self.identity(target)],"checks":[{"label":"isolated fixture validation","exitCode":0}],"artifacts":[]}
        for folder in ["lib"] + (["bin"] if windows else []):
            for file in sorted((install/folder).iterdir()):receipt["artifacts"].append({"file":file.relative_to(install).as_posix(),"sha256":sha(file.read_bytes())})
        self.write_json(install/"package.json",receipt)
        return install,receipt,dict(component="desktop-sdk",platform="windows" if windows else "linux",arch="x86_64",install_dir=str(install))

    def test_windows_desktop_requires_exact_dll_and_import_library(self):
        install,receipt,options=self.make_desktop("x86_64-pc-windows-msvc")
        self.package(**options)
        manifest=json.loads((self.out/"manifest.json").read_text())
        with tarfile.open(self.out/manifest["artifacts"][0]["fileName"]) as archive:
            self.assertIn("bin/weapp_container_sdk.dll",archive.getnames())
            self.assertIn("lib/weapp_container_sdk.dll.lib",archive.getnames())
        library=install/"bin/weapp_container_sdk.dll"
        library.write_bytes(library.read_bytes()+b"foreign runtime")
        next(item for item in receipt["artifacts"] if item["file"].endswith(".dll"))["sha256"]=sha(library.read_bytes())
        self.write_json(install/"package.json",receipt)
        self.assert_rejected("Installed core archive",**options)

    def test_desktop_installation_binds_native_and_wrapper_receipts(self):
        install,receipt,options=self.make_desktop();self.package(**options)
        manifest=json.loads((self.out/"manifest.json").read_text())
        with tarfile.open(self.out/manifest["artifacts"][0]["fileName"]) as archive:
            self.assertIn("lib/libweapp_container_sdk.a",archive.getnames())
            self.assertIn("share/weapp-container/licenses/native/"+LINUX+"/licenses.json",archive.getnames())
            self.assertEqual(json.loads(archive.extractfile("package.json").read())["status"],"verified")

    def test_desktop_failed_or_stale_core_cannot_be_packaged(self):
        install,receipt,options=self.make_desktop()
        receipt["status"]="failed";self.write_json(install/"package.json",receipt)
        self.assert_rejected("successfully validated",**options)
        receipt["status"]="verified";receipt["native"][0]["artifacts"][0]["sha256"]="f"*64;self.write_json(install/"package.json",receipt)
        self.assert_rejected("native artifact digests",**options)

    def test_desktop_installed_core_bytes_must_match_even_if_wrapper_repins_them(self):
        install,receipt,options=self.make_desktop()
        file=install/"lib/libweapp_container_sdk.a";file.write_bytes(file.read_bytes()+b"stale core")
        next(item for item in receipt["artifacts"] if item["file"].endswith("sdk.a"))["sha256"]=sha(file.read_bytes())
        self.write_json(install/"package.json",receipt)
        self.assert_rejected("Installed core archive",**options)

    def make_android(self):
        for target in ANDROID:self.make_native(target)
        install=self.root/"android-install";path=install/f"maven/io/github/weapp-container/weapp-container-android/{packager.VERSION}/weapp-container-android-{packager.VERSION}.aar";path.parent.mkdir(parents=True)
        binaries=[]
        with zipfile.ZipFile(path,"w",compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("AndroidManifest.xml",b"public wrapper fixture manifest")
            for target in ANDROID:
                abi=packager.TARGETS[target][1]
                for library in ["libweapp_container_sdk.so","libc++_shared.so","libweapp_container_android.so"]:
                    data=(self.native/target/library).read_bytes() if library!="libweapp_container_android.so" else b"public wrapper JNI fixture "+abi.encode()
                    archive.writestr(f"jni/{abi}/{library}",data);binaries.append({"abi":abi,"library":library,"sha256":sha(data)})
        receipt={"schemaVersion":1,"sdkVersion":packager.VERSION,"status":"passed","sourceCommit":"b"*40,"sourceDirty":False,"native":[self.identity(target) for target in ANDROID],
                 "mavenArtifacts":[{"file":path.relative_to(install/"maven").as_posix(),"sha256":sha(path.read_bytes())}],"binaries":binaries,"checks":["fixture only"],"deviceExecution":"not-run"}
        self.write_json(install/"distribution.json",receipt);self.write_json(install/"validation.json",receipt)
        options=dict(component="android-sdk",platform="android",arch="universal",architectures="arm64-v8a,x86_64",install_dir=str(install))
        return install,receipt,path,options

    def test_android_archive_is_complete_and_preserves_no_device_execution_claim(self):
        install,receipt,aar,options=self.make_android();self.package(**options)
        manifest=json.loads((self.out/"manifest.json").read_text())
        pin=manifest["artifacts"][0];self.assertEqual(pin["architectures"],["arm64-v8a","x86_64"])
        with tarfile.open(self.out/pin["fileName"]) as archive:
            self.assertIn("validation.json",archive.getnames())
            self.assertEqual(json.loads(archive.extractfile("validation.json").read())["deviceExecution"],"not-run")
            self.assertTrue(any(name.startswith("platform-notices/") for name in archive.getnames()))

    def test_android_rejects_aars_repacked_with_foreign_core_even_when_wrapper_hashes_are_updated(self):
        install,receipt,path,options=self.make_android()
        with zipfile.ZipFile(path) as archive:entries={name:archive.read(name) for name in archive.namelist()}
        name="jni/arm64-v8a/libweapp_container_sdk.so";entries[name]+=b"foreign core"
        with zipfile.ZipFile(path,"w",compression=zipfile.ZIP_DEFLATED) as archive:
            for name,data in entries.items():archive.writestr(name,data)
        receipt["mavenArtifacts"][0]["sha256"]=sha(path.read_bytes())
        next(item for item in receipt["binaries"] if item["abi"]=="arm64-v8a" and item["library"]=="libweapp_container_sdk.so")["sha256"]=sha(entries["jni/arm64-v8a/libweapp_container_sdk.so"])
        self.write_json(install/"distribution.json",receipt);self.write_json(install/"validation.json",receipt)
        self.assert_rejected("pinned native receipts",**options)

    def test_android_preserves_newer_external_failure_and_rejects_missing_universal_slices(self):
        install,receipt,path,options=self.make_android()
        failed={**receipt,"status":"failed","error":"latest consumer failed"};self.write_json(install/"validation.json",failed)
        self.assert_rejected("external validation/failure",**options)
        self.write_json(install/"validation.json",receipt)
        options["architectures"]=None;self.assert_rejected("Unsupported or duplicate",**options)

    def test_nested_zip_private_source_and_credentials_are_rejected(self):
        for name,data in [("private.rs",b"do not distribute"),("config.txt",b"ghp_"+b"a"*30),("config.txt",b"/Users/private/project")]:
            with self.subTest(name=name,data=data[:10]):
                nested=io.BytesIO()
                with zipfile.ZipFile(nested,"w") as archive:archive.writestr(name,data)
                outer=io.BytesIO()
                with zipfile.ZipFile(outer,"w") as archive:archive.writestr("classes.jar",nested.getvalue())
                with zipfile.ZipFile(outer) as archive:
                    with self.assertRaises(packager.PackagingError):packager.scan_zip(archive)

    def test_fat_archive_verifies_each_original_slice(self):
        selected=[]
        for target in ["aarch64-apple-darwin","x86_64-apple-darwin"]:
            self.make_native(target);selected.append(packager.native_input(self.native,self.licenses,target,SOURCE))
        first,second=[native["files"]["libweapp_container_sdk.a"]["source"].read_bytes() for native in selected]
        header=b"\xca\xfe\xba\xbe"+struct.pack(">I",2)+struct.pack(">IIIII",0x100000c,0,48,len(first),0)+struct.pack(">IIIII",0x1000007,0,48+len(first),len(second),0)
        archive=self.root/"universal.a";archive.write_bytes(header+first+second)
        packager.verify_archive_slices(archive,selected)
        archive.write_bytes(header+first+second[:-1]+b"X")
        with self.assertRaisesRegex(packager.PackagingError,"bytes differ"):packager.verify_archive_slices(archive,selected)

    def make_ios(self):
        for target in IOS:self.make_native(target)
        install=self.root/"ios-install";install.mkdir()
        for name in ["Package.swift","WeappContainer.podspec","LICENSE","CONTRACT.md","README.md","ORIGIN.json"]:
            (install/name).write_text("{}\n" if name.endswith(".json") else "Public wrapper structural fixture\n")
        sources=install/"Sources/WeappContainer";sources.mkdir(parents=True);(sources/"Container.swift").write_text("// Authored public wrapper fixture\n")
        framework=install/"Frameworks/WeappContainerNative.xcframework";framework.mkdir(parents=True)
        entries=[]
        for simulator,targets,identifier in [(False,IOS[:1],"ios-arm64"),(True,IOS[1:],"ios-arm64_x86_64-simulator")]:
            directory=framework/identifier;(directory/"Headers").mkdir(parents=True)
            (directory/"Headers/weapp_container_sdk.h").write_bytes((ROOT/"test/fixtures/weapp_container_sdk.h").read_bytes())
            data=[(self.native/target/"libweapp_container_sdk.a").read_bytes() for target in targets]
            if len(data)==1:archive=data[0]
            else:archive=b"\xca\xfe\xba\xbe"+struct.pack(">I",2)+struct.pack(">IIIII",0x100000c,0,48,len(data[0]),0)+struct.pack(">IIIII",0x1000007,0,48+len(data[0]),len(data[1]),0)+b"".join(data)
            (directory/"libweapp_container_sdk.a").write_bytes(archive)
            entry={"LibraryIdentifier":identifier,"LibraryPath":"libweapp_container_sdk.a","HeadersPath":"Headers","SupportedPlatform":"ios","SupportedArchitectures":["arm64","x86_64"] if simulator else ["arm64"]}
            if simulator:entry["SupportedPlatformVariant"]="simulator"
            entries.append(entry)
        (framework/"Info.plist").write_bytes(plistlib.dumps({"AvailableLibraries":entries,"XCFrameworkFormatVersion":"1.0"}))
        receipt={"schemaVersion":1,"sdkVersion":packager.VERSION,"status":"built","sourceCommit":"c"*40,"sourceDirty":False,"native":[self.identity(target) for target in IOS],"artifacts":[]}
        for path in sorted(install.rglob("*")):
            if path.is_file():receipt["artifacts"].append({"file":path.relative_to(install).as_posix(),"sha256":sha(path.read_bytes())})
        self.write_json(install/"build.json",receipt)
        options=dict(component="ios-sdk",platform="ios",arch="universal",architectures="arm64-device,arm64-simulator,x86_64-simulator",install_dir=str(install))
        return install,receipt,options

    def test_ios_xcframework_pins_every_environment_and_fat_slice(self):
        install,receipt,options=self.make_ios();self.package(**options)
        pin=json.loads((self.out/"manifest.json").read_text())["artifacts"][0]
        self.assertEqual(len(pin["architectures"]),3)
        with tarfile.open(self.out/pin["fileName"]) as archive:
            self.assertIn("Frameworks/WeappContainerNative.xcframework/Info.plist",archive.getnames())
            self.assertIn("Sources/WeappContainer/Container.swift",archive.getnames())
            self.assertEqual(json.loads(archive.extractfile("build.json").read())["status"],"built")

    def test_ios_cannot_repin_a_foreign_simulator_archive(self):
        install,receipt,options=self.make_ios()
        path=install/"Frameworks/WeappContainerNative.xcframework/ios-arm64_x86_64-simulator/libweapp_container_sdk.a"
        path.write_bytes(path.read_bytes()[:-1]+b"X")
        next(item for item in receipt["artifacts"] if item["file"]==path.relative_to(install).as_posix())["sha256"]=sha(path.read_bytes())
        self.write_json(install/"build.json",receipt)
        self.assert_rejected("bytes differ",**options)

    def test_wrapper_abi_mismatch_and_failed_check_cannot_be_hidden(self):
        install,receipt,options=self.make_desktop()
        receipt["native"][0]["abiVersion"]=2;self.write_json(install/"package.json",receipt)
        self.assert_rejected("ABI version",**options)
        receipt["native"][0]["abiVersion"]=1;receipt["checks"].append({"exitCode":1,"status":"failed"});self.write_json(install/"package.json",receipt)
        self.assert_rejected("failed check",**options)

    def test_archive_writer_rechecks_input_after_initial_validation(self):
        self.make_native(LINUX)
        native=packager.native_input(self.native,self.licenses,LINUX,SOURCE)
        path=self.native/LINUX/"libweapp_container_sdk.a";path.write_bytes(path.read_bytes()+b"late change")
        with self.assertRaisesRegex(packager.PackagingError,"changed"):
            packager.write_archive(self.root/"late.tar.gz",native["files"])

    def test_unsupported_default_target_and_non_notice_allowlist_are_explicit(self):
        self.make_native(LINUX)
        unknown=self.native/"unknown-runtime";unknown.mkdir();(unknown/"build.json").write_text("{}")
        self.assert_rejected("Unsupported runtime receipt target")
        self.package(target=LINUX)
        unknown.joinpath("build.json").unlink();unknown.rmdir()
        self.receipts[LINUX]["artifacts"].append({"file":"platform-notices/private.c","bytes":1,"sha256":"f"*64});self.save_receipt(LINUX)
        self.assert_rejected("outside the allowlist",out_dir=str(self.root/"fresh"))

    def test_logical_home_route_is_not_confused_with_a_private_home_path(self):
        path=self.root/"public-data.txt";path.write_text("/pages/home/index and https://example.invalid/home/guide\n")
        packager.content(path)
        path.write_text("embedded actual /home/private-user/build\n")
        with self.assertRaisesRegex(packager.PackagingError,"private/local path"):
            packager.content(path)

    def test_cli_requires_source_pin_and_unknown_flags_fail(self):
        command=[sys.executable,str(ROOT/"tools/package_artifacts.py")]
        result=subprocess.run(command,capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0);self.assertIn("--source-commit",result.stderr)
        result=subprocess.run(command+["--help"],capture_output=True,text=True)
        self.assertEqual(result.returncode,0);self.assertIn("--architectures",result.stdout)

    def test_publication_preflight_verifies_fresh_core_archives_offline_without_publishing(self):
        self.make_native(LINUX); self.package()
        notes = self.root / "notes.md"; notes.write_text("Structural fixtures only; never publish these bytes.\n")
        command = ["node", str(ROOT / "tools/publish.mjs"), "--release-dir", str(self.out), "--notes-file", str(notes)]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["repository"], "weapp-container/weapp-container")
        self.assertFalse(report["published"])
        manifest = json.loads((self.out / "manifest.json").read_text())
        archive = self.out / manifest["artifacts"][0]["fileName"]
        archive.write_bytes(archive.read_bytes() + b"tampered")
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)

if __name__ == "__main__":
    unittest.main()
