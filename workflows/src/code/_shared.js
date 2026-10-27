// Shared helpers inlined into Code nodes at build time (see scripts/build-workflow.mjs).

function sanitizeText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    // Hidden HTML comments are a common prompt-injection carrier.
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(script|style|iframe|object|embed)\b[^>]*>/gi, '')
    // Control characters plus zero-width / bidi-override characters.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .trim();
}

function sanitizeLabel(value, maxLength = 200) {
  return sanitizeText(value).replace(/[<>`]/g, '').replace(/\s+/g, ' ').slice(0, maxLength);
}

function byteLength(value) {
  return new TextEncoder().encode(String(value)).length;
}

// Non-cryptographic 128-bit hash (four seeded cyrb53-style lanes). Used for change
// detection and deterministic point IDs, never for security decisions.
function hash128(input) {
  const str = String(input);
  const lane = (seed) => {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h1 >>> 0).toString(16).padStart(8, '0');
  };
  return lane(1) + lane(2) + lane(3) + lane(4);
}

function toUuid(input) {
  const h = hash128(input);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
