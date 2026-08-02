use std::fmt;

use rand_core::TryCryptoRng;
use zeroize::{Zeroize, Zeroizing};

use crate::{
    crypto::{
        decrypt_slot_payload, derive_kek, encrypt_slot_payload, random_array, unwrap_dek, wrap_dek,
    },
    error::VaultError,
    model::{
        ActiveSlotV1, EncryptedVaultSlotV1, EntryId, FORMAT, FORMAT_VERSION, KdfConfig, KdfParams,
        MAX_ENTRIES, MAX_SLOT_JSON_BYTES, NewVaultEntry, SlotId, UpdateVaultEntry,
        VaultContainerV1, VaultEntry, VaultId, VaultMetaV1, validate_entry_fields,
    },
};

const KEY_BYTES: usize = 32;
const ID_BYTES: usize = 16;
const SALT_BYTES: usize = 16;
const MAX_ID_GENERATION_ATTEMPTS: usize = 8;
const MIN_MASTER_PASSWORD_CHARS: usize = 16;

/// All persistent values produced while creating a vault, plus its unlocked session.
pub struct CreatedVault {
    pub metadata: VaultMetaV1,
    pub initial_slot: EncryptedVaultSlotV1,
    pub active_slot: ActiveSlotV1,
    pub unlocked: UnlockedVault,
}

/// An unlocked session. The DEK is private and zeroized when this value is dropped.
pub struct UnlockedVault {
    pub(crate) container: VaultContainerV1,
    pub(crate) dek: Zeroizing<[u8; KEY_BYTES]>,
    pub(crate) persisted_slot: SlotId,
}

impl fmt::Debug for UnlockedVault {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UnlockedVault")
            .field("container", &self.container)
            .field("dek", &"[REDACTED]")
            .field("persisted_slot", &self.persisted_slot)
            .finish()
    }
}

/// Creates a new empty vault using a master password and caller-provided CSPRNG.
///
/// The caller retains ownership of `master_password` and must zeroize its input
/// buffer after this function returns.
///
/// # Errors
///
/// Returns an error when the KDF configuration is invalid, key derivation or
/// encryption fails, or the initial container exceeds its size limit.
pub fn create_vault(
    master_password: &[u8],
    config: KdfConfig,
    now: u64,
    rng: &mut impl TryCryptoRng,
) -> Result<CreatedVault, VaultError> {
    validate_new_master_password(master_password)?;
    let vault_id = VaultId::from_bytes(random_array::<ID_BYTES>(rng)?);
    let salt = random_array::<SALT_BYTES>(rng)?;
    let kdf = KdfParams::from_config(salt, config);
    kdf.validate()?;

    let kek = derive_kek(master_password, vault_id, &kdf)?;
    let dek = Zeroizing::new(random_array::<KEY_BYTES>(rng)?);
    let wrapped_dek = wrap_dek(&kek, &dek, vault_id, rng)?;

    let metadata = VaultMetaV1 {
        format: FORMAT.to_owned(),
        version: FORMAT_VERSION,
        vault_id,
        created_at: now,
        kdf,
        wrapped_dek,
    };
    let container = VaultContainerV1 {
        format: FORMAT.to_owned(),
        version: FORMAT_VERSION,
        vault_id,
        generation: 0,
        created_at: now,
        updated_at: now,
        entries: Vec::new(),
    };
    let plaintext = serialize_container(&container)?;
    let initial_slot = encrypt_slot_payload(
        &dek,
        vault_id,
        SlotId::A,
        container.generation,
        plaintext.as_ref(),
        rng,
    )?;
    let active_slot = ActiveSlotV1 {
        version: FORMAT_VERSION,
        slot: SlotId::A,
        generation: 0,
    };

    Ok(CreatedVault {
        metadata,
        initial_slot,
        active_slot,
        unlocked: UnlockedVault {
            container,
            dek,
            persisted_slot: SlotId::A,
        },
    })
}

fn validate_new_master_password(master_password: &[u8]) -> Result<(), VaultError> {
    let value = std::str::from_utf8(master_password)
        .map_err(|_| VaultError::InvalidMasterPassword("password must be valid UTF-8"))?;
    if value.chars().count() < MIN_MASTER_PASSWORD_CHARS {
        return Err(VaultError::InvalidMasterPassword(
            "password must contain at least 16 characters",
        ));
    }
    Ok(())
}

/// Unlocks one authenticated slot. Password failures and ciphertext corruption
/// intentionally share the same error category.
///
/// # Errors
///
/// Returns an error when validation, key derivation, authentication, or
/// decrypted-container validation fails.
pub fn unlock_vault(
    master_password: &[u8],
    metadata: &VaultMetaV1,
    slot: &EncryptedVaultSlotV1,
) -> Result<UnlockedVault, VaultError> {
    metadata.validate()?;
    slot.validate(metadata.vault_id)?;

    let kek = derive_kek(master_password, metadata.vault_id, &metadata.kdf)?;
    let dek = unwrap_dek(&kek, &metadata.wrapped_dek, metadata.vault_id)?;
    let container = decrypt_container(&dek, slot)?;
    if container.created_at != metadata.created_at {
        return Err(VaultError::InvalidMetadata(
            "createdAt does not match encrypted vault",
        ));
    }

    Ok(UnlockedVault {
        container,
        dek,
        persisted_slot: slot.slot,
    })
}

/// Verifies the current master password and wraps the existing data key with a
/// newly derived key. Encrypted vault slots remain unchanged.
///
/// # Errors
///
/// Returns an error when either password is invalid, metadata does not belong
/// to the unlocked vault, randomness is unavailable, or key wrapping fails.
pub fn rewrap_vault_key(
    current_master_password: &[u8],
    new_master_password: &[u8],
    metadata: &VaultMetaV1,
    vault: &UnlockedVault,
    config: KdfConfig,
    rng: &mut impl TryCryptoRng,
) -> Result<VaultMetaV1, VaultError> {
    metadata.validate()?;
    if metadata.vault_id != vault.container.vault_id
        || metadata.created_at != vault.container.created_at
    {
        return Err(VaultError::InvalidMetadata(
            "metadata does not match the unlocked vault",
        ));
    }

    let current_kek = derive_kek(current_master_password, metadata.vault_id, &metadata.kdf)?;
    let verified_dek = unwrap_dek(&current_kek, &metadata.wrapped_dek, metadata.vault_id)?;
    if verified_dek.as_ref() != vault.dek.as_ref() {
        return Err(VaultError::WrongPasswordOrCorruptedVault);
    }

    validate_new_master_password(new_master_password)?;
    let salt = random_array::<SALT_BYTES>(rng)?;
    let kdf = KdfParams::from_config(salt, config);
    kdf.validate()?;
    let new_kek = derive_kek(new_master_password, metadata.vault_id, &kdf)?;
    let wrapped_dek = wrap_dek(&new_kek, &vault.dek, metadata.vault_id, rng)?;

    Ok(VaultMetaV1 {
        format: metadata.format.clone(),
        version: metadata.version,
        vault_id: metadata.vault_id,
        created_at: metadata.created_at,
        kdf,
        wrapped_dek,
    })
}

impl UnlockedVault {
    #[must_use]
    pub fn entries(&self) -> &[VaultEntry] {
        &self.container.entries
    }

    #[must_use]
    pub const fn vault_id(&self) -> VaultId {
        self.container.vault_id
    }

    #[must_use]
    pub const fn generation(&self) -> u64 {
        self.container.generation
    }

    #[must_use]
    pub const fn persisted_slot(&self) -> SlotId {
        self.persisted_slot
    }

    /// Adds a validated entry and returns its random identifier.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid fields, a full vault, or repeated random
    /// identifier collisions.
    pub fn add_entry(
        &mut self,
        mut input: NewVaultEntry,
        now: u64,
        rng: &mut impl TryCryptoRng,
    ) -> Result<EntryId, VaultError> {
        validate_entry_fields(&input.title, &input.secret, input.description.as_deref())?;
        if self.container.entries.len() >= MAX_ENTRIES {
            return Err(VaultError::VaultTooLarge);
        }

        let id = self.generate_unique_entry_id(rng)?;
        let timestamp = now.max(self.container.updated_at);
        self.container.entries.push(VaultEntry {
            id,
            title: std::mem::take(&mut input.title),
            secret: std::mem::take(&mut input.secret),
            description: std::mem::take(&mut input.description),
            created_at: timestamp,
            updated_at: timestamp,
        });
        self.container.updated_at = timestamp;
        Ok(id)
    }

    /// Replaces every editable field of an existing entry.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid fields or an unknown entry identifier.
    pub fn update_entry(
        &mut self,
        mut input: UpdateVaultEntry,
        now: u64,
    ) -> Result<(), VaultError> {
        validate_entry_fields(&input.title, &input.secret, input.description.as_deref())?;
        let timestamp = now.max(self.container.updated_at);
        let entry = self
            .container
            .entries
            .iter_mut()
            .find(|entry| entry.id == input.id)
            .ok_or(VaultError::EntryNotFound)?;
        entry.title.zeroize();
        entry.secret.zeroize();
        if let Some(description) = &mut entry.description {
            description.zeroize();
        }
        entry.title = std::mem::take(&mut input.title);
        entry.secret = std::mem::take(&mut input.secret);
        entry.description = std::mem::take(&mut input.description);
        entry.updated_at = timestamp.max(entry.created_at);
        self.container.updated_at = timestamp;
        Ok(())
    }

    /// Deletes an entry by identifier.
    ///
    /// # Errors
    ///
    /// Returns [`VaultError::EntryNotFound`] when the identifier is unknown.
    pub fn delete_entry(&mut self, id: EntryId, now: u64) -> Result<(), VaultError> {
        let index = self
            .container
            .entries
            .iter()
            .position(|entry| entry.id == id)
            .ok_or(VaultError::EntryNotFound)?;
        self.container.entries.remove(index);
        self.container.updated_at = now.max(self.container.updated_at);
        Ok(())
    }

    /// Encrypts the current state for the next generation of the selected slot.
    ///
    /// # Errors
    ///
    /// Returns an error when the generation overflows, serialization exceeds
    /// limits, or encryption fails.
    pub fn encrypt_for_slot(
        &self,
        slot: SlotId,
        rng: &mut impl TryCryptoRng,
    ) -> Result<EncryptedVaultSlotV1, VaultError> {
        let generation = self
            .container
            .generation
            .checked_add(1)
            .ok_or(VaultError::GenerationOverflow)?;
        self.encrypt_for_slot_at_generation(slot, generation, rng)
    }

    pub(crate) fn encrypt_for_slot_at_generation(
        &self,
        slot: SlotId,
        generation: u64,
        rng: &mut impl TryCryptoRng,
    ) -> Result<EncryptedVaultSlotV1, VaultError> {
        let mut candidate = self.container.clone();
        candidate.generation = generation;
        let plaintext = serialize_container(&candidate)?;
        encrypt_slot_payload(
            &self.dek,
            candidate.vault_id,
            slot,
            generation,
            plaintext.as_ref(),
            rng,
        )
    }

    pub(crate) fn decrypt_candidate(
        &self,
        slot: &EncryptedVaultSlotV1,
    ) -> Result<VaultContainerV1, VaultError> {
        slot.validate(self.container.vault_id)?;
        decrypt_container(&self.dek, slot)
    }

    /// Authenticates a read-back slot, compares its plaintext with the current
    /// state, and marks it as committed after the storage adapter has committed
    /// its active pointer.
    ///
    /// # Errors
    ///
    /// Returns an error unless the slot is the inactive slot at exactly the
    /// next generation and decrypts to the current container contents.
    pub fn commit_verified_slot(&mut self, slot: &EncryptedVaultSlotV1) -> Result<(), VaultError> {
        self.verify_next_slot(slot)?;
        self.container.generation = slot.generation;
        self.persisted_slot = slot.slot;
        Ok(())
    }

    /// Authenticates and compares the candidate for the inactive slot without
    /// changing the current session state.
    ///
    /// # Errors
    ///
    /// Returns an error unless the candidate is the inactive slot at exactly
    /// the next generation and decrypts to the current container contents.
    pub fn verify_next_slot(&self, slot: &EncryptedVaultSlotV1) -> Result<(), VaultError> {
        let expected_generation = self
            .container
            .generation
            .checked_add(1)
            .ok_or(VaultError::GenerationOverflow)?;
        if slot.slot != self.persisted_slot.other() || slot.generation != expected_generation {
            return Err(VaultError::SlotVerificationFailed);
        }

        let verified = self.decrypt_candidate(slot)?;
        let mut expected = self.container.clone();
        expected.generation = expected_generation;
        if verified != expected {
            return Err(VaultError::SlotVerificationFailed);
        }

        Ok(())
    }

    fn generate_unique_entry_id(&self, rng: &mut impl TryCryptoRng) -> Result<EntryId, VaultError> {
        for _ in 0..MAX_ID_GENERATION_ATTEMPTS {
            let id = EntryId::from_bytes(random_array::<ID_BYTES>(rng)?);
            if self.container.entries.iter().all(|entry| entry.id != id) {
                return Ok(id);
            }
        }
        Err(VaultError::RandomGenerationFailed)
    }
}

pub(crate) fn decrypt_container(
    dek: &[u8; KEY_BYTES],
    slot: &EncryptedVaultSlotV1,
) -> Result<VaultContainerV1, VaultError> {
    let plaintext = decrypt_slot_payload(dek, slot)?;
    if plaintext.len() > MAX_SLOT_JSON_BYTES {
        return Err(VaultError::VaultTooLarge);
    }
    let container: VaultContainerV1 = serde_json::from_slice(plaintext.as_ref())
        .map_err(|_| VaultError::InvalidContainer("plaintext JSON is invalid"))?;
    container.validate(slot.vault_id, slot.generation)?;
    Ok(container)
}

fn serialize_container(container: &VaultContainerV1) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    let plaintext = serde_json::to_vec(container).map_err(|_| VaultError::SerializationFailed)?;
    if plaintext.len() > MAX_SLOT_JSON_BYTES.saturating_sub(16) {
        return Err(VaultError::VaultTooLarge);
    }
    Ok(Zeroizing::new(plaintext))
}
