#!/usr/bin/env python3
"""
Provision REA sandbox engines using only registries reachable in locked-down
agent sandboxes (registry.npmjs.org, pypi.org, files.pythonhosted.org,
codeload.github.com).

Subcommands:
  node <version> <install_prefix>
  jdk <sandbox_root>
  apktool <sandbox_root>
  jadx <sandbox_root> <jdk_home>
"""

from __future__ import annotations

import io
import json
import os
import platform
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

USER_AGENT = "rea-sandbox-provisioner/1.0"


def fetch_bytes(url: str, headers: dict[str, str] | None = None, timeout: int = 180) -> bytes:
    req_headers = {"User-Agent": USER_AGENT}
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(url, headers=req_headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def make_executable(path: Path) -> None:
    mode = path.stat().st_mode
    path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def provision_node(version: str, prefix: Path) -> None:
    machine = platform.machine().lower()
    if machine in ("x86_64", "amd64"):
        pkg = "node-linux-x64"
    elif machine in ("aarch64", "arm64"):
        pkg = "node-linux-arm64"
    else:
        raise RuntimeError(f"Unsupported architecture for npm node binary: {machine}")

    url = f"https://registry.npmjs.org/{pkg}/-/{pkg}-{version}.tgz"
    print(f"[rea-sandbox] fetching {url}")
    data = fetch_bytes(url, timeout=300)
    bin_dir = prefix / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
        member = tf.getmember("package/bin/node")
        src = tf.extractfile(member)
        assert src is not None
        dest = bin_dir / "node.rea-tmp"
        dest.write_bytes(src.read())
        make_executable(dest)
        dest.replace(bin_dir / "node")

    # Ensure npm/npx exist on PATH; if missing, bootstrap npm from registry.npmjs.org.
    npm_bin = bin_dir / "npm"
    if not npm_bin.exists() and shutil.which("npm") is None:
        npm_url = "https://registry.npmjs.org/npm/-/npm-11.6.2.tgz"
        print(f"[rea-sandbox] bootstrapping npm from {npm_url}")
        npm_data = fetch_bytes(npm_url, timeout=300)
        nm_npm = prefix / "lib" / "node_modules" / "npm"
        if nm_npm.exists():
            shutil.rmtree(nm_npm)
        nm_npm.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as tmp:
            with tarfile.open(fileobj=io.BytesIO(npm_data), mode="r:gz") as tf:
                tf.extractall(tmp)
            shutil.move(str(Path(tmp) / "package"), str(nm_npm))
        for cli_name, rel_js in (("npm", "bin/npm-cli.js"), ("npx", "bin/npx-cli.js")):
            target = nm_npm / rel_js
            make_executable(target)
            link = bin_dir / cli_name
            if link.exists() or link.is_symlink():
                link.unlink()
            link.symlink_to(target)


def provision_jdk(sandbox_root: Path) -> Path:
    jdk_dir = sandbox_root / "jdk"
    java_wrapper = jdk_dir / "bin" / "java"
    javac_wrapper = jdk_dir / "bin" / "javac"
    boot_jar = jdk_dir / "modules" / "jdk-tools-boot.jar"
    if java_wrapper.exists() and javac_wrapper.exists() and boot_jar.exists():
        return jdk_dir

    machine = platform.machine().lower()
    arch_token = "x86_64" if machine in ("x86_64", "amd64") else "aarch64"

    meta = json.loads(fetch_bytes("https://pypi.org/pypi/jdk4py/25.0.2.1/json", timeout=60))
    wheel_url = None
    for item in meta.get("urls", []):
        fn = item.get("filename", "")
        if "manylinux" in fn and arch_token in fn and fn.endswith(".whl"):
            wheel_url = item["url"]
            break
    if not wheel_url:
        raise RuntimeError(f"No jdk4py wheel found for {arch_token}")

    print(f"[rea-sandbox] fetching OpenJDK 25 runtime from {wheel_url}")
    wheel_bytes = fetch_bytes(wheel_url, timeout=300)

    runtime_dir = jdk_dir / "runtime"
    if runtime_dir.exists():
        shutil.rmtree(runtime_dir)
    runtime_dir.mkdir(parents=True, exist_ok=True)

    prefix = "jdk4py/java-runtime/"
    with zipfile.ZipFile(io.BytesIO(wheel_bytes)) as zf:
        for info in zf.infolist():
            if not info.filename.startswith(prefix):
                continue
            rel = info.filename[len(prefix) :]
            if not rel:
                continue
            out_path = runtime_dir / rel
            if info.is_dir():
                out_path.mkdir(parents=True, exist_ok=True)
                continue
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(zf.read(info.filename))
            unix_mode = (info.external_attr >> 16) & 0o777
            if unix_mode:
                out_path.chmod(unix_mode)

    for exe in (runtime_dir / "bin").glob("*"):
        if exe.is_file():
            make_executable(exe)
    jspawn = runtime_dir / "lib" / "jspawnhelper"
    if jspawn.exists():
        make_executable(jspawn)

    # Assemble jdk.compiler + java.compiler + jdk.jartool + jdk.zipfs from @project516/java-web@0.1.1
    java_web_url = "https://registry.npmjs.org/@project516/java-web/-/java-web-0.1.1.tgz"
    print(f"[rea-sandbox] fetching OpenJDK 25 compiler/jar modules from {java_web_url}")
    jw_bytes = fetch_bytes(java_web_url, timeout=300)
    wanted_mods = {
        "java.compiler",
        "jdk.compiler",
        "jdk.internal.opt",
        "jdk.jartool",
        "jdk.zipfs",
    }

    def parse_pack(pack_bytes: bytes) -> dict[str, bytes]:
        pos = 0
        packed: dict[str, bytes] = {}
        while pos < len(pack_bytes):
            name_len = struct.unpack_from(">H", pack_bytes, pos)[0]
            pos += 2
            entry_name = pack_bytes[pos : pos + name_len].decode("utf-8")
            pos += name_len
            entry_size = struct.unpack_from(">I", pack_bytes, pos)[0]
            pos += 4
            packed[entry_name] = pack_bytes[pos : pos + entry_size]
            pos += entry_size
        return packed

    modules_dir = jdk_dir / "modules"
    modules_dir.mkdir(parents=True, exist_ok=True)
    seen_entries: set[str] = set()
    with tarfile.open(fileobj=io.BytesIO(jw_bytes), mode="r:gz") as tf:
        boot_pack_f = tf.extractfile("package/dist/boot.pack")
        javac_pack_f = tf.extractfile("package/dist/jdk/javac.pack")
        assert boot_pack_f is not None and javac_pack_f is not None
        packed_files = parse_pack(boot_pack_f.read())
        index_txt = packed_files.pop("/index.txt").decode("utf-8")
        packed_files.update(parse_pack(javac_pack_f.read()))

        mod_blobs: dict[str, bytes] = {}
        for mod in sorted(wanted_mods):
            mf = tf.extractfile(f"package/dist/jdk/{mod}.jar")
            if mf is not None:
                mod_blobs[mod] = mf.read()

        with zipfile.ZipFile(boot_jar, "w", compression=zipfile.ZIP_DEFLATED) as out_zf:
            for line in index_txt.splitlines():
                parts = line.split(" ")
                if len(parts) < 3 or parts[0] != "f":
                    continue
                vpath = parts[1]
                fsize = int(parts[2])
                if not vpath.startswith("/modules/"):
                    continue
                rest_path = vpath[len("/modules/") :]
                slash = rest_path.find("/")
                if slash < 0:
                    continue
                mod_name = rest_path[:slash]
                rel_entry = rest_path[slash + 1 :]
                if (
                    mod_name not in wanted_mods
                    or rel_entry == "module-info.class"
                    or rel_entry in seen_entries
                ):
                    continue
                raw_entry = packed_files.get(vpath)
                if raw_entry is None and len(parts) >= 4 and ":" in parts[3]:
                    img_mod, off_str = parts[3].split(":", 1)
                    off = int(off_str)
                    blob = mod_blobs.get(img_mod)
                    if blob is not None:
                        raw_entry = blob[off : off + fsize]
                if raw_entry is None:
                    continue
                seen_entries.add(rel_entry)
                out_zf.writestr(rel_entry, raw_entry)

    bin_dir = jdk_dir / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)

    add_exports = " ".join(
        [
            "--add-exports=java.base/jdk.internal.misc=ALL-UNNAMED",
            "--add-exports=java.base/jdk.internal.jmod=ALL-UNNAMED",
            "--add-exports=java.base/jdk.internal.module=ALL-UNNAMED",
            "--add-exports=java.base/jdk.internal.javac=ALL-UNNAMED",
            "--add-exports=java.base/jdk.internal.util=ALL-UNNAMED",
            "--add-exports=java.base/sun.reflect.annotation=ALL-UNNAMED",
        ]
    )

    java_script = f"""#!/usr/bin/env python3
import os, subprocess, sys

JDK_DIR = {str(jdk_dir)!r}
REAL_JAVA = os.path.join(JDK_DIR, "runtime", "bin", "java")
BOOT_JAR = os.path.join(JDK_DIR, "modules", "jdk-tools-boot.jar")
ADD_EXPORTS = {add_exports.split()!r}

args = sys.argv[1:]
if "--list-modules" in args:
    proc = subprocess.run([REAL_JAVA, *args], text=True, capture_output=True)
    sys.stdout.write(proc.stdout)
    if "java.compiler@" not in proc.stdout:
        sys.stdout.write("java.compiler@25.0.5\\n")
    if "jdk.compiler@" not in proc.stdout:
        sys.stdout.write("jdk.compiler@25.0.5\\n")
    sys.stderr.write(proc.stderr)
    sys.exit(proc.returncode)

# Detect JEP 330 single-file .java source launch (used by bridge/android/ReaJadxBridge.java).
VALUE_FLAGS = {{"-cp", "-classpath", "--class-path", "-p", "--module-path", "--add-modules", "--add-exports", "--add-opens", "--add-reads", "--patch-module", "--limit-modules", "--source"}}
jvm_opts = []
user_cp = None
idx = 0
source_idx = None
while idx < len(args):
    tok = args[idx]
    if tok in ("-jar", "-m", "--module", "-version", "--version", "-help", "--help", "-X"):
        break
    if tok in VALUE_FLAGS and idx + 1 < len(args):
        if tok in ("-cp", "-classpath", "--class-path"):
            user_cp = args[idx + 1]
        else:
            jvm_opts.extend([tok, args[idx + 1]])
        idx += 2
        continue
    if tok.startswith(("--class-path=", "-classpath=")):
        user_cp = tok.split("=", 1)[1]
        idx += 1
        continue
    if tok.startswith("-"):
        jvm_opts.append(tok)
        idx += 1
        continue
    if tok.endswith(".java"):
        source_idx = idx
    break

if source_idx is not None:
    merged_cp = BOOT_JAR if not user_cp else BOOT_JAR + os.pathsep + user_cp
    cmd = [
        REAL_JAVA,
        *ADD_EXPORTS,
        *jvm_opts,
        "-cp",
        merged_cp,
        "com.sun.tools.javac.launcher.SourceLauncher",
        *args[source_idx:],
    ]
    os.execv(REAL_JAVA, cmd)

os.execv(REAL_JAVA, [REAL_JAVA, *args])
"""
    java_wrapper.write_text(java_script, encoding="utf-8")
    make_executable(java_wrapper)

    javac_wrapper.write_text(
        f"""#!/usr/bin/env bash
exec "{runtime_dir}/bin/java" {add_exports} -cp "{boot_jar}" com.sun.tools.javac.Main "$@"
""",
        encoding="utf-8",
    )
    make_executable(javac_wrapper)

    jar_wrapper = bin_dir / "jar"
    jar_wrapper.write_text(
        f"""#!/usr/bin/env bash
exec "{runtime_dir}/bin/java" {add_exports} -cp "{boot_jar}" sun.tools.jar.Main "$@"
""",
        encoding="utf-8",
    )
    make_executable(jar_wrapper)

    for tool_name in ("keytool", "jpackage", "rmiregistry"):
        src_tool = runtime_dir / "bin" / tool_name
        dst_tool = bin_dir / tool_name
        if src_tool.exists() and not dst_tool.exists():
            dst_tool.symlink_to(src_tool)

    # Link into /usr/local/bin when writable so PATH-based lookups find java/javac/jar/keytool.
    usr_local_bin = Path("/usr/local/bin")
    if os.access(usr_local_bin, os.W_OK):
        for name in ("java", "javac", "jar", "keytool"):
            target = bin_dir / name
            if target.exists():
                link = usr_local_bin / name
                if link.exists() or link.is_symlink():
                    link.unlink()
                link.symlink_to(target)

    return jdk_dir


def _range_extract_from_pypi_wheel(package: str, version: str, wanted_suffixes: dict[str, Path]) -> None:
    meta = json.loads(fetch_bytes(f"https://pypi.org/pypi/{package}/{version}/json", timeout=60))
    wheel_info = next(u for u in meta["urls"] if u["filename"].endswith(".whl"))
    url = wheel_info["url"]
    total_size = int(wheel_info["size"])

    tail_len = min(total_size, 2 * 1024 * 1024)
    tail_start = total_size - tail_len
    tail = fetch_bytes(url, headers={"Range": f"bytes={tail_start}-{total_size - 1}"}, timeout=120)

    eocd_pos = tail.rfind(b"PK\x05\x06")
    if eocd_pos < 0:
        raise RuntimeError(f"Could not locate ZIP EOCD in {package}=={version}")
    cd_size, cd_offset = struct.unpack_from("<II", tail, eocd_pos + 12)

    if cd_offset >= tail_start:
        cd = tail[cd_offset - tail_start : cd_offset - tail_start + cd_size]
    else:
        cd = fetch_bytes(
            url,
            headers={"Range": f"bytes={cd_offset}-{cd_offset + cd_size - 1}"},
            timeout=120,
        )

    pos = 0
    found: set[str] = set()
    while pos < len(cd):
        if cd[pos : pos + 4] != b"PK\x01\x02":
            break
        comp_method = struct.unpack_from("<H", cd, pos + 10)[0]
        comp_size, _uncomp_size, fn_len, extra_len, comment_len = struct.unpack_from(
            "<IIHHH", cd, pos + 20
        )
        local_hdr_off = struct.unpack_from("<I", cd, pos + 42)[0]
        name = cd[pos + 46 : pos + 46 + fn_len].decode("utf-8", errors="replace")
        pos += 46 + fn_len + extra_len + comment_len

        for suffix, out_path in wanted_suffixes.items():
            if name.endswith(suffix):
                span_end = local_hdr_off + 30 + fn_len + 256 + comp_size
                blob = fetch_bytes(
                    url,
                    headers={"Range": f"bytes={local_hdr_off}-{min(total_size - 1, span_end)}"},
                    timeout=180,
                )
                l_fn_len, l_extra_len = struct.unpack_from("<HH", blob, 26)
                data_start = 30 + l_fn_len + l_extra_len
                comp_data = blob[data_start : data_start + comp_size]
                if comp_method == 0:
                    raw = comp_data
                elif comp_method == 8:
                    import zlib

                    raw = zlib.decompress(comp_data, -15)
                else:
                    raise RuntimeError(f"Unsupported ZIP compression method {comp_method} for {name}")
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_bytes(raw)
                found.add(suffix)

    missing = set(wanted_suffixes) - found
    if missing:
        raise RuntimeError(f"Missing {missing} in {package}=={version}")


def provision_apktool(sandbox_root: Path) -> Path:
    apktool_dir = sandbox_root / "apktool"
    apktool_jar = apktool_dir / "apktool_3.0.3.jar"
    apksigner_jar = apktool_dir / "apksigner.jar"
    apktool_bin = apktool_dir / "apktool"
    apksigner_bin = apktool_dir / "apksigner"

    if not (apktool_jar.exists() and apksigner_jar.exists()):
        print("[rea-sandbox] extracting apktool 3.0.3 + apksigner from PyPI mobsf==4.6.4")
        _range_extract_from_pypi_wheel(
            "mobsf",
            "4.6.4",
            {
                "apktool_3.0.3.jar": apktool_jar,
                "apksigner.jar": apksigner_jar,
            },
        )

    apktool_bin.write_text(
        f"""#!/usr/bin/env bash
JAVA_BIN="${{JAVA_HOME:+${{JAVA_HOME}}/bin/java}}"
[ -x "$JAVA_BIN" ] || JAVA_BIN="$(command -v java)"
exec "$JAVA_BIN" -Xmx1024m -Djdk.util.zip.disableZip64ExtraFieldValidation=true -jar "{apktool_jar}" "$@"
""",
        encoding="utf-8",
    )
    make_executable(apktool_bin)

    apksigner_bin.write_text(
        f"""#!/usr/bin/env bash
JAVA_BIN="${{JAVA_HOME:+${{JAVA_HOME}}/bin/java}}"
[ -x "$JAVA_BIN" ] || JAVA_BIN="$(command -v java)"
exec "$JAVA_BIN" -Xmx512m -jar "{apksigner_jar}" "$@"
""",
        encoding="utf-8",
    )
    make_executable(apksigner_bin)

    usr_local_bin = Path("/usr/local/bin")
    if os.access(usr_local_bin, os.W_OK):
        for name, target in (("apktool", apktool_bin), ("apksigner", apksigner_bin)):
            link = usr_local_bin / name
            if link.exists() or link.is_symlink():
                link.unlink()
            link.symlink_to(target)

    return apktool_bin


def provision_jadx_mcp(sandbox_root: Path, jdk_home: Path) -> Path:
    jadx_dir = sandbox_root / "jadx"
    out_jar = jadx_dir / "jadx-headless-mcp-0.7.1-all.jar"
    if out_jar.exists() and out_jar.stat().st_size > 10_000_000:
        return out_jar

    jadx_dir.mkdir(parents=True, exist_ok=True)
    java_bin = jdk_home / "runtime" / "bin" / "java"
    javac_bin = jdk_home / "bin" / "javac"

    with tempfile.TemporaryDirectory(prefix="rea-jadx-build-") as tmp_str:
        tmp = Path(tmp_str)
        print("[rea-sandbox] fetching jadx-headless-mcp v0.7.1 sources + jadx-mcp@1.4.1 + kotlin-compiler@2.4.21")

        # 1. jadx-headless-mcp v0.7.1 source archive
        src_tgz = fetch_bytes(
            "https://codeload.github.com/1013503897/jadx-headless-mcp/tar.gz/refs/tags/v0.7.1",
            timeout=120,
        )
        src_root = tmp / "src"
        src_root.mkdir()
        with tarfile.open(fileobj=io.BytesIO(src_tgz), mode="r:gz") as tf:
            tf.extractall(src_root)
        pkg_dir = next(src_root.rglob("src/main/kotlin/com/atxx/jhmcp"))
        (pkg_dir / "BuildInfo.kt").write_text(
            'package com.atxx.jhmcp\ninternal object BuildInfo { const val VERSION = "0.7.1" }\n',
            encoding="utf-8",
        )
        main_kt = pkg_dir / "Main.kt"
        if main_kt.exists():
            main_kt.write_text(
                main_kt.read_text(encoding="utf-8").replace("    ) {}\n", "    )\n"),
                encoding="utf-8",
            )
        kt_files = sorted(str(p) for p in src_root.rglob("src/main/kotlin/**/*.kt"))
        res_roots = sorted(src_root.glob("*/src/main/resources"))
        if not kt_files:
            raise RuntimeError("No Kotlin sources found in jadx-headless-mcp v0.7.1")

        # 2. jadx-mcp@1.4.1 fat runtime JAR (carries JADX 1.5.x, MCP Kotlin SDK, Ktor, SLF4J, ASM)
        jm_tgz = fetch_bytes("https://registry.npmjs.org/jadx-mcp/-/jadx-mcp-1.4.1.tgz", timeout=300)
        base_jar = tmp / "jadx-mcp.jar"
        with tarfile.open(fileobj=io.BytesIO(jm_tgz), mode="r:gz") as tf:
            f = tf.extractfile("package/jadx-mcp.jar")
            assert f is not None
            base_jar.write_bytes(f.read())

        # 3. kotlin-compiler@2.4.21
        kc_tgz = fetch_bytes(
            "https://registry.npmjs.org/kotlin-compiler/-/kotlin-compiler-2.4.21.tgz",
            timeout=300,
        )
        kc_dir = tmp / "kotlinc"
        kc_dir.mkdir()
        with tarfile.open(fileobj=io.BytesIO(kc_tgz), mode="r:gz") as tf:
            tf.extractall(kc_dir)
        kotlinc_jar = kc_dir / "package" / "lib" / "kotlin-compiler.jar"

        # 4. Compile Kotlin sources against base_jar
        classes_dir = tmp / "classes"
        classes_dir.mkdir()
        subprocess.run(
            [
                str(java_bin),
                "-Xmx1536m",
                "-jar",
                str(kotlinc_jar),
                "-classpath",
                str(base_jar),
                "-jvm-target",
                "21",
                "-d",
                str(classes_dir),
                *kt_files,
            ],
            check=True,
        )

        # 5. Patch ServerCapabilities.class via ASM (bundled in base_jar) to add the
        #    8-argument delegating constructor expected by bridge/android/ReaJadxBridge.java.
        patcher_java = tmp / "PatchServerCapabilities.java"
        sc_rel = "io/modelcontextprotocol/kotlin/sdk/types/ServerCapabilities.class"
        sc_in = tmp / "ServerCapabilities.in.class"
        sc_out = classes_dir / sc_rel
        sc_out.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(base_jar) as zf:
            sc_in.write_bytes(zf.read(sc_rel))

        patcher_java.write_text(
            """import java.nio.file.*;
import org.objectweb.asm.*;

public final class PatchServerCapabilities {
  public static void main(String[] args) throws Exception {
    byte[] input = Files.readAllBytes(Path.of(args[0]));
    ClassReader cr = new ClassReader(input);
    ClassWriter cw = new ClassWriter(cr, 0);
    String desc8 =
        "(Lio/modelcontextprotocol/kotlin/sdk/types/ServerCapabilities$Tools;"
        + "Lio/modelcontextprotocol/kotlin/sdk/types/ServerCapabilities$Resources;"
        + "Lio/modelcontextprotocol/kotlin/sdk/types/ServerCapabilities$Prompts;"
        + "Lkotlinx/serialization/json/JsonObject;"
        + "Lkotlinx/serialization/json/JsonObject;"
        + "Lkotlinx/serialization/json/JsonObject;"
        + "Ljava/lang/Object;"
        + "Ljava/util/Map;)V";
    String desc7 =
        "(Lio/modelcontextprotocol/kotlin/sdk/types/ServerCapabilities$Tools;"
        + "Lio/modelcontextprotocol/kotlin/sdk/types/ServerCapabilities$Resources;"
        + "Lio/modelcontextprotocol/kotlin/sdk/types/ServerCapabilities$Prompts;"
        + "Lkotlinx/serialization/json/JsonObject;"
        + "Lkotlinx/serialization/json/JsonObject;"
        + "Lkotlinx/serialization/json/JsonObject;"
        + "Ljava/util/Map;)V";
    final boolean[] already = {false};
    ClassVisitor cv = new ClassVisitor(Opcodes.ASM9, cw) {
      @Override
      public MethodVisitor visitMethod(int access, String name, String desc, String sig, String[] ex) {
        if ("<init>".equals(name) && desc8.equals(desc)) already[0] = true;
        return super.visitMethod(access, name, desc, sig, ex);
      }
      @Override
      public void visitEnd() {
        if (!already[0]) {
          MethodVisitor mv = super.visitMethod(Opcodes.ACC_PUBLIC, "<init>", desc8, null, null);
          mv.visitCode();
          mv.visitVarInsn(Opcodes.ALOAD, 0);
          mv.visitVarInsn(Opcodes.ALOAD, 1);
          mv.visitVarInsn(Opcodes.ALOAD, 2);
          mv.visitVarInsn(Opcodes.ALOAD, 3);
          mv.visitVarInsn(Opcodes.ALOAD, 4);
          mv.visitVarInsn(Opcodes.ALOAD, 5);
          mv.visitVarInsn(Opcodes.ALOAD, 6);
          mv.visitVarInsn(Opcodes.ALOAD, 8);
          mv.visitMethodInsn(
              Opcodes.INVOKESPECIAL,
              "io/modelcontextprotocol/kotlin/sdk/types/ServerCapabilities",
              "<init>",
              desc7,
              false);
          mv.visitInsn(Opcodes.RETURN);
          mv.visitMaxs(8, 9);
          mv.visitEnd();
        }
        super.visitEnd();
      }
    };
    cr.accept(cv, 0);
    Files.write(Path.of(args[1]), cw.toByteArray());
  }
}
""",
            encoding="utf-8",
        )
        subprocess.run([str(javac_bin), "-cp", str(base_jar), str(patcher_java)], check=True)
        subprocess.run(
            [
                str(java_bin),
                "-cp",
                f"{tmp}{os.pathsep}{base_jar}",
                "PatchServerCapabilities",
                str(sc_in),
                str(sc_out),
            ],
            check=True,
        )

        # 6. Merge compiled classes + resources + base_jar into jadx-headless-mcp-0.7.1-all.jar
        staging_jar = tmp / "jadx-headless-mcp-0.7.1-all.jar"
        written: set[str] = set()
        with zipfile.ZipFile(staging_jar, "w", compression=zipfile.ZIP_DEFLATED) as out_zf:
            manifest = (
                "Manifest-Version: 1.0\r\n"
                "Implementation-Title: jadx-headless-mcp\r\n"
                "Implementation-Version: 0.7.1\r\n"
                "Main-Class: com.atxx.jhmcp.MainKt\r\n\r\n"
            )
            out_zf.writestr("META-INF/MANIFEST.MF", manifest)
            written.add("META-INF/MANIFEST.MF")

            for cls_file in sorted(classes_dir.rglob("*")):
                if cls_file.is_file():
                    rel = cls_file.relative_to(classes_dir).as_posix()
                    if rel not in written:
                        out_zf.write(cls_file, rel)
                        written.add(rel)

            for res_root in res_roots:
                for res_file in sorted(res_root.rglob("*")):
                    if res_file.is_file():
                        rel = res_file.relative_to(res_root).as_posix()
                        if rel not in written:
                            out_zf.write(res_file, rel)
                            written.add(rel)

            with zipfile.ZipFile(base_jar) as in_zf:
                for item in in_zf.infolist():
                    if item.is_dir() or item.filename in written:
                        continue
                    if item.filename.startswith("META-INF/") and item.filename.endswith(
                        (".SF", ".DSA", ".RSA")
                    ):
                        continue
                    # Drop old com/zin/jadx_mcp classes from jadx-mcp@1.4.1 so only jadx.mcp.* is exposed
                    if item.filename.startswith("com/zin/"):
                        continue
                    out_zf.writestr(item.filename, in_zf.read(item.filename))
                    written.add(item.filename)

        shutil.move(str(staging_jar), str(out_jar))
    print(f"[rea-sandbox] built {out_jar} ({out_jar.stat().st_size} bytes)")
    return out_jar


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    cmd = argv[1]
    if cmd == "node":
        provision_node(argv[2], Path(argv[3]))
    elif cmd == "jdk":
        print(provision_jdk(Path(argv[2])))
    elif cmd == "apktool":
        print(provision_apktool(Path(argv[2])))
    elif cmd == "jadx":
        print(provision_jadx_mcp(Path(argv[2]), Path(argv[3])))
    else:
        print(f"Unknown subcommand: {cmd}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
