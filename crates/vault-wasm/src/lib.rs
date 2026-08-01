//! WebAssembly boundary and storage-neutral application session for Pocket Vault.
//!
//! Telegram storage is callback-based, so persistence remains in JavaScript.
//! This crate owns all cryptography, decrypted session state, and the two-phase
//! save verification protocol.

mod bridge;

#[cfg(target_arch = "wasm32")]
mod wasm;

pub use bridge::{
    BridgeError, CreateBundle, OpenBundle, SaveBundle, StorageSnapshot, VaultBridge,
    generate_device_secret_envelope, validate_device_secret_envelope,
};
