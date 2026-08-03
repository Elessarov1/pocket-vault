# Pocket Vault

Pocket Vault is a local encrypted vault for passwords, PINs, and other short
secrets inside a Telegram Mini App. Vault records are encrypted on the device,
and DeviceStorage receives only ciphertext. The master passphrase is never sent
to the project developer and is not persisted in DeviceStorage, SecureStorage,
or browser localStorage. An unlocked session exists only in WebView memory.

The source code is available for study, modification, and noncommercial use
under the PolyForm Noncommercial License 1.0.0. Commercial use requires a
separate written agreement with the copyright holder. See
[`LICENSING.md`](LICENSING.md) for details.

The repository contains four layers:

- `crates/vault-core` — a Rust core with no dependency on Telegram, browsers,
  clocks, or a system random-number generator;
- `crates/vault-wasm` — the WASM boundary that owns the decrypted session and
  implements the two-phase save protocol;
- `web/src` — a Promise-based Telegram `DeviceStorage` adapter, application
  state controller, capability checks, and lifecycle orchestration;
- `web` — the working Mini App interface, JSON translation catalog, and its
  connection to WASM and Telegram Storage.

## Core

The core implements the versioned V1 format, vault creation and unlocking,
master-passphrase rotation, entry CRUD, Argon2id + HKDF-SHA-256, random DEK wrapping,
XChaCha20-Poly1305, and crash-tolerant two-slot persistence. Every entry field
exists only inside the encrypted container. The format and exact AAD
construction are documented in [`docs/FORMAT.md`](docs/FORMAT.md).

Development checks:

```powershell
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
cargo check --workspace --target wasm32-unknown-unknown
npm test
npm run build:wasm
npm run smoke:wasm
```

The core receives a CSPRNG and time from the calling layer. WASM uses Web
Crypto, and the Telegram adapters verify persistent writes by reading them
back. The interface accesses decrypted data only through an unlocked WASM
session. Entry lists never receive descriptions or secrets; a secret is
requested separately only after an explicit reveal or copy action.

Vault creation accepts only a valid UTF-8 master passphrase of at least 16
characters. Strength guidance and confirmation are handled by the UI.
Passwordless destruction is an intentional product policy: the persistence
layer locks the session and removes all Pocket Vault keys from DeviceStorage.

The generated `web/pkg` directory is not committed to Git. Run
`npm run build:wasm` before local integration. The complete storage and
lifecycle flow is documented in
[`docs/INTEGRATION.md`](docs/INTEGRATION.md).

## Security documentation

- [`SECURITY.md`](SECURITY.md) explains how to report vulnerabilities without
  exposing real user data.
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) defines assets, trust
  boundaries, attacker capabilities, and non-guarantees.
- [`docs/CRYPTOGRAPHY.md`](docs/CRYPTOGRAPHY.md) describes the key hierarchy and
  cryptographic design; [`docs/FORMAT.md`](docs/FORMAT.md) remains the normative
  format specification.
- [`docs/TESTED_PLATFORMS.md`](docs/TESTED_PLATFORMS.md) records manual Telegram
  client coverage. The current beta has been manually checked on iOS and
  Windows; exact client build numbers were not recorded in the initial pass.

## Local development

Build the WASM package and start the local static server:

```powershell
npm run build:wasm
node scripts/serve.mjs
```

Open `http://127.0.0.1:4173` for the production application or
`http://127.0.0.1:4173/review.html` for the design-review playground. The
production page contains no phone frame, screen picker, or review controls;
the review page embeds that same application instead of duplicating it.

The interface is available in Russian and English. On first launch it follows
the Telegram user language, with English as the fallback for other languages.
A manual language choice is stored locally in the current client.
The color theme follows the device setting until the user switches it; a
manual light or dark choice is then stored locally in the current client.
Auto-lock defaults to five minutes of inactivity and can be set to 5, 10, 15,
or a custom value from 1 to 1,440 minutes. This non-secret preference is stored in
browser localStorage.

Localhost enables a safe preview runtime. It uses the same WASM module,
controller, and persistence protocol, but its callback storage exists only in
the current tab's memory and is cleared on reload. This fallback is disabled in
Telegram: the production application requires Bot API 9.0 and uses only
`DeviceStorage`. A full WebView restart always requires the master passphrase.
While Telegram keeps the Mini App tab alive, the in-memory session remains
available only until the configured inactivity timeout. Leaving the app hides
rendered secrets and clears secret forms immediately; manual locking drops the
session immediately.
The production target includes current Telegram clients on
iOS, Android, Windows, macOS, and Linux. Each device has an independent local
vault; Pocket Vault does not currently synchronize data between devices.

Because no platform-specific secret is required, the master passphrase is the
only user secret. Anyone who obtains a copy of the encrypted DeviceStorage
values can attempt offline password guesses; a long, unique passphrase and the
serialized Argon2id cost are the defenses against that attack.

On startup, the integration layer removes legacy quick-unlock values created by
earlier builds without using Telegram's restore operation. Changing the
passphrase verifies the current one and rewraps the existing random DEK with a
fresh salt, so entry slots do not need to be decrypted and rewritten.

## Deployment

The `.github/workflows/pages.yml` workflow tests the project, builds the
ignored `web/pkg` artifacts, and publishes the `web` directory to GitHub Pages.
Enable it in the repository under
`Settings → Pages → Source: GitHub Actions`. After deployment, the public
privacy policy is available at `/privacy.html`.

## Licensing

Pocket Vault is source-available software, not Open Source under the OSI
definition. The public license is
[`PolyForm-Noncommercial-1.0.0`](LICENSE.md). Separate commercial licenses may
be available. The project name, logo, and visual identity are not included in
the source-code license; see [`TRADEMARKS.md`](TRADEMARKS.md).
