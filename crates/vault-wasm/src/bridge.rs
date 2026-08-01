use rand_core::TryCryptoRng;
use serde::Serialize;
use thiserror::Error;
use vault_core::{
    ACTIVE_SLOT_KEY, ActiveSlotV1, EncryptedVaultSlotV1, EntryId, KdfConfig, META_KEY,
    MemoryStorage, NewVaultEntry, SLOT_A_KEY, SLOT_B_KEY, SlotId, TwoSlotRepository, UnlockedVault,
    UpdateVaultEntry, VaultError, create_vault,
};

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("vault operation failed: {0}")]
    Vault(#[from] VaultError),
    #[error("vault session is locked")]
    Locked,
    #[error("a save is already pending")]
    SavePending,
    #[error("no save is pending")]
    NoSavePending,
    #[error("pending slot has not been verified")]
    PendingSlotNotVerified,
    #[error("storage read-back does not match the prepared value")]
    ReadbackMismatch,
    #[error("persistent value serialization failed")]
    Serialization,
    #[error("metadata is missing")]
    MissingMetadata,
}

impl BridgeError {
    /// Stable error code intended for JavaScript and localized UI mapping.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Vault(VaultError::InvalidMasterPassword(_)) => "invalid_master_password",
            Self::Vault(VaultError::WrongPasswordOrCorruptedVault) => "cannot_open_vault",
            Self::Vault(VaultError::EntryNotFound) => "entry_not_found",
            Self::Vault(VaultError::VaultTooLarge) => "vault_too_large",
            Self::Vault(VaultError::UnsupportedFormatVersion) => "unsupported_format",
            Self::Vault(VaultError::InvalidKdfParameters(_)) => "invalid_kdf_parameters",
            Self::Vault(VaultError::RandomGenerationFailed) => "random_unavailable",
            Self::Vault(VaultError::AlreadyInitialized) => "already_initialized",
            Self::Vault(VaultError::Uninitialized) | Self::MissingMetadata => "uninitialized",
            Self::Locked => "locked",
            Self::SavePending => "save_pending",
            Self::NoSavePending => "no_save_pending",
            Self::PendingSlotNotVerified => "pending_slot_not_verified",
            Self::ReadbackMismatch => "storage_readback_mismatch",
            Self::Serialization => "serialization_failed",
            Self::Vault(_) => "vault_operation_failed",
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct StorageSnapshot {
    pub metadata_json: Option<String>,
    pub slot_a_json: Option<String>,
    pub slot_b_json: Option<String>,
    pub active_pointer_json: Option<String>,
}

pub struct CreateBundle {
    pub session: VaultBridge,
    pub metadata_json: String,
    pub slot_key: &'static str,
    pub slot_json: String,
    pub active_pointer_json: String,
}

pub struct OpenBundle {
    pub session: VaultBridge,
    pub repaired_pointer_json: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SaveBundle {
    pub slot_key: &'static str,
    pub slot_json: String,
    pub active_pointer_json: String,
}

struct PendingSave {
    slot: EncryptedVaultSlotV1,
    slot_json: String,
    active_pointer: ActiveSlotV1,
    active_pointer_json: String,
    slot_verified: bool,
}

pub struct VaultBridge {
    vault: Option<UnlockedVault>,
    pending: Option<PendingSave>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EntrySummary<'a> {
    id: String,
    title: &'a str,
    created_at: u64,
    updated_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EntryDetails<'a> {
    id: String,
    title: &'a str,
    description: Option<&'a str>,
    created_at: u64,
    updated_at: u64,
}

impl VaultBridge {
    /// Creates an unlocked session and its initial persistence bundle.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid master phrase, random source, KDF,
    /// encryption, or serialization failure.
    pub fn create(
        master_password: &[u8],
        now: u64,
        rng: &mut impl TryCryptoRng,
    ) -> Result<CreateBundle, BridgeError> {
        let created = create_vault(master_password, KdfConfig::default(), now, rng)?;
        let metadata_json =
            serde_json::to_string(&created.metadata).map_err(|_| BridgeError::Serialization)?;
        let slot_json =
            serde_json::to_string(&created.initial_slot).map_err(|_| BridgeError::Serialization)?;
        let active_pointer_json =
            serde_json::to_string(&created.active_slot).map_err(|_| BridgeError::Serialization)?;
        let slot_key = slot_key(created.initial_slot.slot);

        Ok(CreateBundle {
            session: Self {
                vault: Some(created.unlocked),
                pending: None,
            },
            metadata_json,
            slot_key,
            slot_json,
            active_pointer_json,
        })
    }

    /// Opens the best authenticated slot from a storage snapshot.
    ///
    /// # Errors
    ///
    /// Returns an error for missing metadata, malformed storage, or an
    /// authentication failure.
    pub fn open(
        master_password: &[u8],
        snapshot: StorageSnapshot,
    ) -> Result<OpenBundle, BridgeError> {
        let mut repository = TwoSlotRepository::new(MemoryStorage::default());
        insert_optional(repository.storage_mut(), META_KEY, snapshot.metadata_json);
        insert_optional(repository.storage_mut(), SLOT_A_KEY, snapshot.slot_a_json);
        insert_optional(repository.storage_mut(), SLOT_B_KEY, snapshot.slot_b_json);
        insert_optional(
            repository.storage_mut(),
            ACTIVE_SLOT_KEY,
            snapshot.active_pointer_json,
        );
        if repository.storage().raw(META_KEY).is_none() {
            return Err(BridgeError::MissingMetadata);
        }

        let opened = repository.open(master_password)?;
        let repaired_pointer_json = opened
            .active_pointer_repaired
            .then(|| repository.storage().raw(ACTIVE_SLOT_KEY).map(str::to_owned))
            .flatten();

        Ok(OpenBundle {
            session: Self {
                vault: Some(opened.vault),
                pending: None,
            },
            repaired_pointer_json,
        })
    }

    #[must_use]
    pub const fn is_locked(&self) -> bool {
        self.vault.is_none()
    }

    #[must_use]
    pub fn generation(&self) -> Option<u64> {
        self.vault.as_ref().map(UnlockedVault::generation)
    }

    #[must_use]
    pub fn persisted_slot(&self) -> Option<SlotId> {
        self.vault.as_ref().map(UnlockedVault::persisted_slot)
    }

    /// Serializes non-secret list summaries. Secrets and descriptions are omitted.
    ///
    /// # Errors
    ///
    /// Returns an error when the session is locked or serialization fails.
    pub fn list_entries_json(&self) -> Result<String, BridgeError> {
        let vault = self.vault_ref()?;
        let summaries: Vec<_> = vault
            .entries()
            .iter()
            .map(|entry| EntrySummary {
                id: entry.id.to_base64url(),
                title: &entry.title,
                created_at: entry.created_at,
                updated_at: entry.updated_at,
            })
            .collect();
        serde_json::to_string(&summaries).map_err(|_| BridgeError::Serialization)
    }

    /// Serializes one complete entry for the detail screen.
    ///
    /// # Errors
    ///
    /// Returns an error for a locked session, malformed identifier, unknown
    /// entry, or serialization failure.
    pub fn get_entry_json(&self, id: &str) -> Result<String, BridgeError> {
        let entry = self.entry(id)?;
        serde_json::to_string(entry).map_err(|_| BridgeError::Serialization)
    }

    /// Serializes entry details without materializing its secret in JavaScript.
    ///
    /// # Errors
    ///
    /// Returns an error for a locked session, malformed identifier, unknown
    /// entry, or serialization failure.
    pub fn get_entry_details_json(&self, id: &str) -> Result<String, BridgeError> {
        let entry = self.entry(id)?;
        let details = EntryDetails {
            id: entry.id.to_base64url(),
            title: &entry.title,
            description: entry.description.as_deref(),
            created_at: entry.created_at,
            updated_at: entry.updated_at,
        };
        serde_json::to_string(&details).map_err(|_| BridgeError::Serialization)
    }

    /// Returns a secret only for an explicit reveal or copy action.
    ///
    /// # Errors
    ///
    /// Returns an error for a locked session, malformed identifier, or unknown
    /// entry.
    pub fn get_entry_secret(&self, id: &str) -> Result<String, BridgeError> {
        Ok(self.entry(id)?.secret.clone())
    }

    /// Adds an entry and returns its `Base64URL` identifier.
    ///
    /// # Errors
    ///
    /// Returns an error when saving is pending, the session is locked, input
    /// validation fails, or randomness is unavailable.
    pub fn add_entry(
        &mut self,
        title: String,
        secret: String,
        description: Option<String>,
        now: u64,
        rng: &mut impl TryCryptoRng,
    ) -> Result<String, BridgeError> {
        self.ensure_mutable()?;
        let id = self.vault_mut()?.add_entry(
            NewVaultEntry {
                title,
                secret,
                description,
            },
            now,
            rng,
        )?;
        Ok(id.to_base64url())
    }

    /// Updates an entry.
    ///
    /// # Errors
    ///
    /// Returns an error when saving is pending, the session is locked, the ID
    /// is malformed or unknown, or input validation fails.
    pub fn update_entry(
        &mut self,
        id: &str,
        title: String,
        secret: String,
        description: Option<String>,
        now: u64,
    ) -> Result<(), BridgeError> {
        self.ensure_mutable()?;
        let id = parse_entry_id(id)?;
        self.vault_mut()?.update_entry(
            UpdateVaultEntry {
                id,
                title,
                secret,
                description,
            },
            now,
        )?;
        Ok(())
    }

    /// Deletes an entry.
    ///
    /// # Errors
    ///
    /// Returns an error when saving is pending, the session is locked, or the
    /// identifier is malformed or unknown.
    pub fn delete_entry(&mut self, id: &str, now: u64) -> Result<(), BridgeError> {
        self.ensure_mutable()?;
        let id = parse_entry_id(id)?;
        self.vault_mut()?.delete_entry(id, now)?;
        Ok(())
    }

    fn entry(&self, id: &str) -> Result<&vault_core::VaultEntry, BridgeError> {
        let id = parse_entry_id(id)?;
        self.vault_ref()?
            .entries()
            .iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| BridgeError::from(VaultError::EntryNotFound))
    }

    /// Prepares the inactive encrypted slot and active pointer without changing
    /// the committed generation.
    ///
    /// # Errors
    ///
    /// Returns an error for a locked session, an existing pending save,
    /// randomness, encryption, or serialization failure.
    pub fn prepare_save(&mut self, rng: &mut impl TryCryptoRng) -> Result<SaveBundle, BridgeError> {
        self.ensure_mutable()?;
        let vault = self.vault_ref()?;
        let target = vault.persisted_slot().other();
        let slot = vault.encrypt_for_slot(target, rng)?;
        let active_pointer = ActiveSlotV1 {
            version: 1,
            slot: target,
            generation: slot.generation,
        };
        let slot_json = serde_json::to_string(&slot).map_err(|_| BridgeError::Serialization)?;
        let active_pointer_json =
            serde_json::to_string(&active_pointer).map_err(|_| BridgeError::Serialization)?;
        let bundle = SaveBundle {
            slot_key: slot_key(target),
            slot_json: slot_json.clone(),
            active_pointer_json: active_pointer_json.clone(),
        };
        self.pending = Some(PendingSave {
            slot,
            slot_json,
            active_pointer,
            active_pointer_json,
            slot_verified: false,
        });
        Ok(bundle)
    }

    /// Verifies the exact slot value read back by the storage adapter.
    ///
    /// # Errors
    ///
    /// Returns an error when no save is pending, the bytes differ, parsing
    /// fails, or authenticated plaintext does not match the session.
    pub fn verify_pending_slot(&mut self, readback_json: &str) -> Result<(), BridgeError> {
        let vault = self.vault.as_ref().ok_or(BridgeError::Locked)?;
        let pending = self.pending.as_mut().ok_or(BridgeError::NoSavePending)?;
        if readback_json != pending.slot_json {
            return Err(BridgeError::ReadbackMismatch);
        }
        let readback: EncryptedVaultSlotV1 =
            serde_json::from_str(readback_json).map_err(|_| BridgeError::Serialization)?;
        if readback != pending.slot {
            return Err(BridgeError::ReadbackMismatch);
        }
        vault.verify_next_slot(&readback)?;
        pending.slot_verified = true;
        Ok(())
    }

    /// Commits the generation after the active pointer has been written and read back.
    ///
    /// # Errors
    ///
    /// Returns an error unless the slot was verified and the exact prepared
    /// pointer was read back.
    pub fn commit_pending_save(&mut self, readback_json: &str) -> Result<(), BridgeError> {
        let pending = self.pending.as_ref().ok_or(BridgeError::NoSavePending)?;
        if !pending.slot_verified {
            return Err(BridgeError::PendingSlotNotVerified);
        }
        if readback_json != pending.active_pointer_json {
            return Err(BridgeError::ReadbackMismatch);
        }
        let readback: ActiveSlotV1 =
            serde_json::from_str(readback_json).map_err(|_| BridgeError::Serialization)?;
        if readback != pending.active_pointer {
            return Err(BridgeError::ReadbackMismatch);
        }

        let slot = pending.slot.clone();
        self.vault_mut()?.commit_verified_slot(&slot)?;
        self.pending = None;
        Ok(())
    }

    /// Abandons a failed storage attempt without changing the committed generation.
    pub fn cancel_pending_save(&mut self) {
        self.pending = None;
    }

    /// Drops decrypted state and zeroizes its protected buffers.
    pub fn lock(&mut self) {
        self.pending = None;
        self.vault = None;
    }

    fn ensure_mutable(&self) -> Result<(), BridgeError> {
        if self.pending.is_some() {
            return Err(BridgeError::SavePending);
        }
        if self.vault.is_none() {
            return Err(BridgeError::Locked);
        }
        Ok(())
    }

    fn vault_ref(&self) -> Result<&UnlockedVault, BridgeError> {
        self.vault.as_ref().ok_or(BridgeError::Locked)
    }

    fn vault_mut(&mut self) -> Result<&mut UnlockedVault, BridgeError> {
        self.vault.as_mut().ok_or(BridgeError::Locked)
    }
}

fn parse_entry_id(value: &str) -> Result<EntryId, BridgeError> {
    EntryId::from_base64url(value)
        .map_err(|_| VaultError::InvalidContainer("entry ID is invalid"))
        .map_err(BridgeError::from)
}

fn insert_optional(storage: &mut MemoryStorage, key: &str, value: Option<String>) {
    if let Some(value) = value {
        storage.insert_raw(key, value);
    }
}

const fn slot_key(slot: SlotId) -> &'static str {
    match slot {
        SlotId::A => SLOT_A_KEY,
        SlotId::B => SLOT_B_KEY,
    }
}

#[cfg(test)]
mod tests {
    use rand_chacha::ChaCha20Rng;
    use rand_core::SeedableRng;

    use super::*;

    const MASTER: &[u8] = b"follow the white rabbit home";

    fn rng(seed: u8) -> ChaCha20Rng {
        ChaCha20Rng::from_seed([seed; 32])
    }

    fn create(seed: u8) -> CreateBundle {
        let mut source = rng(seed);
        VaultBridge::create(MASTER, 100, &mut source).unwrap()
    }

    #[test]
    fn list_summaries_never_contain_secrets_or_descriptions() {
        let mut created = create(2);
        let mut source = rng(3);
        created
            .session
            .add_entry(
                "GitHub".to_owned(),
                "super-secret-value".to_owned(),
                Some("private-description".to_owned()),
                101,
                &mut source,
            )
            .unwrap();

        let list = created.session.list_entries_json().unwrap();
        assert!(list.contains("GitHub"));
        assert!(!list.contains("super-secret-value"));
        assert!(!list.contains("private-description"));
    }

    #[test]
    fn detail_payload_omits_secret_until_explicitly_requested() {
        let mut created = create(3);
        let mut source = rng(4);
        let id = created
            .session
            .add_entry(
                "Mail".to_owned(),
                "secret-only-on-demand".to_owned(),
                Some("Primary account".to_owned()),
                101,
                &mut source,
            )
            .unwrap();

        let details = created.session.get_entry_details_json(&id).unwrap();
        assert!(details.contains("Primary account"));
        assert!(!details.contains("secret-only-on-demand"));
        assert_eq!(
            created.session.get_entry_secret(&id).unwrap(),
            "secret-only-on-demand"
        );
    }

    #[test]
    fn two_phase_save_does_not_advance_before_verified_pointer() {
        let mut created = create(4);
        let mut source = rng(5);
        created
            .session
            .add_entry(
                "Mail".to_owned(),
                "secret".to_owned(),
                None,
                101,
                &mut source,
            )
            .unwrap();
        let bundle = created.session.prepare_save(&mut source).unwrap();

        assert_eq!(created.session.generation(), Some(0));
        assert!(
            created
                .session
                .commit_pending_save(&bundle.active_pointer_json)
                .is_err()
        );
        created
            .session
            .verify_pending_slot(&bundle.slot_json)
            .unwrap();
        assert_eq!(created.session.generation(), Some(0));
        created
            .session
            .commit_pending_save(&bundle.active_pointer_json)
            .unwrap();
        assert_eq!(created.session.generation(), Some(1));
        assert_eq!(created.session.persisted_slot(), Some(SlotId::B));
    }

    #[test]
    fn open_repairs_a_missing_pointer_in_the_returned_bundle() {
        let created = create(6);
        let snapshot = StorageSnapshot {
            metadata_json: Some(created.metadata_json),
            slot_a_json: Some(created.slot_json),
            slot_b_json: None,
            active_pointer_json: None,
        };
        let opened = VaultBridge::open(MASTER, snapshot).unwrap();

        assert!(opened.repaired_pointer_json.is_some());
        assert_eq!(opened.session.generation(), Some(0));
    }

    #[test]
    fn lock_removes_access_to_decrypted_entries() {
        let mut created = create(7);
        created.session.lock();
        assert!(created.session.is_locked());
        assert_eq!(
            created.session.list_entries_json().unwrap_err().code(),
            "locked"
        );
    }
}
