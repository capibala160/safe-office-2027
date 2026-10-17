'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { encodeChallenge, encodeDecision, decodeFrame } = require('../src/ws63-protocol.cjs');
const key = Buffer.alloc(32, 0x42);
const challenge = { taskId: Buffer.alloc(8, 1), nonce: Buffer.alloc(16, 2), action: 1,
  operationHash: crypto.createHash('sha256').update('final document').digest(), issuedAt: 1000, expiresAt: 1030, summary: '发送纪要给 partner@example.com' };
const decision = { ...challenge, decision: 1, deviceId: Buffer.alloc(8, 3), decidedAt: 1005 };
test('WS63 codec: round trips, UTF-8 byte limit, malformed and tampered frames', () => {
  for (const [value, encode] of [[challenge, encodeChallenge], [decision, encodeDecision]]) {
    const frame = encode(value, key);
    const decoded = decodeFrame(frame, key);
    for (const k of Object.keys(decoded).filter(k => k !== 'type')) assert.deepEqual(decoded[k], value[k]);
    for (const index of [0, 4, 5, 6, 7, 8, 10, frame.length - 1]) {
      const bad = Buffer.from(frame); bad[index] ^= 1;
      assert.throws(() => decodeFrame(bad, key));
    }
    assert.throws(() => decodeFrame(frame.subarray(0, -1), key));
    assert.throws(() => decodeFrame(frame, Buffer.alloc(32)));
  }
  assert.doesNotThrow(() => encodeChallenge({ ...challenge, summary: '中'.repeat(32) }, key));
  assert.throws(() => encodeChallenge({ ...challenge, summary: '中'.repeat(33) }, key));
  assert.throws(() => encodeChallenge({ ...challenge, summary: 'a\0b' }, key));
  assert.throws(() => encodeChallenge({ ...challenge, expiresAt: 1000 }, key));
  assert.throws(() => encodeChallenge({ ...challenge, action: 0 }, key));
  assert.throws(() => encodeChallenge({ ...challenge, action: 5 }, key));
  assert.throws(() => encodeDecision({ ...decision, decision: 2 }, key));

  const wire = Buffer.from(encodeChallenge(challenge, key));
  wire[34] = 0; // header 10 + taskId 8 + nonce 16
  crypto.createHmac('sha256', key).update(wire.subarray(0, -32)).digest().copy(wire, wire.length - 32);
  assert.throws(() => decodeFrame(wire, key), /invalid action/);
});

test('WS63 Node/C: identical authenticated frames in both directions', t => {
  const compiler = spawnSync('gcc', ['--version'], { encoding: 'utf8' });
  if (compiler.error?.code === 'ENOENT') return t.skip('gcc unavailable; run this check on a C-enabled host');
  assert.equal(compiler.status, 0, compiler.stderr);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-office-wire-'));
  try {
    // Fixture callback verifies the exact Node HMAC preimage and supplies its known MAC.
    // This tests C serialization, not a C cryptographic implementation (mbedTLS is board-side).
    const frames = [encodeChallenge(challenge, key), encodeDecision(decision, key)];
    const array = b => [...b].join(',');
    const source = `#include "protocol.h"
#include <string.h>
static const unsigned char f0[] = {${array(frames[0])}};
static const unsigned char f1[] = {${array(frames[1])}};
static int fixture_mac(const uint8_t *data, size_t n, uint8_t out[32], void *ctx) {
  const uint8_t *f = (const uint8_t *)ctx;
  size_t len = (size_t)f[8] + ((size_t)f[9] << 8) + 10;
  if (n != len - 32 || memcmp(data, f, n)) return -1;
  memcpy(out, f + n, 32); return 0;
}
int main(void) {
  proto_challenge_t c; proto_decision_t d; uint8_t out[PROTO_CHALLENGE_MAX]; size_t n;
  if (proto_decode_challenge(f0, sizeof(f0), &c, fixture_mac, (void *)f0)) return 1;
  n = proto_encode_challenge(&c, out, sizeof(out), fixture_mac, (void *)f0);
  if (n != sizeof(f0) || memcmp(out, f0, n)) return 2;
  if (proto_decode_decision(f1, sizeof(f1), &d, fixture_mac, (void *)f1)) return 3;
  n = proto_encode_decision(&d, out, sizeof(out), fixture_mac, (void *)f1);
  if (n != sizeof(f1) || memcmp(out, f1, n)) return 4;
  return 0;
}`;
    const file = path.join(dir, 'interop.c'), exe = path.join(dir, 'interop.exe');
    fs.writeFileSync(file, source);
    const root = path.resolve(__dirname, '../../ws63');
    const build = spawnSync('gcc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', root,
      path.join(root, 'protocol.c'), file, '-o', exe], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr || String(build.error));
    const run = spawnSync(exe, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || String(run.error));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
