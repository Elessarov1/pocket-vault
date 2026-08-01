use std::collections::{HashMap, HashSet};

use rand_core::TryCryptoRng;
use serde::{Serialize, de::DeserializeOwned};

use crate::{
    crypto::{derive_kek, unwrap_dek},
    error::{StorageError, VaultError},
    model::{
        ActiveSlotV1, EncryptedVaultSlotV1, FORMAT_VERSION, MAX_METADATA_JSON_BYTES,
        MAX_SLOT_JSON_BYTES, SlotId, VaultMetaV1,
    },
    vault::{CreatedVault, UnlockedVault, decrypt_container},
};

pub const META_KEY: &str = "vault_meta_v1";
pub const SLOT_A_KEY: &str = "vault_slot_a_v1";
pub const SLOT_B_KEY: &str = "vault_slot_b_v1";
pub const ACTIVE_SLOT_KEY: &str = "active_slot_v1";

const MAX_ACTIVE_POINTER_BYTES: usize = 1024;

/// Minimal adapter implemented by Telegram `DeviceStorage` and deterministic tests.
pub trait DeviceStorage {
    /// Reads an optional value.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when the underlying read fails.
    fn get(&mut self, key: &str) -> Result<Option<String>, StorageError>;

    /// Writes or replaces a value.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when the underlying write fails.
    fn set(&mut self, key: &str, value: &str) -> Result<(), StorageError>;

    /// Removes a value if present.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when the underlying removal fails.
    fn remove(&mut self, key: &str) -> Result<(), StorageError>;
}

/// In-memory storage with targeted one-shot failures for repository tests.
#[derive(Clone, Debug, Default)]
pub struct MemoryStorage {
    values: HashMap<String, String>,
    fail_get: HashSet<String>,
    fail_set: HashSet<String>,
    fail_remove: HashSet<String>,
}

impl MemoryStorage {
    #[must_use]
    pub fn raw(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    pub fn insert_raw(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.values.insert(key.into(), value.into());
    }

    pub fn fail_next_get(&mut self, key: impl Into<String>) {
        self.fail_get.insert(key.into());
    }

    pub fn fail_next_set(&mut self, key: impl Into<String>) {
        self.fail_set.insert(key.into());
    }

    pub fn fail_next_remove(&mut self, key: impl Into<String>) {
        self.fail_remove.insert(key.into());
    }
}

impl DeviceStorage for MemoryStorage {
    fn get(&mut self, key: &str) -> Result<Option<String>, StorageError> {
        if self.fail_get.remove(key) {
            return Err(StorageError::ReadFailed);
        }
        Ok(self.values.get(key).cloned())
    }

    fn set(&mut self, key: &str, value: &str) -> Result<(), StorageError> {
        if self.fail_set.remove(key) {
            return Err(StorageError::WriteFailed);
        }
        self.values.insert(key.to_owned(), value.to_owned());
        Ok(())
    }

    fn remove(&mut self, key: &str) -> Result<(), StorageError> {
        if self.fail_remove.remove(key) {
            return Err(StorageError::RemoveFailed);
        }
        self.values.remove(key);
        Ok(())
    }
}

pub struct OpenedVault {
    pub vault: UnlockedVault,
    /// True when the authenticated best slot disagreed with the stored pointer.
    pub active_pointer_repaired: bool,
}

pub struct TwoSlotRepository<S> {
    storage: S,
}

impl<S: DeviceStorage> TwoSlotRepository<S> {
    #[must_use]
    pub const fn new(storage: S) -> Self {
        Self { storage }
    }

    #[must_use]
    pub const fn storage(&self) -> &S {
        &self.storage
    }

    pub const fn storage_mut(&mut self) -> &mut S {
        &mut self.storage
    }

    #[must_use]
    pub fn into_inner(self) -> S {
        self.storage
    }

    /// Persists a newly created vault in recoverable order.
    ///
    /// # Errors
    ///
    /// Returns an error when input validation, serialization, storage, or
    /// read-after-write verification fails.
    pub fn initialize(&mut self, created: &CreatedVault) -> Result<(), VaultError> {
        created.metadata.validate()?;
        created.initial_slot.validate(created.metadata.vault_id)?;
        created.active_slot.validate()?;
        if created.initial_slot.slot != created.active_slot.slot
            || created.initial_slot.generation != created.active_slot.generation
        {
            return Err(VaultError::InvalidSlot(
                "initial slot and active pointer do not match",
            ));
        }
        if self.storage.get(META_KEY)?.is_some() {
            return Err(VaultError::AlreadyInitialized);
        }

        self.write_json_verified(
            slot_key(created.initial_slot.slot),
            &created.initial_slot,
            MAX_SLOT_JSON_BYTES,
        )?;
        self.write_json_verified(META_KEY, &created.metadata, MAX_METADATA_JSON_BYTES)?;
        self.write_json_verified(
            ACTIVE_SLOT_KEY,
            &created.active_slot,
            MAX_ACTIVE_POINTER_BYTES,
        )?;
        Ok(())
    }

    /// Unlocks the newest authenticated slot and repairs a stale pointer.
    ///
    /// # Errors
    ///
    /// Returns an error for missing or invalid metadata, key derivation or
    /// authentication failure, or storage failure.
    pub fn open(&mut self, master_password: &[u8]) -> Result<OpenedVault, VaultError> {
        let metadata: VaultMetaV1 = self.read_required_json(META_KEY, MAX_METADATA_JSON_BYTES)?;
        metadata.validate()?;

        let pointer = self
            .read_optional_json::<ActiveSlotV1>(ACTIVE_SLOT_KEY, MAX_ACTIVE_POINTER_BYTES)
            .ok()
            .flatten()
            .filter(|pointer| pointer.validate().is_ok());

        let mut encrypted_candidates = Vec::with_capacity(2);
        for (expected_slot, key) in [(SlotId::A, SLOT_A_KEY), (SlotId::B, SLOT_B_KEY)] {
            let Ok(Some(slot)) =
                self.read_optional_json::<EncryptedVaultSlotV1>(key, MAX_SLOT_JSON_BYTES)
            else {
                continue;
            };
            if slot.slot != expected_slot || slot.validate(metadata.vault_id).is_err() {
                continue;
            }
            encrypted_candidates.push(slot);
        }
        if encrypted_candidates.is_empty() {
            return Err(VaultError::WrongPasswordOrCorruptedVault);
        }

        let kek = derive_kek(master_password, metadata.vault_id, &metadata.kdf)?;
        let dek = unwrap_dek(&kek, &metadata.wrapped_dek, metadata.vault_id)?;

        let mut candidates = Vec::with_capacity(encrypted_candidates.len());
        for slot in encrypted_candidates {
            if let Ok(container) = decrypt_container(&dek, &slot)
                && container.created_at == metadata.created_at
            {
                candidates.push((slot, container));
            }
        }

        candidates.sort_by(|(left_slot, _), (right_slot, _)| {
            right_slot
                .generation
                .cmp(&left_slot.generation)
                .then_with(|| pointer_preference(pointer, right_slot, left_slot))
        });
        let (selected_slot, container) = candidates
            .into_iter()
            .next()
            .ok_or(VaultError::WrongPasswordOrCorruptedVault)?;

        let selected_pointer = ActiveSlotV1 {
            version: FORMAT_VERSION,
            slot: selected_slot.slot,
            generation: selected_slot.generation,
        };
        let active_pointer_repaired = pointer != Some(selected_pointer);
        if active_pointer_repaired {
            self.write_json_verified(ACTIVE_SLOT_KEY, &selected_pointer, MAX_ACTIVE_POINTER_BYTES)?;
        }

        Ok(OpenedVault {
            vault: UnlockedVault {
                container,
                dek,
                persisted_slot: selected_slot.slot,
            },
            active_pointer_repaired,
        })
    }

    /// Encrypts into the inactive slot, verifies it, and commits the pointer.
    ///
    /// # Errors
    ///
    /// Returns an error when encryption, storage, verification, or generation
    /// advancement fails. The previous committed slot remains available.
    pub fn save(
        &mut self,
        vault: &mut UnlockedVault,
        rng: &mut impl TryCryptoRng,
    ) -> Result<(), VaultError> {
        let target = vault.persisted_slot().other();
        let next_generation = vault
            .generation()
            .checked_add(1)
            .ok_or(VaultError::GenerationOverflow)?;
        let slot = vault.encrypt_for_slot_at_generation(target, next_generation, rng)?;

        self.write_json_verified(slot_key(target), &slot, MAX_SLOT_JSON_BYTES)?;
        let stored: EncryptedVaultSlotV1 =
            self.read_required_json(slot_key(target), MAX_SLOT_JSON_BYTES)?;
        stored.validate(vault.vault_id())?;

        vault.verify_next_slot(&stored)?;

        let pointer = ActiveSlotV1 {
            version: FORMAT_VERSION,
            slot: target,
            generation: next_generation,
        };
        self.write_json_verified(ACTIVE_SLOT_KEY, &pointer, MAX_ACTIVE_POINTER_BYTES)?;
        vault.commit_verified_slot(&stored)?;
        Ok(())
    }

    /// Removes and verifies removal of every Device Storage value owned by the vault.
    ///
    /// The integration layer owns any stronger deletion guarantees offered by
    /// the host platform.
    ///
    /// # Errors
    ///
    /// Returns an error when removal or verification fails.
    pub fn clear_device_storage(&mut self) -> Result<(), VaultError> {
        for key in [META_KEY, SLOT_A_KEY, SLOT_B_KEY, ACTIVE_SLOT_KEY] {
            self.storage.remove(key)?;
            if self.storage.get(key)?.is_some() {
                return Err(VaultError::SlotVerificationFailed);
            }
        }
        Ok(())
    }

    fn write_json_verified<T: Serialize>(
        &mut self,
        key: &str,
        value: &T,
        maximum_bytes: usize,
    ) -> Result<(), VaultError> {
        let encoded = serde_json::to_string(value).map_err(|_| VaultError::SerializationFailed)?;
        if encoded.len() > maximum_bytes {
            return Err(VaultError::VaultTooLarge);
        }
        self.storage.set(key, &encoded)?;
        let stored = self
            .storage
            .get(key)?
            .ok_or(VaultError::SlotVerificationFailed)?;
        if stored != encoded {
            return Err(VaultError::SlotVerificationFailed);
        }
        Ok(())
    }

    fn read_required_json<T: DeserializeOwned>(
        &mut self,
        key: &str,
        maximum_bytes: usize,
    ) -> Result<T, VaultError> {
        self.read_optional_json(key, maximum_bytes)?
            .ok_or(VaultError::Uninitialized)
    }

    fn read_optional_json<T: DeserializeOwned>(
        &mut self,
        key: &str,
        maximum_bytes: usize,
    ) -> Result<Option<T>, VaultError> {
        let Some(encoded) = self.storage.get(key)? else {
            return Ok(None);
        };
        if encoded.len() > maximum_bytes {
            return Err(VaultError::VaultTooLarge);
        }
        serde_json::from_str(&encoded)
            .map(Some)
            .map_err(|_| VaultError::SerializationFailed)
    }
}

fn slot_key(slot: SlotId) -> &'static str {
    match slot {
        SlotId::A => SLOT_A_KEY,
        SlotId::B => SLOT_B_KEY,
    }
}

fn pointer_preference(
    pointer: Option<ActiveSlotV1>,
    right: &EncryptedVaultSlotV1,
    left: &EncryptedVaultSlotV1,
) -> std::cmp::Ordering {
    let right_matches = pointer
        .is_some_and(|value| value.slot == right.slot && value.generation == right.generation);
    let left_matches =
        pointer.is_some_and(|value| value.slot == left.slot && value.generation == left.generation);
    right_matches.cmp(&left_matches)
}
