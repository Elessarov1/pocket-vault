use thiserror::Error;

/// Failures produced by an untrusted persistent storage adapter.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum StorageError {
    #[error("storage read failed")]
    ReadFailed,
    #[error("storage write failed")]
    WriteFailed,
    #[error("storage removal failed")]
    RemoveFailed,
}

/// Typed failures from the Pocket Vault core.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum VaultError {
    #[error("invalid metadata: {0}")]
    InvalidMetadata(&'static str),
    #[error("invalid encrypted slot: {0}")]
    InvalidSlot(&'static str),
    #[error("invalid vault container: {0}")]
    InvalidContainer(&'static str),
    #[error("unsupported format version")]
    UnsupportedFormatVersion,
    #[error("invalid KDF parameters: {0}")]
    InvalidKdfParameters(&'static str),
    #[error("invalid master password: {0}")]
    InvalidMasterPassword(&'static str),
    #[error("key derivation failed")]
    KeyDerivationFailed,
    #[error("encryption failed")]
    EncryptionFailed,
    #[error("decryption or authentication failed")]
    WrongPasswordOrCorruptedVault,
    #[error("random generation failed")]
    RandomGenerationFailed,
    #[error("serialization failed")]
    SerializationFailed,
    #[error("vault entry was not found")]
    EntryNotFound,
    #[error("vault entry already exists")]
    DuplicateEntry,
    #[error("vault is too large")]
    VaultTooLarge,
    #[error("generation counter overflow")]
    GenerationOverflow,
    #[error("slot verification failed")]
    SlotVerificationFailed,
    #[error("vault has not been initialized")]
    Uninitialized,
    #[error("vault has already been initialized")]
    AlreadyInitialized,
    #[error("storage operation failed: {0}")]
    Storage(#[from] StorageError),
}
