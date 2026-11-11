// Virtual gamepad. The browser sends each controller's full state; Rose turns it into a real
// Android controller through scrcpy's UHID support (emulators such as Eden only accept input
// from devices that are gamepads; injected key events are ignored). Without /dev/uhid access it
// falls back to Android gamepad key events, which most Android games accept.
//
// State from the browser: { b, lx, ly, rx, ry, lt, rt }
//   b      - button bits (BTN below) plus D-pad bits 16-19
//   lx..ry - sticks, -1..1 (y down is positive)
//   lt, rt - triggers, 0..1

export const BTN = {
  SOUTH: 1 << 0,   // Xbox A
  EAST: 1 << 1,    // Xbox B
  WEST: 1 << 3,    // Xbox X
  NORTH: 1 << 4,   // Xbox Y
  L1: 1 << 6,
  R1: 1 << 7,
  SELECT: 1 << 10,
  START: 1 << 11,
  MODE: 1 << 12,
  L3: 1 << 13,
  R3: 1 << 14,
  UP: 1 << 16,
  DOWN: 1 << 17,
  LEFT: 1 << 18,
  RIGHT: 1 << 19,
};
export const NEUTRAL = Object.freeze({ b: 0, lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0 });

// Xbox 360 vendor/product IDs make Android apply its stock gamepad key layout to the device.
export const PAD_VENDOR = 0x045e;
export const PAD_PRODUCT = 0x028e;

// HID report descriptor (see the USB HID 1.11 spec and HID Usage Tables). One 15-byte input report:
// 4 x u16 sticks (0-65535), 2 x u16 triggers (0-32767), 16 button bits, 4-bit hat + 4-bit pad.
// The Linux HID driver turns gamepad buttons 1..16 into BTN_SOUTH, BTN_EAST, BTN_C, BTN_NORTH, …
// which is why bit 2 (BTN_C) and bits 5, 8, 9 are unused above.
export const PAD_DESCRIPTOR = Buffer.from([
  0x05, 0x01,                   // Usage Page (Generic Desktop)
  0x09, 0x05,                   // Usage (Game Pad)
  0xa1, 0x01,                   // Collection (Application)
  0xa1, 0x00,                   //   Collection (Physical)
  0x09, 0x30, 0x09, 0x31,       //     Usage (X), Usage (Y): left stick
  0x09, 0x33, 0x09, 0x34,       //     Usage (Rx), Usage (Ry): right stick
  0x15, 0x00,                   //     Logical Minimum (0)
  0x27, 0xff, 0xff, 0x00, 0x00, //     Logical Maximum (65535)
  0x75, 0x10, 0x95, 0x04,       //     Report Size (16), Report Count (4)
  0x81, 0x02,                   //     Input (Data, Variable, Absolute)
  0x09, 0x32, 0x09, 0x35,       //     Usage (Z), Usage (Rz): left and right trigger
  0x15, 0x00,                   //     Logical Minimum (0)
  0x26, 0xff, 0x7f,             //     Logical Maximum (32767)
  0x75, 0x10, 0x95, 0x02,       //     Report Size (16), Report Count (2)
  0x81, 0x02,                   //     Input (Data, Variable, Absolute)
  0x05, 0x09,                   //     Usage Page (Button)
  0x19, 0x01, 0x29, 0x10,       //     Usage Minimum (1), Usage Maximum (16)
  0x15, 0x00, 0x25, 0x01,       //     Logical Minimum (0), Logical Maximum (1)
  0x75, 0x01, 0x95, 0x10,       //     Report Size (1), Report Count (16)
  0x81, 0x02,                   //     Input (Data, Variable, Absolute)
  0x05, 0x01,                   //     Usage Page (Generic Desktop)
  0x09, 0x39,                   //     Usage (Hat switch)
  0x15, 0x01, 0x25, 0x08,       //     Logical Minimum (1), Logical Maximum (8)
  0x75, 0x04, 0x95, 0x01,       //     Report Size (4), Report Count (1)
  0x81, 0x42,                   //     Input (Data, Variable, Absolute, Null State)
  0x75, 0x04, 0x95, 0x01,       //     Report Size (4), Report Count (1)
  0x81, 0x03,                   //     Input (Constant): padding
  0xc0,                         //   End Collection
  0xc0,                         // End Collection
]);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));

/** Hat switch value: 1 = up, then clockwise to 8 = up-left; 0 = centered. */
function hat(b) {
  const up = b & BTN.UP && !(b & BTN.DOWN), down = b & BTN.DOWN && !(b & BTN.UP);
  const left = b & BTN.LEFT && !(b & BTN.RIGHT), right = b & BTN.RIGHT && !(b & BTN.LEFT);
  if (up) return right ? 2 : left ? 8 : 1;
  if (down) return right ? 4 : left ? 6 : 5;
  return right ? 3 : left ? 7 : 0;
}

/** 15-byte HID input report for a pad state. */
export function padReport(st) {
  const r = Buffer.alloc(15);
  const axis = v => Math.round((clamp(v, -1, 1) + 1) * 32767.5);    // -1..1 -> 0..65535, 0 -> 32768
  const trigger = v => Math.round(clamp(v, 0, 1) * 32767);
  r.writeUInt16LE(axis(st.lx), 0);
  r.writeUInt16LE(axis(st.ly), 2);
  r.writeUInt16LE(axis(st.rx), 4);
  r.writeUInt16LE(axis(st.ry), 6);
  r.writeUInt16LE(trigger(st.lt), 8);
  r.writeUInt16LE(trigger(st.rt), 10);
  r.writeUInt16LE(st.b & 0xffff, 12);
  r[14] = hat(st.b);
  return r;
}

// Fallback: Android gamepad keycodes (KEYCODE_BUTTON_*, KEYCODE_DPAD_*).
const KEYS = [
  [BTN.SOUTH, 96], [BTN.EAST, 97], [BTN.WEST, 99], [BTN.NORTH, 100], [BTN.L1, 102], [BTN.R1, 103],
  [BTN.SELECT, 109], [BTN.START, 108], [BTN.MODE, 110], [BTN.L3, 106], [BTN.R3, 107],
  [BTN.UP, 19], [BTN.DOWN, 20], [BTN.LEFT, 21], [BTN.RIGHT, 22],
];

/** The set of Android keycodes held down for a pad state (left stick doubles as the D-pad). */
export function padKeys(st) {
  let b = st.b;
  if (st.lx < -0.5) b |= BTN.LEFT;
  if (st.lx > 0.5) b |= BTN.RIGHT;
  if (st.ly < -0.5) b |= BTN.UP;
  if (st.ly > 0.5) b |= BTN.DOWN;
  const keys = new Set(KEYS.filter(([bit]) => b & bit).map(([, k]) => k));
  if (st.lt > 0.5) keys.add(104);
  if (st.rt > 0.5) keys.add(105);
  return keys;
}

/** Validate a state received from a browser. */
export function sanitize(m) {
  return {
    b: Math.trunc(clamp(m.b, 0, 0xfffff)) & 0xfffff,
    lx: clamp(m.lx, -1, 1), ly: clamp(m.ly, -1, 1), rx: clamp(m.rx, -1, 1), ry: clamp(m.ry, -1, 1),
    lt: clamp(m.lt, 0, 1), rt: clamp(m.rt, 0, 1),
  };
}
