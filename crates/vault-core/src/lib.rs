//! Cryptographic and persistence core for Pocket Vault.
//!
//! The crate intentionally has no Telegram, browser, clock, or operating-system
//! dependencies. Callers provide timestamps, storage adapters, and a
//! cryptographically secure random number generator.

mod crypto;
mod encoding;
mod error;
mod model;
mod storage;
mod vault;

pub use error::{StorageError, VaultError};
pub use model::{
    ActiveSlotV1, AeadAlgorithm, EncryptedVaultSlotV1, EntryId, KdfAlgorithm, KdfConfig, KdfParams,
    NewVaultEntry, SlotId, UpdateVaultEntry, VaultContainerV1, VaultEntry, VaultId, VaultMetaV1,
    WrappedDekV1,
};
pub use storage::{
    ACTIVE_SLOT_KEY, DeviceStorage, META_KEY, MemoryStorage, OpenedVault, SLOT_A_KEY, SLOT_B_KEY,
    TwoSlotRepository,
};
pub use vault::{CreatedVault, UnlockedVault, create_vault, unlock_vault};
