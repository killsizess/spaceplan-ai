const K = new Uint32Array(64);
const H0 = new Uint32Array(8);
{
  // The first 32 bits of the fractional parts of the cube and square roots of the first primes.
  const primes: number[] = [];
  for (let n = 2; primes.length < 64; n++) if (primes.every((p) => n % p)) primes.push(n);
  const fraction = (value: number) => Math.floor((value - Math.floor(value)) * 2 ** 32);
  primes.forEach((prime, index) => { K[index] = fraction(Math.cbrt(prime)); });
  primes.slice(0, 8).forEach((prime, index) => { H0[index] = fraction(Math.sqrt(prime)); });
}

const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

/** SHA-256 of a text, in hex. Synchronous, so a pure function can use it. */
export function sha256(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const blocks = Math.ceil((bytes.length + 9) / 64);
  const data = new Uint8Array(blocks * 64);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(data.length - 8, Math.floor((bytes.length * 8) / 2 ** 32));
  view.setUint32(data.length - 4, (bytes.length * 8) >>> 0);

  const hash = Uint32Array.from(H0);
  const w = new Uint32Array(64);
  for (let block = 0; block < blocks; block++) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(block * 64 + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotate(w[t - 15], 7) ^ rotate(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotate(w[t - 2], 17) ^ rotate(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let t = 0; t < 64; t++) {
      const big1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const first = (h + big1 + choice + K[t] + w[t]) >>> 0;
      const big0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (big0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + first) >>> 0;
      d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((value, index) => { hash[index] = (hash[index] + value) >>> 0; });
  }
  return Array.from(hash, (value) => value.toString(16).padStart(8, "0")).join("");
}
