// Pure-JavaScript SHA-256 (FIPS 180-4). No dependencies, works outside secure contexts.
const K = Uint32Array.of(
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2);

const rotr = (x, n) => (x >>> n) | (x << (32 - n));
const encoder = new TextEncoder();

export function sha256Hex(input) {
  const bytes = typeof input === 'string' ? encoder.encode(input)
    : input instanceof Uint8Array ? input : new Uint8Array(input);
  const blocks = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(blocks);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(blocks - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(blocks - 4, (bytes.length * 8) >>> 0);
  const h = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
  const w = new Uint32Array(64);
  for (let off = 0; off < blocks; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(off + t * 4);
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15];
      const b = w[t - 2];
      w[t] = (w[t - 16] + ((rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) >>> 0)
        + w[t - 7] + ((rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)) >>> 0)) >>> 0;
    }
    let [A, B, C, D, E, F, G, H] = h;
    for (let t = 0; t < 64; t++) {
      const s1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const ch = (E & F) ^ (~E & G);
      const t1 = (H + s1 + ch + K[t] + w[t]) >>> 0;
      const s0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const maj = (A & B) ^ (A & C) ^ (B & C);
      const t2 = (s0 + maj) >>> 0;
      H = G; G = F; F = E; E = (D + t1) >>> 0;
      D = C; C = B; B = A; A = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + A) >>> 0; h[1] = (h[1] + B) >>> 0;
    h[2] = (h[2] + C) >>> 0; h[3] = (h[3] + D) >>> 0;
    h[4] = (h[4] + E) >>> 0; h[5] = (h[5] + F) >>> 0;
    h[6] = (h[6] + G) >>> 0; h[7] = (h[7] + H) >>> 0;
  }
  return Array.from(h, x => x.toString(16).padStart(8, '0')).join('');
}
