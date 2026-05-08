#!/usr/bin/env python3
"""
CANable 2.0 Pro — serial communication test
Tests command/response and decodes any incoming COBS CAN frames.

Usage:
    python3 test_serial.py [port]

    port defaults to the first /dev/tty.usbmodem* device found.
"""

import serial
import serial.tools.list_ports
import sys
import struct
import time


# ── COBS decode ───────────────────────────────────────────────────────────────

def cobs_decode(data: bytes) -> bytes:
    out = bytearray()
    i = 0
    while i < len(data):
        code = data[i]
        i += 1
        for _ in range(code - 1):
            if i >= len(data):
                raise ValueError("truncated COBS block")
            out.append(data[i])
            i += 1
        if code < 0xFF and i < len(data):
            out.append(0x00)
    # strip trailing zero appended by encoder
    if out and out[-1] == 0x00:
        out.pop()
    return bytes(out)


# ── CAN frame unpack ──────────────────────────────────────────────────────────

def unpack_frame(raw: bytes) -> dict:
    if len(raw) < 6:
        raise ValueError(f"frame too short ({len(raw)} bytes)")
    can_id, flags, dlc = struct.unpack_from("<IBB", raw, 0)
    data = raw[6:6 + dlc]
    return {
        "id":       can_id,
        "ext":      bool(flags & 0x01),
        "rtr":      bool(flags & 0x02),
        "dlc":      dlc,
        "data":     data,
    }


def fmt_frame(f: dict) -> str:
    id_str = f"{f['id']:08X}" if f["ext"] else f"{f['id']:03X}"
    flags  = ("EXT " if f["ext"] else "") + ("RTR" if f["rtr"] else "")
    data   = " ".join(f"{b:02X}" for b in f["data"])
    return f"  [{id_str}] {flags:<7} DLC={f['dlc']}  {data}"


# ── Port discovery ────────────────────────────────────────────────────────────

def find_port() -> str:
    ports = [p.device for p in serial.tools.list_ports.comports()
             if "usbmodem" in p.device or "usbserial" in p.device
             or "ACM" in p.device or "USB" in p.device]
    if not ports:
        sys.exit("No USB serial port found. Pass port as argument.")
    return ports[0]


# ── Command helper ────────────────────────────────────────────────────────────

def send_cmd(ser: serial.Serial, cmd: str) -> str:
    ser.write((cmd + "\n").encode())
    resp = ser.readline().decode(errors="replace").strip()
    status = "✓" if resp == "OK" else "✓ (KO expected)" if resp == "KO" else "✗ unexpected"
    print(f"  {cmd!r:6} → {resp}  {status}")
    return resp


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    port = sys.argv[1] if len(sys.argv) > 1 else find_port()
    print(f"Opening {port} …")

    with serial.Serial(port, timeout=1) as ser:
        time.sleep(0.5)          # let CDC settle
        ser.reset_input_buffer()

        # ── Command tests ─────────────────────────────────────────────────────
        print("\n── Command tests ────────────────────────────────────────────")

        print("Bad commands (expect KO):")
        send_cmd(ser, "X")
        send_cmd(ser, "S0")
        send_cmd(ser, "S9")

        print("Speed commands (expect OK):")
        for s in range(1, 9):
            send_cmd(ser, f"S{s}")

        print("Channel open/close:")
        send_cmd(ser, "S1")      # back to 1 Mbps
        send_cmd(ser, "O")
        send_cmd(ser, "C")
        send_cmd(ser, "C")       # close when already closed (expect OK)
        send_cmd(ser, "O")

        # ── CAN frame capture ─────────────────────────────────────────────────
        print("\n── CAN frame capture (5 s, Ctrl-C to stop) ─────────────────")
        print("Channel is open at S1 (1 Mbps). Waiting for frames …\n")

        ser.timeout = 0.05
        buf = bytearray()
        deadline = time.time() + 5.0
        frame_count = 0

        while time.time() < deadline:
            chunk = ser.read(64)
            if not chunk:
                continue
            buf.extend(chunk)
            while b"\x00" in buf:
                end = buf.index(b"\x00")
                packet = bytes(buf[:end])
                buf    = buf[end + 1:]
                if not packet:
                    continue
                try:
                    raw   = cobs_decode(packet)
                    frame = unpack_frame(raw)
                    print(fmt_frame(frame))
                    frame_count += 1
                except Exception as e:
                    print(f"  decode error: {e}  raw={packet.hex()}")

        send_cmd(ser, "C")
        print(f"\n{frame_count} frame(s) received in 5 s.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nAborted.")
