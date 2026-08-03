# Pocket Vault Threat Model

This document describes the intended security boundary of Pocket Vault V1. It
is a design statement, not a claim of independent audit or complete security.

## 1. Assets

Pocket Vault protects:

- entry titles, passwords, PINs, notes, identifiers, and timestamps;
- the user's master passphrase;
- the random data-encryption key (DEK) and derived key material;
- the integrity of encrypted vault metadata, slots, and the active pointer;
- the integrity of the application code delivered to the Telegram WebView.

The master passphrase is the only required user secret. There is no backend
account, recovery key, mandatory biometric factor, or device-bound secret.

## 2. Trust boundaries

Data crosses these boundaries:

1. The user enters a master passphrase and vault data into the Telegram WebView.
2. JavaScript passes sensitive values to the Rust/WASM module in the same
   WebView process.
3. WASM returns encrypted metadata and slots to JavaScript for persistence.
4. The Telegram Mini App bridge stores those values in `DeviceStorage`.
5. GitHub Pages and Telegram deliver the HTML, JavaScript, WASM, and Telegram
   bridge used by the client.

The operating system, official Telegram client and WebView, Telegram platform,
GitHub Pages, repository release workflow, and loaded Telegram Web App script
are trusted components. Pocket Vault has no application backend that receives
vault data.

## 3. Attacker capabilities

The design considers an attacker who can:

- obtain a copy of all Pocket Vault `DeviceStorage` values;
- tamper with, remove, reorder, or replay stored values;
- make offline master-passphrase guesses using copied ciphertext;
- observe values deliberately placed on the clipboard;
- make the user open the app on a shared or unattended device;
- interrupt a storage operation or close the WebView during a save.

An attacker who controls the device, operating system, Telegram client,
WebView, delivered application code, or user's input is outside the supported
boundary because that attacker can observe plaintext at the point of use.

## 4. Supported security guarantees

Pocket Vault is designed to provide the following guarantees while its trusted
components behave correctly:

- vault entries are encrypted before being written to `DeviceStorage`;
- the master passphrase is not persisted in `DeviceStorage`, `SecureStorage`,
  browser `localStorage`, or an application backend;
- the DEK is random and is stored only after authenticated wrapping by a key
  derived from the master passphrase;
- ciphertext and relevant format context are authenticated, so modification is
  detected before plaintext is accepted;
- an unlocked session exists only in WebView memory and is dropped after the
  configured inactivity timeout or manual lock;
- storage writes use readback verification and a two-slot protocol to reduce
  corruption from an interrupted write;
- the project developer does not receive the vault, passphrase, or encryption
  keys through normal application operation.

The exact construction is documented in [`CRYPTOGRAPHY.md`](CRYPTOGRAPHY.md)
and the serialized format in [`FORMAT.md`](FORMAT.md).

## 5. Out of scope and non-guarantees

Pocket Vault does not protect against:

- a compromised or malicious OS, Telegram client, WebView, keyboard, browser
  extension, or delivered application bundle;
- screen capture, keylogging, memory inspection, shoulder surfing, or a
  clipboard reader with local access;
- a weak, reused, disclosed, or socially engineered master passphrase;
- denial of service, storage eviction, accidental deletion, or loss of the
  device before an encrypted export feature exists;
- a complete rollback in which an attacker replaces all stored values with an
  older internally consistent snapshot;
- physical erasure from backups or storage layers controlled by the OS or
  Telegram;
- malicious unofficial bots, deployments, or forks.

Source availability is useful for review but is not evidence that the code has
been independently audited. Pocket Vault is not yet a replacement for a mature,
independently reviewed password manager.

## 6. Offline guessing

A copied `DeviceStorage` snapshot contains the KDF parameters, salt, wrapped
DEK, and encrypted slots. It therefore permits unlimited offline guesses of the
master passphrase. Argon2id raises the cost of each guess but cannot prevent
guessing or compensate for a predictable passphrase.

Users should choose a unique phrase made from at least six or seven randomly
selected, unrelated words. The example shown in the interface is a format
example and must not be reused.

## 7. Supply-chain risk

The published application can access plaintext while the vault is unlocked.
Compromise of the repository, GitHub Actions, GitHub Pages, the Telegram Web App
bridge, a Rust/JavaScript dependency, or the Telegram delivery path could
replace trusted code and capture secrets.

Risk is reduced through pinned workflow actions, a Content Security Policy,
local cryptographic dependencies, automated tests, and a small application
surface. These controls reduce risk; they do not remove the need for dependency
review, reproducible releases, and independent security review.

## 8. Device compromise and session lifecycle

Plaintext and the DEK exist in process memory while a vault is unlocked. Rust
buffers use best-effort zeroization, and the application clears exposed secret
forms and rendered secrets on deactivation. JavaScript strings, browser copies,
allocator behavior, swap, crash dumps, and OS snapshots cannot be reliably
zeroized by a WebAssembly application.

The default inactivity timeout is five minutes. A user may choose 5, 10, 15, or
a custom value from 1 to 1,440 minutes. Longer values increase exposure on an
unattended unlocked device. A full WebView restart and manual lock always
require the master passphrase again.

## 9. Clipboard

Copying a secret deliberately moves it outside the encrypted vault. Clipboard
history, synchronization, another application, or the operating system may
retain or read it. Pocket Vault cannot guarantee clipboard clearing on every
supported Telegram client and platform.

## 10. Telegram platform dependency

Pocket Vault requires Telegram Bot API 9.0 and `DeviceStorage`. Desktop support
is a reason not to make `SecureStorage`, biometrics, or a device-bound key part
of the mandatory cryptographic design. Every Telegram installation maintains
an independent local vault; Pocket Vault does not currently synchronize vaults
between devices.

Platform defects and storage semantics may affect availability or deletion.
Known client coverage is recorded in
[`TESTED_PLATFORMS.md`](TESTED_PLATFORMS.md).

## 11. Data deletion semantics

Passwordless destruction is an intentional recovery policy for a forgotten
master passphrase. It locks the active session, removes every Pocket Vault key
from the current client's `DeviceStorage`, and verifies that the keys are no
longer readable.

This operation does not prove physical erasure from flash storage, OS backups,
Telegram-managed backups, crash dumps, clipboard history, or snapshots already
copied by an attacker. It affects only the current Telegram client because
vaults are not synchronized.

## 12. Future export implications

Encrypted export/import will create portable copies that remain available for
offline guessing and rollback. Before that feature is added, its format,
authentication, overwrite rules, conflict behavior, metadata exposure, and
safe file handling require a separate threat-model review. Unencrypted export
is not part of the current design.
