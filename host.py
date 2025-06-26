# -*- coding: utf-8 -*-
"""camera_control_server.py

A Flask‑based service for controlling an edge‑AI camera platform that uses
GStreamer for video pipelines, LX‑16A servos for pan/tilt, GPIO for power, and
an SSD1306 OLED for status display.

• Stream control:  /stream/<hls|udp|rtsp>   GET/POST JSON
    {
        "on":   true|false,
        "view": "pure"|"yolo",
        "url":  "<protocol‑specific URL>"
    }

• Power control:   /power/camera            GET/POST JSON {"on": true|false}
• Motion control:  /motion/<pan|tilt>       GET/POST JSON {"angle": 0‑240}
• Hostname:        /system/hostname         GET/POST JSON {"hostname": "cam01"}
• Temperature:     /system/temperature      GET only

Requirements
------------
$ pip install flask periphery pylx16a luma.oled psutil
(plus GStreamer and Avahi installed on the host)

Run as root (servos/I2C/GPIO need privileges):
$ sudo python3 camera_control_server.py
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import signal
import socket
import subprocess
import threading
import time
from pathlib import Path
from typing import Dict, Optional, Tuple

import psutil  # lightweight; used for extra temperature sensors
from flask import Flask, jsonify, request, send_from_directory, redirect
from periphery import GPIO
from pylx16a.lx16a import LX16A, ServoTimeoutError
from luma.core.interface.serial import i2c
from luma.oled.device import ssd1306

# ---------------------------------------------------------------------------
# Hardware / global state initialisation
# ---------------------------------------------------------------------------

app = Flask(__name__)

# Streaming pipeline processes {(protocol): subprocess.Popen}
PIPELINES: Dict[str, subprocess.Popen] = {}

# GPIO camera power (pin 96)
CAMERA_GPIO_PIN = 96
CAM_POWER = GPIO(CAMERA_GPIO_PIN, "out")
HUB_GPIO_PIN = 47
HUB_POWER = GPIO(HUB_GPIO_PIN, "out")

# LX‑16A servos: 1 = pan, 2 = tilt
try:
    LX16A.initialize("/dev/ttyS6")
    SERVO_PAN = LX16A(1)
    SERVO_TILT = LX16A(2)
    SERVO_PAN.set_angle_limits(120-45, 120+45)
    SERVO_TILT.set_angle_limits(120-45, 120+45)
except ServoTimeoutError as e:
    print(f"[WARN] Servo {e.id_} not responding")
    SERVO_PAN = SERVO_TILT = None

# I2C‑4 SSD1306 OLED, 128×64
try:
    serial = i2c(port=4, address=0x3C)  # Adjust if your board maps differently
    OLED = ssd1306(serial, width=128, height=64)
except Exception as e:  # noqa: BLE001
    print(f"[WARN] OLED init failed: {e}")
    OLED = None

OLED_LOCK = threading.Lock()
# 舵机访问锁，防止并发访问导致数据串扰
SERVO_LOCK = threading.Lock()

# 配置持久化文件
CONFIG_FILE = "device_config.json"
DEFAULT_CONFIG = {
    "servo_limits": {"pan": [30, 210], "tilt": [80, 165]},
    "pwr_init": True,
    "pan_init": 120,
    "tilt_init": 120,
    # 新增角度映射参数
    "servo_map": {
        "pan": {"center": 120, "direction": -1, "scale": 1},
        "tilt": {"center": 120, "direction": -1, "scale": 1}
    }
}

# Flask server port (configurable)
FLASK_PORT = 8080


def load_device_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r") as f:
                data = json.load(f)
                # 校验结构
                for k in DEFAULT_CONFIG:
                    if k not in data:
                        data[k] = DEFAULT_CONFIG[k]
                # 校验servo_limits
                for axis in ["pan", "tilt"]:
                    if ("servo_limits" not in data or axis not in data["servo_limits"] or
                        not isinstance(data["servo_limits"][axis], list) or len(data["servo_limits"][axis]) != 2):
                        data["servo_limits"][axis] = DEFAULT_CONFIG["servo_limits"][axis]
                return data
        except Exception:
            print(f"[WARN] Failed to load {CONFIG_FILE}, using default config")
            return DEFAULT_CONFIG.copy()
    else:
        print(f"[WARN] {CONFIG_FILE} not found, using default config")
        save_device_config(DEFAULT_CONFIG)
        return DEFAULT_CONFIG.copy()


def save_device_config(cfg):
    with open(CONFIG_FILE, "w") as f:
        json.dump(cfg, f)


DEVICE_CONFIG = load_device_config()
SERVO_LIMITS = DEVICE_CONFIG["servo_limits"]

# 应用限位到舵机
if SERVO_PAN:
    SERVO_PAN.set_angle_limits(*SERVO_LIMITS["pan"])
if SERVO_TILT:
    SERVO_TILT.set_angle_limits(*SERVO_LIMITS["tilt"])
# 应用初始角度
if SERVO_PAN:
    SERVO_PAN.move(DEVICE_CONFIG["pan_init"], time=500)
if SERVO_TILT:
    SERVO_TILT.move(DEVICE_CONFIG["tilt_init"], time=500)
# 应用电源
if DEVICE_CONFIG["pwr_init"] is not None:
    CAM_POWER.write(bool(DEVICE_CONFIG["pwr_init"]))

# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------


def _make_gst_pipeline(protocol: str, view: str, url: str) -> str:
    """Construct the full gst‑launch‑1.0 command string."""
    bypass = "true" if view == "pure" else "false"

    # Use absolute paths for model and label
    model_path = "/root/model/yolov5s-640-640.rknn"
    label_path = "/root/model/coco_80_labels_list.txt"

    base = (
        "v4l2src device=/dev/video0 io-mode=mmap do-timestamp=true "
        "! video/x-raw,format=NV16 "
        f"! rknn silent=true bypass={bypass} show-fps=true frame-skip=2 "
        f"model-path={model_path} "
        f"label-path={label_path} "
        "! mpph264enc rc-mode=cbr bps=10000000 gop=30 "
        "! h264parse config-interval=-1 "
    )

    if protocol == "udp":
        match = re.match(r"udp://([\d.]+):(\d+)", url)
        if not match:
            raise ValueError("UDP url must be udp://<host>:<port>")
        host, port = match.groups()
        tail = f"! rtph264pay pt=96 ! udpsink host={host} port={port}"

    elif protocol == "hls":
        # Always output to /tmp/hls/ regardless of url
        hls_dir = Path("/tmp/hls")
        hls_dir.mkdir(parents=True, exist_ok=True)
        # 递归清空hls目录下所有内容
        for f in hls_dir.iterdir():
            try:
                if f.is_file() or f.is_symlink():
                    f.unlink()
                elif f.is_dir():
                    shutil.rmtree(f)
            except Exception:
                pass
        playlist = hls_dir / "stream.m3u8"
        segment = hls_dir / "segment-%05d.ts"
        tail = (
            f"! hlssink2 location={segment} "
            f"playlist-location={playlist} "
            "target-duration=1 max-files=3 "
        )

    elif protocol == "rtsp":
        # Use test-launch for RTSP streaming
        pipeline = (
            "v4l2src device=/dev/video0 io-mode=mmap do-timestamp=true "
            "! video/x-raw,format=NV16 "
            f"! rknn silent=true bypass={bypass} show-fps=true frame-skip=2 "
            f"model-path={model_path} "
            f"label-path={label_path} "
            "! mpph264enc rc-mode=cbr bps=10000000 gop=30 "
            "! rtph264pay name=pay0 pt=96 "
        )
        tail = f'"({pipeline})"'
        return f"test-launch {tail}"

    else:
        raise ValueError("Unsupported protocol")

    return "gst-launch-1.0 -v " + base + tail


def _start_pipeline(protocol: str, view: str, url: str) -> None:
    if protocol in PIPELINES:
        print(f"[GStreamer] {protocol} pipeline already running")
        return
    # 只有切换 protocol 时才关闭所有 pipeline
    for proto in list(PIPELINES.keys()):
        _stop_pipeline(proto)
    cmd = _make_gst_pipeline(protocol, view, url)
    print("[GStreamer]", cmd)
    proc = subprocess.Popen(shlex.split(cmd), stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    PIPELINES[protocol] = proc


def _stop_pipeline(protocol: str) -> None:
    proc = PIPELINES.pop(protocol, None)
    if proc and proc.poll() is None:
        proc.send_signal(signal.SIGINT)
        try:
            proc.wait(5)
            print(f"[GStreamer] {protocol} pipeline stopped")
        except subprocess.TimeoutExpired:
            proc.kill()
            print(f"[GStreamer] {protocol} pipeline killed after timeout")


def _current_temperature() -> Dict[str, float]:
    """Return a mapping of sensor name → °C."""
    temps = {}
    # Kernel thermal zones
    for zone in Path("/sys/class/thermal").glob("thermal_zone*/temp"):
        try:
            value = int(zone.read_text()) / 1000.0
            temps[zone.parent.name] = value
        except Exception:  # noqa: BLE001
            pass
    # psutil provides more (e.g. on x86 or SBCs with hwmon)
    try:
        for name, entries in psutil.sensors_temperatures().items():
            if entries:
                temps[name] = max(e.current for e in entries if hasattr(e, 'current'))
    except Exception:
        pass
    return temps


def _update_oled() -> None:
    """Background task: refresh OLED every 1 s, compact layout for 128x64 OLED."""
    if OLED is None:
        return
    from PIL import Image, ImageDraw, ImageFont

    font = ImageFont.load_default()

    def get_text_size(draw, text, font):
        try:
            bbox = draw.textbbox((0, 0), text, font=font)
            w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        except AttributeError:
            w, h = font.getsize(text)
        return w, h

    toggle = False  # 用于高温反色闪烁
    while True:
        with OLED_LOCK:
            img = Image.new("1", OLED.size)
            draw = ImageDraw.Draw(img)

            width, height = OLED.size
            y = 0
            line_h = 10  # 更紧凑
            margin = 1

            # 主机名（小字体居中）
            hostname = os.uname().nodename
            w, h = get_text_size(draw, hostname, font)
            draw.text(((width - w) // 2, y), hostname, font=font, fill=255)
            y += line_h

            # IP地址
            ip = get_ip_address()
            if ip == "-":
                draw.text((margin, y), f"IP:-", font=font, fill=255)
            else:
                draw.text((margin, y), f"IP:{ip}  {FLASK_PORT}", font=font, fill=255)
            y += line_h

            # 流信息
            streams = ','.join(k.upper() for k in PIPELINES.keys()) or 'OFF'
            draw.text((margin, y), f"Stream:{streams}", font=font, fill=255)
            y += line_h

            # 摄像头电源
            cam_pwr = 'ON' if CAM_POWER.read() else 'OFF'
            draw.text((margin, y), f"Pwr:{cam_pwr}", font=font, fill=255)
            y += line_h

            # 舵机角度
            if SERVO_PAN and SERVO_TILT:
                try:
                    pan = SERVO_PAN.get_physical_angle()
                except Exception:
                    pan = 'ERR'
                try:
                    tilt = SERVO_TILT.get_physical_angle()
                except Exception:
                    tilt = 'ERR'
                draw.text((margin, y), f"Pan:{pan} Tilt:{tilt}", font=font, fill=255)
                y += line_h

            # 温度
            temps = _current_temperature()
            if temps:
                tmax = max(temps.values())
                temp_str = f"T:{tmax:.1f}C"
                # 高温反色警告闪烁
                if tmax >= 80:
                    tw, th = get_text_size(draw, temp_str, font)
                    if toggle:
                        draw.rectangle([width-tw-margin-1, y+1, width-margin, y+th+2], fill=255)
                        draw.text((width-tw-margin-1, y), temp_str, font=font, fill=0)
                    else:
                        draw.text((width-tw-margin-1, y), temp_str, font=font, fill=255)
                else:
                    draw.text((width-45, y), temp_str, font=font, fill=255)

            OLED.display(img)
        toggle = not toggle  # 每次循环取反，实现闪烁
        time.sleep(1)


def _init_oled_thread() -> None:
    t = threading.Thread(target=_update_oled, daemon=True)
    t.start()


def get_ip_address() -> str:
    """获取本机局域网IP地址（优先eth0/wlan0等）"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0)
        s.connect(("8.8.8.8", 80))
        ip_addr = s.getsockname()[0]
        s.close()
    except Exception:
        ip_addr = "-"
    return ip_addr


def get_host_for_request() -> str:
    """获取当前请求应该使用的主机名/IP"""
    # 优先使用请求头中的Host，保持与访问方式一致
    if request and hasattr(request, 'headers'):
        host_header = request.headers.get('Host')
        if host_header:
            # 去掉端口号，只保留主机名
            return host_header.split(':')[0]
    
    # 降级到IP地址
    return get_ip_address()


# ---------------------------------------------------------------------------
# Flask routes
# ---------------------------------------------------------------------------


@app.route("/stream/<protocol>", methods=["GET", "POST"])
def stream_control(protocol: str):
    protocol = protocol.lower()
    if request.method == "GET":
        running = protocol in PIPELINES and PIPELINES[protocol].poll() is None
        result = {"on": running}
        
        # 如果正在运行，返回对应的URL
        if running:
            host = get_host_for_request()
            if protocol == "hls":
                result["url"] = f"http://{host}:{FLASK_PORT}/hls/stream.m3u8"
            elif protocol == "rtsp":
                result["url"] = f"rtsp://{host}:8554/test"
        
        return jsonify(result)

    # POST – JSON body
    try:
        data = request.get_json(force=True)
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": f"Invalid JSON: {e}"}), 400

    on = bool(data.get("on"))
    view = data.get("view", "yolo")
    url = data.get("url", "")

    try:
        if on:
            _start_pipeline(protocol, view, url)
        else:
            _stop_pipeline(protocol)
    except (ValueError, RuntimeError) as e:
        return jsonify({"error": str(e)}), 400

    # If HLS and turning on, return the HLS URL
    if protocol == "hls" and on:
        host = get_host_for_request()
        hls_url = f"http://{host}:{FLASK_PORT}/hls/stream.m3u8"
        return jsonify({"status": "ok", "url": hls_url})

    # If RTSP and turning on, return the RTSP URL
    if protocol == "rtsp" and on:
        host = get_host_for_request()
        rtsp_url = f"rtsp://{host}:8554/test"
        return jsonify({"status": "ok", "url": rtsp_url})

    return jsonify({"status": "ok"})


@app.route("/power/camera", methods=["GET", "POST"])
def camera_power():
    if request.method == "GET":
        return jsonify({"on": bool(CAM_POWER.read())})

    data = request.get_json(force=True)
    on = bool(data.get("on"))
    prev_on = bool(CAM_POWER.read())
    if prev_on and not on:
        # 关闭前停止所有正在运行的stream
        for proto in list(PIPELINES.keys()):
            _stop_pipeline(proto)
    CAM_POWER.write(on)
    if prev_on and not on:
        # 相机断电后再拉低 HUB POWER，1 秒后再拉高
        HUB_POWER.write(False)
        time.sleep(1)
        HUB_POWER.write(True)
    return jsonify({"status": "ok", "on": on})


@app.route("/motion/<axis>", methods=["GET", "POST"])
def motion(axis: str):
    axis = axis.lower()
    servo = SERVO_PAN if axis == "pan" else SERVO_TILT if axis == "tilt" else None
    if servo is None:
        return jsonify({"error": "invalid axis"}), 404

    # 获取映射参数
    servo_map = DEVICE_CONFIG.get("servo_map", DEFAULT_CONFIG["servo_map"])
    map_cfg = servo_map.get(axis, {"center": 120, "direction": -1, "scale": 1})
    center = map_cfg.get("center", 120)
    direction = map_cfg.get("direction", -1)
    scale = map_cfg.get("scale", 1)

    # 使用线程锁保护舵机访问，防止并发访问导致数据串扰
    with SERVO_LOCK:
        if request.method == "GET":
            try:
                # 返回映射前的角度（反推）和实际物理角度
                physical_angle = servo.get_physical_angle()
                mapped_angle = (physical_angle - center) / (direction * scale)
                return jsonify({
                    "angle": mapped_angle, 
                    "physical_angle": physical_angle,
                    "axis": axis  # 添加轴标识，便于前端验证
                })
            except Exception as e:
                print(f"Warning: Failed to read servo {axis} position: {e}")
                # 返回默认值或上次已知值
                return jsonify({
                    "angle": 0, 
                    "physical_angle": center, 
                    "axis": axis,
                    "error": "communication_error"
                })

        data = request.get_json(force=True)
        angle = int(data.get("angle", 0))
        option = data.get("option", "")
        if option == "raw":
            # 直接用原始角度
            servo_angle = angle
        else:
            # 进行角度映射
            servo_angle = int(center + direction * angle * scale)
        # 使用持久化限位
        min_limit, max_limit = SERVO_LIMITS[axis]
        limited_angle = max(min_limit, min(max_limit, servo_angle))
        
        try:
            # limit speed to 15 deg /s
            current_angle = servo.get_physical_angle()
            move_time = int(abs(current_angle - limited_angle) * 1000 / 15.0)
        except Exception as e:
            print(f"Warning: Failed to read current servo {axis} position: {e}")
            # 使用默认移动时间
            move_time = 1000
        
        try:
            servo.move(limited_angle, time=move_time)
            status = "ok" if limited_angle == servo_angle else "limited"
            return jsonify({
                "status": status, 
                "angle": angle, 
                "physical_angle": limited_angle,
                "axis": axis  # 添加轴标识
            })
        except Exception as e:
            print(f"Error: Failed to move servo {axis}: {e}")
            return jsonify({
                "status": "error", 
                "error": "servo_communication_failed", 
                "message": str(e),
                "axis": axis
            }), 500


@app.route("/motion/<axis>/limit", methods=["GET", "POST"])
def motion_limit(axis: str):
    axis = axis.lower()
    if axis not in ("pan", "tilt"):
        return jsonify({"error": "invalid axis"}), 404
    # 获取映射参数
    servo_map = DEVICE_CONFIG.get("servo_map", DEFAULT_CONFIG["servo_map"])
    map_cfg = servo_map.get(axis, {"center": 120, "direction": -1, "scale": 1})
    center = map_cfg.get("center", 120)
    direction = map_cfg.get("direction", -1)
    scale = map_cfg.get("scale", 1)
    servo = SERVO_PAN if axis == "pan" else SERVO_TILT
    # 物理角度转映射角度
    def physical_to_mapped(physical):
        return (physical - center) / (direction * scale)
    # 映射角度转物理角度
    def mapped_to_physical(mapped):
        return int(center + direction * mapped * scale)
    if request.method == "GET":
        min_raw, max_raw = SERVO_LIMITS[axis]
        min_mapped = physical_to_mapped(min_raw)
        max_mapped = physical_to_mapped(max_raw)
        if min_mapped > max_mapped:
            min_mapped, max_mapped = max_mapped, min_mapped
        return jsonify({
            "min": min_mapped,
            "max": max_mapped,
            "min_raw": min_raw,
            "max_raw": max_raw
        })
    # POST
    data = request.get_json(force=True)
    # 优先用raw
    min_raw = data.get("min_raw")
    max_raw = data.get("max_raw")
    min_mapped = data.get("min")
    max_mapped = data.get("max")
    # 只要有任一就合法
    if min_raw is not None:
        min_raw = float(min_raw)
    elif min_mapped is not None:
        min_raw = mapped_to_physical(float(min_mapped))
    else:
        min_raw = SERVO_LIMITS[axis][0]
    if max_raw is not None:
        max_raw = float(max_raw)
    elif max_mapped is not None:
        max_raw = mapped_to_physical(float(max_mapped))
    else:
        max_raw = SERVO_LIMITS[axis][1]
    # 合法范围
    min_raw = max(0, min(240, min_raw))
    max_raw = max(0, min(240, max_raw))
    # 修正方向：direction<0时，min_raw>max_raw自动交换
    if direction < 0 and min_raw > max_raw:
        min_raw, max_raw = max_raw, min_raw
    elif direction > 0 and min_raw > max_raw:
        min_raw, max_raw = max_raw, min_raw
    min_raw = int(min_raw)
    max_raw = int(max_raw)
    SERVO_LIMITS[axis] = [min_raw, max_raw]
    DEVICE_CONFIG["servo_limits"] = SERVO_LIMITS
    save_device_config(DEVICE_CONFIG)
    if servo:
        servo.set_angle_limits(min_raw, max_raw)
    # 返回映射后和物理角度，保证min<max
    min_mapped = physical_to_mapped(min_raw)
    max_mapped = physical_to_mapped(max_raw)
    if min_mapped > max_mapped:
        min_mapped, max_mapped = max_mapped, min_mapped
    return jsonify({
        "status": "ok",
        "min": min_mapped,
        "max": max_mapped,
        "min_raw": min_raw,
        "max_raw": max_raw
    })


@app.route("/system/hostname", methods=["GET", "POST"])
def system_hostname():
    if request.method == "GET":
        hostname = subprocess.check_output(["hostname"], text=True).strip()
        return jsonify({"hostname": hostname})

    data = request.get_json(force=True)
    new_host = data.get("hostname")
    if not new_host:
        return jsonify({"error": "hostname required"}), 400

    # hostnamectl
    subprocess.check_call(["hostnamectl", "set-hostname", new_host])
    # Avahi: restart service so that mDNS reflects the change
    subprocess.call(["systemctl", "restart", "avahi-daemon"])
    return jsonify({"status": "ok", "hostname": new_host})


@app.route("/system/temperature", methods=["GET"])
def system_temperature():
    return jsonify(_current_temperature())


@app.route("/system/ip", methods=["GET"])
def system_ip():
    """返回本机IP地址"""
    return jsonify({"ip": get_ip_address()})


@app.route("/system/client_ip", methods=["GET"])
def system_client_ip():
    """返回访问者（客户端）的IP地址"""
    ip = request.headers.get('X-Forwarded-For', request.remote_addr)
    # X-Forwarded-For 可能是逗号分隔的多个IP，取第一个
    if ip and ',' in ip:
        ip = ip.split(',')[0].strip()
    return jsonify({"ip": ip})


# 新增通用配置接口
@app.route("/system/init", methods=["GET", "POST"])
def system_init():
    if request.method == "GET":
        return jsonify(DEVICE_CONFIG)
    data = request.get_json(force=True)
    # 只允许设置部分字段
    for k in ["pwr_init", "pan_init", "tilt_init", "servo_map"]:
        if k in data:
            DEVICE_CONFIG[k] = data[k]
    # 应用
    if "pwr_init" in data:
        CAM_POWER.write(bool(DEVICE_CONFIG["pwr_init"]))
    if "pan_init" in data and SERVO_PAN:
        SERVO_PAN.move(DEVICE_CONFIG["pan_init"], time=500)
    if "tilt_init" in data and SERVO_TILT:
        SERVO_TILT.move(DEVICE_CONFIG["tilt_init"], time=500)
    save_device_config(DEVICE_CONFIG)
    return jsonify({"status": "ok", **{k: DEVICE_CONFIG[k] for k in ["pwr_init", "pan_init", "tilt_init", "servo_map"]}})


@app.route("/hls/<path:filename>")
def hls_files(filename):
    """暴露 /tmp/hls/ 目录下的HLS文件"""
    return send_from_directory("/tmp/hls", filename)


@app.route("/")
def web_root():
    """根路径重定向到 web 界面"""
    return redirect("/web/")


@app.route("/web/")
@app.route("/web")
def web_index():
    """web 目录根路径自动跳转到 index.html"""
    return send_from_directory("web", "index.html")


@app.route("/web/<path:filename>")
def web_files(filename):
    """提供 /web/ 目录下的静态网页文件 (html/css/js)"""
    return send_from_directory("web", filename)


@app.route("/power/system", methods=["POST"])
def system_reboot():
    """系统重启接口，POST调用后立即重启系统"""
    try:
        # 立即返回响应后重启
        threading.Thread(target=lambda: (time.sleep(1), os.system('reboot')), daemon=True).start()
        return jsonify({"status": "ok", "msg": "rebooting"})
    except Exception as e:
        return jsonify({"status": "error", "msg": str(e)}), 500


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    _init_oled_thread()
    app.run(host="0.0.0.0", port=FLASK_PORT, threaded=True)


if __name__ == "__main__":
    main()
