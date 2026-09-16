// argon2id parameters. OWASP's 2024 baseline: 19 MiB, 2 passes, 1 lane.
// Raising memoryCost is the cheapest way to harden this later; existing
// hashes keep verifying because the parameters ride along in the encoded hash.
import { hash, verify, Algorithm } from '@node-rs/argon2';

const OPTS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plain) {
  return hash(plain, OPTS);
}

export async function verifyPassword(encoded, plain) {
  try {
    return await verify(encoded, plain, OPTS);
  } catch {
    // A malformed stored hash must read as "wrong password", never as a crash.
    return false;
  }
}
