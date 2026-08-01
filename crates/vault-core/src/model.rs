use std::{collections::HashSet, fmt};

use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use zeroize::Zeroize;

use crate::{
    encoding::{decode_base64url, decode_base64url_array, encode_base64url},
    error::VaultError,
};

pub const FORMAT: &str = "pocket-vault";
pub const FORMAT_VERSION: u32 = 1;
pub const DEVICE_STORAGE_LIMIT_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_METADATA_JSON_BYTES: usize = 16 * 1024;
pub const MAX_SLOT_JSON_BYTES: usize = DEVICE_STORAGE_LIMIT_BYTES;
pub const MAX_ENTRIES: usize = 10_000;
pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_SECRET_BYTES: usize = 4096;
pub const MAX_DESCRIPTION_CHARS: usize = 2000;

macro_rules! fixed_base64_type {
    ($name:ident, $length:expr) => {
        #[derive(Clone, Copy, Eq, Hash, PartialEq)]
        pub struct $name([u8; $length]);

        impl $name {
            #[must_use]
            pub const fn from_bytes(bytes: [u8; $length]) -> Self {
                Self(bytes)
            }

            #[must_use]
            pub const fn as_bytes(&self) -> &[u8; $length] {
                &self.0
            }

            /// Encodes the identifier as unpadded `Base64URL`.
            #[must_use]
            pub fn to_base64url(self) -> String {
                encode_base64url(&self.0)
            }

            /// Parses an identifier from unpadded `Base64URL`.
            ///
            /// # Errors
            ///
            /// Returns an error for padding, invalid alphabet, or a decoded
            /// value of another length.
            pub fn from_base64url(value: &str) -> Result<Self, String> {
                decode_base64url_array::<$length>(value).map(Self)
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter
                    .debug_tuple(stringify!($name))
                    .field(&encode_base64url(&self.0))
                    .finish()
            }
        }

        impl Serialize for $name {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: Serializer,
            {
                serializer.serialize_str(&encode_base64url(&self.0))
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                decode_base64url_array::<$length>(&value)
                    .map(Self)
                    .map_err(D::Error::custom)
            }
        }
    };
}

fixed_base64_type!(VaultId, 16);
fixed_base64_type!(EntryId, 16);

/// Binary data encoded as unpadded `Base64URL` in persistent JSON.
#[derive(Clone, Default, Eq, PartialEq)]
pub struct EncodedBytes(Vec<u8>);

impl EncodedBytes {
    #[must_use]
    pub fn new(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for EncodedBytes {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EncodedBytes")
            .field("decoded_len", &self.0.len())
            .finish_non_exhaustive()
    }
}

impl Serialize for EncodedBytes {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&encode_base64url(&self.0))
    }
}

impl<'de> Deserialize<'de> for EncodedBytes {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        decode_base64url(&value).map(Self).map_err(D::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum KdfAlgorithm {
    #[serde(rename = "argon2id")]
    Argon2id,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum AeadAlgorithm {
    #[serde(rename = "xchacha20-poly1305")]
    XChaCha20Poly1305,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SlotId {
    A,
    B,
}

impl SlotId {
    #[must_use]
    pub const fn other(self) -> Self {
        match self {
            Self::A => Self::B,
            Self::B => Self::A,
        }
    }

    #[must_use]
    pub const fn aad_byte(self) -> u8 {
        match self {
            Self::A => b'a',
            Self::B => b'b',
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KdfParams {
    pub algorithm: KdfAlgorithm,
    pub salt: EncodedBytes,
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub output_bytes: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct KdfConfig {
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

impl Default for KdfConfig {
    fn default() -> Self {
        Self {
            memory_kib: KdfParams::RECOMMENDED_MEMORY_KIB,
            iterations: KdfParams::RECOMMENDED_ITERATIONS,
            parallelism: KdfParams::RECOMMENDED_PARALLELISM,
        }
    }
}

impl KdfParams {
    pub const RECOMMENDED_MEMORY_KIB: u32 = 65_536;
    pub const RECOMMENDED_ITERATIONS: u32 = 3;
    pub const RECOMMENDED_PARALLELISM: u32 = 1;
    pub const OUTPUT_BYTES: u32 = 32;

    #[must_use]
    pub fn recommended(salt: [u8; 16]) -> Self {
        Self::from_config(salt, KdfConfig::default())
    }

    #[must_use]
    pub fn from_config(salt: [u8; 16], config: KdfConfig) -> Self {
        Self {
            algorithm: KdfAlgorithm::Argon2id,
            salt: EncodedBytes::new(salt.to_vec()),
            memory_kib: config.memory_kib,
            iterations: config.iterations,
            parallelism: config.parallelism,
            output_bytes: Self::OUTPUT_BYTES,
        }
    }

    /// Checks that serialized KDF parameters stay within defensive limits.
    ///
    /// # Errors
    ///
    /// Returns [`VaultError::InvalidKdfParameters`] for unsupported or
    /// resource-exhausting values.
    pub fn validate(&self) -> Result<(), VaultError> {
        if !(32_768..=262_144).contains(&self.memory_kib) {
            return Err(VaultError::InvalidKdfParameters(
                "memoryKiB is out of bounds",
            ));
        }
        if !(1..=10).contains(&self.iterations) {
            return Err(VaultError::InvalidKdfParameters(
                "iterations is out of bounds",
            ));
        }
        if !(1..=4).contains(&self.parallelism) {
            return Err(VaultError::InvalidKdfParameters(
                "parallelism is out of bounds",
            ));
        }
        if !(16..=64).contains(&self.salt.len()) {
            return Err(VaultError::InvalidKdfParameters(
                "salt length is out of bounds",
            ));
        }
        if self.output_bytes != Self::OUTPUT_BYTES {
            return Err(VaultError::InvalidKdfParameters(
                "output length must be 32 bytes",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WrappedDekV1 {
    pub algorithm: AeadAlgorithm,
    pub nonce: EncodedBytes,
    pub ciphertext: EncodedBytes,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultMetaV1 {
    pub format: String,
    pub version: u32,
    pub vault_id: VaultId,
    pub created_at: u64,
    pub kdf: KdfParams,
    pub wrapped_dek: WrappedDekV1,
}

impl VaultMetaV1 {
    /// Validates the metadata format, KDF bounds, nonce, and wrapped-key sizes.
    ///
    /// # Errors
    ///
    /// Returns a format, version, metadata, or KDF error when validation fails.
    pub fn validate(&self) -> Result<(), VaultError> {
        validate_format(&self.format, self.version).map_err(|error| match error {
            VaultError::UnsupportedFormatVersion => error,
            _ => VaultError::InvalidMetadata("unexpected format name"),
        })?;
        self.kdf.validate()?;
        if self.wrapped_dek.nonce.len() != 24 {
            return Err(VaultError::InvalidMetadata(
                "wrapped DEK nonce must be 24 bytes",
            ));
        }
        if self.wrapped_dek.ciphertext.len() != 48 {
            return Err(VaultError::InvalidMetadata(
                "wrapped DEK ciphertext must be 48 bytes",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EncryptedVaultSlotV1 {
    pub format: String,
    pub version: u32,
    pub vault_id: VaultId,
    pub slot: SlotId,
    pub generation: u64,
    pub algorithm: AeadAlgorithm,
    pub nonce: EncodedBytes,
    pub ciphertext: EncodedBytes,
}

impl EncryptedVaultSlotV1 {
    /// Validates the slot envelope before attempting authenticated decryption.
    ///
    /// # Errors
    ///
    /// Returns a format, version, or slot error when validation fails.
    pub fn validate(&self, expected_vault_id: VaultId) -> Result<(), VaultError> {
        validate_format(&self.format, self.version).map_err(|error| match error {
            VaultError::UnsupportedFormatVersion => error,
            _ => VaultError::InvalidSlot("unexpected format name"),
        })?;
        if self.vault_id != expected_vault_id {
            return Err(VaultError::InvalidSlot("vaultId does not match metadata"));
        }
        if self.nonce.len() != 24 {
            return Err(VaultError::InvalidSlot("nonce must be 24 bytes"));
        }
        if !(16..=DEVICE_STORAGE_LIMIT_BYTES).contains(&self.ciphertext.len()) {
            return Err(VaultError::InvalidSlot(
                "ciphertext length is out of bounds",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActiveSlotV1 {
    pub version: u32,
    pub slot: SlotId,
    pub generation: u64,
}

impl ActiveSlotV1 {
    /// Validates the active-slot pointer version.
    ///
    /// # Errors
    ///
    /// Returns [`VaultError::UnsupportedFormatVersion`] for another version.
    pub fn validate(&self) -> Result<(), VaultError> {
        if self.version != FORMAT_VERSION {
            return Err(VaultError::UnsupportedFormatVersion);
        }
        Ok(())
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultEntry {
    pub id: EntryId,
    pub title: String,
    pub secret: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

impl fmt::Debug for VaultEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VaultEntry")
            .field("id", &self.id)
            .field("title_chars", &self.title.chars().count())
            .field("secret", &"[REDACTED]")
            .field("has_description", &self.description.is_some())
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

impl Drop for VaultEntry {
    fn drop(&mut self) {
        self.title.zeroize();
        self.secret.zeroize();
        if let Some(description) = &mut self.description {
            description.zeroize();
        }
    }
}

impl VaultEntry {
    /// Validates field sizes and timestamp ordering.
    ///
    /// # Errors
    ///
    /// Returns [`VaultError::InvalidContainer`] when an invariant is violated.
    pub fn validate(&self) -> Result<(), VaultError> {
        validate_entry_fields(&self.title, &self.secret, self.description.as_deref())?;
        if self.updated_at < self.created_at {
            return Err(VaultError::InvalidContainer(
                "entry timestamps are inconsistent",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultContainerV1 {
    pub format: String,
    pub version: u32,
    pub vault_id: VaultId,
    pub generation: u64,
    pub created_at: u64,
    pub updated_at: u64,
    pub entries: Vec<VaultEntry>,
}

impl fmt::Debug for VaultContainerV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VaultContainerV1")
            .field("format", &self.format)
            .field("version", &self.version)
            .field("vault_id", &self.vault_id)
            .field("generation", &self.generation)
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .field("entry_count", &self.entries.len())
            .finish()
    }
}

impl VaultContainerV1 {
    /// Validates the decrypted container and every nested entry.
    ///
    /// # Errors
    ///
    /// Returns an error for an unsupported format, inconsistent identifiers or
    /// generations, invalid entries, duplicates, or an excessive entry count.
    pub fn validate(
        &self,
        expected_vault_id: VaultId,
        expected_generation: u64,
    ) -> Result<(), VaultError> {
        validate_format(&self.format, self.version).map_err(|error| match error {
            VaultError::UnsupportedFormatVersion => error,
            _ => VaultError::InvalidContainer("unexpected format name"),
        })?;
        if self.vault_id != expected_vault_id {
            return Err(VaultError::InvalidContainer("vaultId does not match slot"));
        }
        if self.generation != expected_generation {
            return Err(VaultError::InvalidContainer(
                "generation does not match slot",
            ));
        }
        if self.updated_at < self.created_at {
            return Err(VaultError::InvalidContainer(
                "container timestamps are inconsistent",
            ));
        }
        if self.entries.len() > MAX_ENTRIES {
            return Err(VaultError::VaultTooLarge);
        }

        let mut ids = HashSet::with_capacity(self.entries.len());
        for entry in &self.entries {
            entry.validate()?;
            if entry.created_at < self.created_at || entry.updated_at > self.updated_at {
                return Err(VaultError::InvalidContainer(
                    "entry timestamps are outside the container timeline",
                ));
            }
            if !ids.insert(entry.id) {
                return Err(VaultError::DuplicateEntry);
            }
        }
        Ok(())
    }
}

pub struct NewVaultEntry {
    pub title: String,
    pub secret: String,
    pub description: Option<String>,
}

impl Drop for NewVaultEntry {
    fn drop(&mut self) {
        self.title.zeroize();
        self.secret.zeroize();
        if let Some(description) = &mut self.description {
            description.zeroize();
        }
    }
}

pub struct UpdateVaultEntry {
    pub id: EntryId,
    pub title: String,
    pub secret: String,
    pub description: Option<String>,
}

impl Drop for UpdateVaultEntry {
    fn drop(&mut self) {
        self.title.zeroize();
        self.secret.zeroize();
        if let Some(description) = &mut self.description {
            description.zeroize();
        }
    }
}

pub(crate) fn validate_entry_fields(
    title: &str,
    secret: &str,
    description: Option<&str>,
) -> Result<(), VaultError> {
    if !(1..=MAX_TITLE_CHARS).contains(&title.chars().count()) {
        return Err(VaultError::InvalidContainer(
            "title length is out of bounds",
        ));
    }
    if !(1..=MAX_SECRET_BYTES).contains(&secret.len()) {
        return Err(VaultError::InvalidContainer(
            "secret length is out of bounds",
        ));
    }
    if description.is_some_and(|value| value.chars().count() > MAX_DESCRIPTION_CHARS) {
        return Err(VaultError::InvalidContainer(
            "description length is out of bounds",
        ));
    }
    Ok(())
}

fn validate_format(format: &str, version: u32) -> Result<(), VaultError> {
    if format != FORMAT {
        return Err(VaultError::InvalidContainer("unexpected format name"));
    }
    if version != FORMAT_VERSION {
        return Err(VaultError::UnsupportedFormatVersion);
    }
    Ok(())
}
