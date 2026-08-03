# Pocket Vault Cryptography

This document explains the Pocket Vault V1 cryptographic design at a high
level. [`FORMAT.md`](FORMAT.md) remains the normative source for serialized
fields, validation bounds, and exact additional authenticated data (AAD).

Pocket Vault has not yet received an independent cryptographic audit.

## Key hierarchy

```text
master passphrase
       |
       | Argon2id(passphrase, random salt, serialized cost)
       v
32-byte password key
       |
       | HKDF-SHA-256(salt = vault_id,
       |             info = "pocket-vault/local-kek/v1")
       v
32-byte key-encryption key (KEK)
       |
       | XChaCha20-Poly1305 authenticated unwrap
       v
random 32-byte data-encryption key (DEK)
       |
       | XChaCha20-Poly1305 authenticated decryption
       v
encrypted vault slot A or B
```

The master passphrase and derived password key are not stored. Metadata stores
the KDF salt and cost plus an authenticated encryption of the random DEK. The
DEK encrypts complete vault containers.

## Password derivation: Argon2id

Argon2id is memory-hard and combines resistance to common GPU attacks with a
hybrid data-access pattern. New V1 vaults use the mobile-oriented profile
serialized in their metadata:

- 19,456 KiB of memory;
- 2 iterations;
- parallelism 1;
- a random 16-byte salt;
- a 32-byte result;
- Argon2 version `0x13`.

The cost is stored with the vault so it can be validated and reproduced during
unlock. Accepted values are bounded before the expensive operation to limit
malicious resource use. These parameters slow offline guessing; they do not
make a weak passphrase safe.

## Domain separation: HKDF-SHA-256

HKDF turns the Argon2id result into a dedicated KEK. The vault identifier is
used as the HKDF salt, and a versioned application string is used as `info`.
This separates the final wrapping key from the raw password-derived output and
from keys used by any future context.

## Random DEK and password rotation

A new vault receives a random 32-byte DEK from the Web Crypto-backed system
CSPRNG. Keeping data encryption independent from the passphrase has two useful
properties:

- entry encryption uses high-entropy key material even when the passphrase is
  human-memorable;
- changing the master passphrase derives a new KEK and rewraps the same DEK
  with a fresh salt and nonce, without decrypting and rewriting every entry
  slot.

The current passphrase must successfully unwrap the DEK before a password
change is prepared. New metadata is committed only after storage readback
verification.

## Authenticated encryption: XChaCha20-Poly1305

XChaCha20-Poly1305 provides confidentiality and integrity for both wrapped DEKs
and vault slots. Its 24-byte nonce supports random nonce generation with a very
large nonce space, which is suitable for this client-side design.

Every encryption operation obtains a fresh random nonce. A nonce must never be
reused with the same key. Random-generation failure aborts the operation rather
than falling back to a predictable value.

## Additional authenticated data

AAD binds ciphertext to its purpose and format without storing those fields in
the plaintext. The wrapped DEK is bound to the application name, object type,
format version, and vault ID. A vault slot is additionally bound to its slot ID
and generation.

This prevents valid ciphertext from being silently moved between incompatible
objects, vaults, slots, or generations. Exact byte construction is specified in
[`FORMAT.md`](FORMAT.md#aad).

## Two-slot persistence

Vault containers alternate between slots A and B:

1. WASM encrypts the next generation into the inactive slot.
2. JavaScript writes that slot and reads it back.
3. WASM verifies the persisted ciphertext.
4. JavaScript updates and verifies the active-slot pointer.
5. Only then does WASM commit the in-memory generation.

If a write is interrupted, unlock evaluates the available authenticated slots
and can repair a missing or stale pointer. This protects against common partial
writes; it is not an anti-rollback mechanism against an attacker who can
replace the complete storage snapshot.

## Error normalization

Authentication failure during unwrap or slot decryption is exposed to the UI as
one `cannot_open_vault` result. The interface reports that either the master
passphrase is wrong or the vault is damaged, avoiding a detailed decryption
oracle. Storage and format failures retain separate coarse error codes needed
for recovery and diagnostics.

## Memory handling and zeroization limits

Rust key buffers, decrypted containers, entry fields, and incoming passphrase
values use best-effort zeroization where ownership permits. Locking drops and
zeroizes the protected Rust session state.

WebAssembly runs inside a JavaScript host. JavaScript strings are immutable and
may be copied by the engine; browser memory, allocator copies, swap, crash dumps,
input controls, and the clipboard cannot be reliably erased by Pocket Vault.
Zeroization narrows exposure but is not a guarantee against a compromised
device or process-memory inspection.

## What the construction does not guarantee

The cryptographic design does not:

- prevent offline guessing of a copied vault;
- protect plaintext while the device or Telegram client is compromised;
- provide multi-device synchronization, recovery, or backup;
- prove secure deletion from platform-controlled storage;
- detect replay of an older complete, internally consistent snapshot;
- make unofficial deployments or modified forks trustworthy;
- establish that the implementation is free of vulnerabilities.

See [`THREAT_MODEL.md`](THREAT_MODEL.md) for the complete security boundary.
