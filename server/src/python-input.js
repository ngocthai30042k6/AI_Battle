// Encode server-owned data using the data-only subset of CPython 3.11 marshal.
// Only immutable strings use v3 references; lists/dicts remain independent.
// No code objects, pickle or executable objects are ever encoded.
// Format: https://github.com/python/cpython/blob/v3.11.3/Python/marshal.c
export function encodePythonInput(value, capacity = 128 * 1024 - 4) {
  const out = Buffer.allocUnsafe(capacity), strings = new Map();
  let offset = 4;
  const reserve = n => { if (offset + n > out.length) throw new Error('Bot input exceeded its limit'); };
  const byte = n => { reserve(1); out[offset++] = n; };
  const int = n => { reserve(4); out.writeInt32LE(n, offset); offset += 4; };
  function write(v, depth = 0) {
    if (depth > 64) throw new Error('Bot input is too deeply nested');
    if (v === null) return byte(78);
    if (typeof v === 'boolean') return byte(v ? 84 : 70);
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error('Invalid bot input number');
      if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) { byte(105); int(v); return; }
      if (Number.isSafeInteger(v)) {
        byte(108);
        let n = Math.abs(v), digits = [];
        while (n) { digits.push(n % 32768); n = Math.floor(n / 32768); }
        int(v < 0 ? -digits.length : digits.length);
        for (const digit of digits) { reserve(2); out.writeUInt16LE(digit, offset); offset += 2; }
        return;
      }
      byte(103); reserve(8); out.writeDoubleLE(v, offset); offset += 8; return;
    }
    if (typeof v === 'string') {
      if (strings.has(v)) { byte(114); int(strings.get(v)); return; }
      strings.set(v, strings.size);
      byte(117 | 128); const size = Buffer.byteLength(v); int(size); reserve(size);
      offset += out.write(v, offset, size, 'utf8'); return;
    }
    if (Array.isArray(v)) {
      byte(91); int(v.length); for (const item of v) write(item, depth + 1); return;
    }
    if (v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
      byte(123);
      for (const [key, item] of Object.entries(v)) { write(key, depth + 1); write(item, depth + 1); }
      byte(48); return;
    }
    throw new Error('Unsupported bot input');
  }
  write(value);
  out.writeUInt32LE(offset - 4, 0);
  return out.subarray(0, offset);
}
