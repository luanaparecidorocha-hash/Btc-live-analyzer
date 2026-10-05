#!/usr/bin/env python3
"""Collect evidence from the EXISTING BTC APK; never build/install/clear data."""
import argparse
import datetime
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

PACKAGE = "com.btcliveanalyzer.app"
ACTIVITY = PACKAGE + "/.MainActivity"
TAGS = [
    "AndroidRuntime:V", "ReactNativeJS:V", "ReactNative:V",
    "ReactNativeJNI:V", "ReactHost:V", "ExpoModulesCore:V", "SoLoader:V",
    "BtcAnalysisService:V", "BtcBackgroundAnalysis:V",
    "BtcScreenCapture:V", "ScreenCaptureService:V",
    "libc:F", "DEBUG:V", "tombstoned:V",
    "ActivityManager:W", "ActivityTaskManager:W", "*:S",
]


def run(adb, args, timeout=20):
    try:
        result = subprocess.run(
            adb + args, capture_output=True, text=True, errors="replace",
            timeout=timeout, check=False,
        )
        return result.returncode, result.stdout + result.stderr
    except subprocess.TimeoutExpired:
        return 124, "Command timed out: " + " ".join(args) + "\n"


def app_java_crashes(text):
    """Keep full AndroidRuntime stacks for PIDs explicitly attributed to BTC."""
    lines = text.splitlines()
    pids = set()
    process = re.compile(r"Process:\s*" + re.escape(PACKAGE) + r"(?=[:,\s]|$)")
    runtime = re.compile(r"\s(\d+)\s+\d+\s+[VDIWEF]\s+AndroidRuntime\s*:")
    for line in lines:
        match = runtime.search(line)
        if match and process.search(line):
            pids.add(match.group(1))
    return "\n".join(
        line for line in lines
        if (match := runtime.search(line)) and match.group(1) in pids
    )


def collect(adb, destination, duration):
    destination.mkdir(parents=True, exist_ok=True)
    status, installed = run(adb, ["shell", "pm", "path", PACKAGE])
    if status or not installed.strip().startswith("package:"):
        raise RuntimeError("O APK BTC não está instalado neste dispositivo: " + installed.strip())

    metadata = {"package": PACKAGE, "capturedAtUTC": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    for name, prop in (
        ("model", "ro.product.model"),
        ("androidVersion", "ro.build.version.release"),
        ("androidSDK", "ro.build.version.sdk"),
        ("abis", "ro.product.cpu.abilist"),
    ):
        status, value = run(adb, ["shell", "getprop", prop])
        metadata[name] = value.strip() if status == 0 else {"error": value.strip()}
    status, page_size = run(adb, ["shell", "getconf", "PAGE_SIZE"])
    metadata["pageSize"] = page_size.strip() if status == 0 else {"error": page_size.strip()}
    status, package_info = run(adb, ["shell", "dumpsys", "package", PACKAGE])
    metadata["installedVersion"] = [
        line.strip() for line in package_info.splitlines()
        if re.search(r"\b(versionCode|versionName|targetSdk|userId)=", line)
    ] if status == 0 else {"error": package_info.strip()}
    (destination / "device.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")

    status, previous = run(adb, ["logcat", "-b", "crash", "-d", "-v", "threadtime"])
    (destination / "previous-crash-LOCAL.txt").write_text(previous, encoding="utf-8")
    if status:
        raise RuntimeError("Não foi possível ler o buffer de crash: " + previous.strip())

    print("Capturando o APK já instalado. Sem reinstalar, limpar dados ou parar os serviços.")
    print("O app será aberto. Se ele permanecer aberto, toque em INICIAR ANÁLISE.")
    print("Se fechar, NÃO desconecte o cabo; aguarde o fim da coleta.")
    live_file = destination / "runtime-LOCAL.txt"
    launch = ""
    with live_file.open("w", encoding="utf-8") as handle:
        logcat = subprocess.Popen(
            adb + ["logcat", "-b", "crash", "-b", "main", "-b", "system", "-v", "threadtime"] + TAGS,
            stdout=handle, stderr=subprocess.STDOUT,
        )
        try:
            _, launch = run(adb, ["shell", "am", "start", "-W", "-n", ACTIVITY])
            deadline = time.monotonic() + duration
            while time.monotonic() < deadline:
                if logcat.poll() is not None:
                    raise RuntimeError("A coleta logcat terminou antes do esperado; veja runtime-LOCAL.txt.")
                time.sleep(min(1, max(0, deadline - time.monotonic())))
        finally:
            if logcat.poll() is None:
                logcat.terminate()
                try:
                    logcat.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    logcat.kill()
                    logcat.wait(timeout=5)

    (destination / "launch.txt").write_text(launch, encoding="utf-8")
    _, after = run(adb, ["logcat", "-b", "crash", "-d", "-v", "threadtime"])
    (destination / "after-crash-LOCAL.txt").write_text(after, encoding="utf-8")
    _, exits = run(adb, ["shell", "dumpsys", "activity", "exit-info", PACKAGE])
    (destination / "exit-info.txt").write_text(exits, encoding="utf-8")
    live = live_file.read_text(encoding="utf-8", errors="replace")
    java = app_java_crashes(after + "\n" + live)
    output = destination / "btc-fatal-exception.txt"
    output.write_text(java + "\n" if java else (
        "Nenhum FATAL EXCEPTION Java atribuído explicitamente ao pacote BTC foi encontrado.\n"
        "Isso NÃO prova ausência de crash. Confira exit-info.txt e os arquivos LOCAL para\n"
        "Fatal signal/tombstone, ANR, JavascriptException ou encerramento pelo sistema.\n"
        "Não atribua uma causa ao código sem essas evidências.\n"
    ), encoding="utf-8")
    print("Coleta concluída:", destination.resolve())
    print("Revise e envie btc-fatal-exception.txt, device.json, exit-info.txt e launch.txt.")
    print("Arquivos LOCAL podem incluir outros apps: não os envie integralmente sem revisar.")
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", help="Dispositivo ADB, somente se houver mais de um conectado.")
    parser.add_argument("--seconds", type=int, default=70, help="Duração da coleta após abrir o app (10–300).")
    parser.add_argument("--output", help="Pasta local para os arquivos do diagnóstico.")
    args = parser.parse_args()
    if not 10 <= args.seconds <= 300:
        parser.error("--seconds deve ser entre 10 e 300")
    executable = shutil.which("adb")
    if executable is None:
        parser.error("ADB não encontrado. Instale Android SDK Platform-Tools e adicione adb ao PATH.")
    adb = [executable]
    if args.serial:
        adb += ["-s", args.serial]
    else:
        status, devices = run(adb, ["devices"])
        authorized = [
            row.split()[0] for row in devices.splitlines()
            if len(row.split()) == 2 and row.split()[1] == "device"
        ]
        if status or len(authorized) != 1:
            parser.error("Conecte e autorize UM Android por USB; com vários, use --serial. Nenhum dado foi limpo.")
        adb += ["-s", authorized[0]]
    name = "btc-diagnostic-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    try:
        collect(adb, Path(args.output or name), args.seconds)
    except (RuntimeError, OSError) as error:
        print("Falha na coleta:", error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
