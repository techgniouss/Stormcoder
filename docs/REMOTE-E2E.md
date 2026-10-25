# Remote control: end-to-end encryption

A paired phone and the desktop app share keys that the relay (the local relay, a Cloudflare
Quick Tunnel, or your own Cloudflare Worker) never sees. Every chat message between them is
sealed with those keys. The relay still routes frames, so it can see who is connected, when, and
how big the messages are, but it cannot read a message, change one, or forge an approval.

This document is the wire specification. `src/remote/e2e.ts` (desktop) and
`openvs-relay/pwa/e2e.js` (phone) implement it, and `scripts/test-remote-e2e-crypto.mjs` checks
that the two agree byte for byte.

## What it protects, and what it does not

Protected:

- Passive snooping or logging at the relay, the tunnel or Cloudflare: message text, tool output,
  file contents and command lines are ciphertext.
- A relay that forges, edits, drops, reorders or replays messages: every frame is authenticated
  and numbered, and the desktop only accepts frames from a device whose key it holds.
- A relay that tries to put its own key in during pairing: the pairing secret travels only in the
  QR code / link fragment, which is never sent to any server, and both public keys are bound to it.
- A device token alone is no longer enough to command the agent: without the device key, frames
  are rejected.

Not protected:

- **The phone app is delivered by the relay or tunnel.** A malicious relay could serve a modified
  copy of the app that steals the key when the page loads. End-to-end encryption does not fix
  that; serving the app from a place you control and can verify would. The Android app (`android/`)
  does this: its copy of the phone app is fixed inside the APK you build. For a phone browser or
  an installed PWA, treat the relay as trusted to deliver the app, but not to read or change your traffic.
- A compromised phone or desktop.
- Metadata: the room id, device ids and names, connection times, message sizes and timing.
- Push notifications carry only generic text ("Stormcoder needs your attention").

## Encodings

- `b64u`: base64url without padding.
- `B32`: Crockford base32, alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, no padding. Decoding accepts
  lowercase and maps `I`/`L` to `1` and `O` to `0`.
- `||` is byte concatenation. `0x00` is a single zero byte. Strings are UTF-8.
- All keys are NIST P-256 (ECDH). A public key is the 65-byte uncompressed point (`0x04 || X || Y`).
- Hash/MAC: HMAC-SHA-256. KDF: HKDF-SHA-256. Cipher: AES-256-GCM, 12-byte IV, 16-byte tag.

## Pairing

1. The desktop makes a random 16-byte **pairing secret** `ps` (new for each pairing, valid for the
   code's lifetime, about two minutes) and shows it as the link
   `<relay>/p/<roomId>#<B32(ps)>` (26 characters after the `#`) and as a QR code of that link.
   For typing, the desktop also shows `B32(ps)` in groups of four.
2. The relay's pairing **code** is derived from the secret, so the phone never types it:
   `code = B32(HMAC(ps, "stormcoder-e2e-v1 code")).slice(0, 8)`. The desktop sends it to the relay
   as `{ c: 'pair', code }`; the relay stores a hash of it as before. The relay learns the code, and
   cannot work back to `ps` from it.
3. The phone reads `ps` from the fragment, derives `code`, and generates a P-256 key pair
   (`phonePriv` stays on the phone). It claims the pairing:
   `POST /pair/claim?room=<roomId>` with
   `{ code, name, pub: b64u(phonePub), mac: b64u(claimMac) }` where
   `claimMac = HMAC(ps, "stormcoder-e2e-v1 claim" || 0x00 || phonePub || 0x00 || name)`.
   The relay returns the device id and device token as before, and stores `pub` and `mac` on the
   device record.
4. The relay forwards `{ c: 'deviceClaimed', deviceId, name, pub, mac }` to the desktop (and the
   desktop also reads them from the device list if it was offline). The desktop checks `claimMac`
   against its pending `ps` values. If none matches, the device is revoked.
5. The desktop makes a fresh P-256 key pair `hostPriv`/`hostPub`, computes
   `shared = ECDH(hostPriv, phonePub)` (32 bytes) and
   `okm = HKDF(ikm = shared, salt = ps, info = "stormcoder-e2e-v1 keys" || 0x00 || deviceId, length = 64)`,
   `kC2H = okm[0..32)` (phone to desktop), `kH2C = okm[32..64)` (desktop to phone). It then forgets
   `hostPriv` and `ps` and stores the two keys (in the OS secret store) with the device id.
6. The desktop sends the phone a **handshake** frame (plaintext envelope payload):
   `{ e: 0, d: deviceId, hk: b64u(hostPub), hm: b64u(hostMac) }` with
   `hostMac = HMAC(ps, "stormcoder-e2e-v1 host" || 0x00 || deviceId || 0x00 || hostPub || 0x00 || phonePub)`.
   It repeats this each time the device connects until the device has sent one valid encrypted
   frame.
7. The phone checks `hostMac` with `ps`. If it matches it computes the same `shared` from
   `phonePriv` and `hostPub`, derives the same keys, forgets `ps` and `phonePriv`, stores the keys
   as non-extractable `CryptoKey`s, and from then on only encrypted frames are used. If it does
   not match, the pairing is abandoned and the phone says so.

A relay that does not know `ps` cannot make a valid `claimMac` or `hostMac`, so it cannot insert
its own key on either side.

There is no unencrypted mode: a phone with no keys, or a frame that is not `e: 1`, is ignored.
Devices paired before this change have no keys; the desktop revokes them when they connect and
they must pair again.

## Sealed frames

Every envelope with `t: 'm'` carries, as its payload `p`:

```
{ e: 1, d: <deviceId>, s: <stream id>, n: <counter>, c: b64u(iv || ciphertext || tag) }
```

- `d` is the device id of the phone in the conversation. The desktop sends one sealed frame per
  paired device (each with that device's `kH2C`); the relay broadcasts to every phone and each
  phone ignores frames whose `d` is not its own.
- `ciphertext` seals the UTF-8 JSON text of the message object (what used to be `p` itself).
- Key: `kC2H` for phone to desktop, `kH2C` for desktop to phone. IV: 12 random bytes.
- Associated data: `"stormcoder-e2e-v1 " + dir + " " + d + " " + s + " " + n` where `dir` is `c2h`
  or `h2c`. Authentication therefore covers the device, direction, stream and counter.
- `s` identifies one stream of frames from one sender: a millisecond timestamp, chosen as
  `max(Date.now(), lastStreamIdUsed + 1)` and persisted, so it only ever grows. `n` starts at 0 for
  each stream and rises by one per frame.
- The receiver keeps the last `(s, n)` it accepted per device and accepts a frame only if
  `s` is larger, or `s` is equal and `n` is larger. Everything else (replays, reordering,
  old streams, a frame for another device) is dropped silently.
- A sender starts a new stream whenever its link comes up: the desktop for a device when that
  device connects or the desktop starts; the phone when its socket connects and whenever the
  relay reports the desktop (re)joined (`hostStatus` with `online: true`). After a desktop restart
  the desktop accepts only a stream newer than the last it saw from that device, so frames
  recorded before the restart cannot be replayed into it.
- A frame that fails authentication, is malformed or is for an unknown device is dropped.

The relay's own `seq`/`ack` replay buffer is unchanged and sees only ciphertext.

## What stays visible to the relay

Room id, device ids, device names, which side is connected, frame sizes and timing, and the
control frames (`hello`, `welcome`, `resume`, `pair`, `paired`, `revoke`, `deviceClaimed`,
`deviceConnected`, `hostStatus`, `ping`, `pong`, `push`, `bye`). Push frames hold only generic text.

## Limits to know about

- Anyone who can read the QR code or link while it is valid can pair. It expires in about two
  minutes and works once.
- Clearing the phone's site data deletes its keys: pair again.
- Keys are not rotated. Revoke a device from Settings > Remote control to cut it off; the desktop
  deletes that device's keys and the relay refuses its token.
