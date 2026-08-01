use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use hkdf::Hkdf;
use rand_core::TryCryptoRng;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::{
    error::VaultError,
    model::{
        AeadAlgorithm, EncodedBytes, EncryptedVaultSlotV1, FORMAT, FORMAT_VERSION, KdfParams,
        SlotId, VaultId, WrappedDekV1,
    },
};

const KEK_INFO: &[u8] = b"pocket-vault/local-kek/v1";
const WRAPPED_DEK_OBJECT: &[u8] = b"wrapped-dek";
const VAULT_SLOT_OBJECT: &[u8] = b"vault-slot";
const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 24;

pub(crate) fn random_array<const N: usize>(
    rng: &mut impl TryCryptoRng,
) -> Result<[u8; N], VaultError> {
    let mut output = [0_u8; N];
    rng.try_fill_bytes(&mut output)
        .map_err(|_| VaultError::RandomGenerationFailed)?;
    Ok(output)
}

pub(crate) fn derive_kek(
    master_password: &[u8],
    vault_id: VaultId,
    kdf: &KdfParams,
) -> Result<Zeroizing<[u8; KEY_BYTES]>, VaultError> {
    kdf.validate()?;

    let params = Params::new(
        kdf.memory_kib,
        kdf.iterations,
        kdf.parallelism,
        Some(KEY_BYTES),
    )
    .map_err(|_| VaultError::InvalidKdfParameters("parameters were rejected by Argon2"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut password_key = Zeroizing::new([0_u8; KEY_BYTES]);
    argon2
        .hash_password_into(master_password, kdf.salt.as_slice(), password_key.as_mut())
        .map_err(|_| VaultError::KeyDerivationFailed)?;

    let hkdf = Hkdf::<Sha256>::new(Some(vault_id.as_bytes()), password_key.as_ref());
    let mut kek = Zeroizing::new([0_u8; KEY_BYTES]);
    hkdf.expand(KEK_INFO, kek.as_mut())
        .map_err(|_| VaultError::KeyDerivationFailed)?;
    Ok(kek)
}

pub(crate) fn wrap_dek(
    kek: &[u8; KEY_BYTES],
    dek: &[u8; KEY_BYTES],
    vault_id: VaultId,
    rng: &mut impl TryCryptoRng,
) -> Result<WrappedDekV1, VaultError> {
    let nonce = random_array::<NONCE_BYTES>(rng)?;
    let aad = wrapped_dek_aad(vault_id);
    let ciphertext = encrypt(kek, &nonce, dek, &aad)?;
    Ok(WrappedDekV1 {
        algorithm: AeadAlgorithm::XChaCha20Poly1305,
        nonce: EncodedBytes::new(nonce.to_vec()),
        ciphertext: EncodedBytes::new(ciphertext),
    })
}

pub(crate) fn unwrap_dek(
    kek: &[u8; KEY_BYTES],
    wrapped: &WrappedDekV1,
    vault_id: VaultId,
) -> Result<Zeroizing<[u8; KEY_BYTES]>, VaultError> {
    let nonce: [u8; NONCE_BYTES] = wrapped
        .nonce
        .as_slice()
        .try_into()
        .map_err(|_| VaultError::InvalidMetadata("wrapped DEK nonce must be 24 bytes"))?;
    let aad = wrapped_dek_aad(vault_id);
    let plaintext = Zeroizing::new(decrypt(kek, &nonce, wrapped.ciphertext.as_slice(), &aad)?);
    if plaintext.len() != KEY_BYTES {
        return Err(VaultError::WrongPasswordOrCorruptedVault);
    }

    let mut dek = Zeroizing::new([0_u8; KEY_BYTES]);
    dek.copy_from_slice(&plaintext);
    Ok(dek)
}

pub(crate) fn encrypt_slot_payload(
    dek: &[u8; KEY_BYTES],
    vault_id: VaultId,
    slot: SlotId,
    generation: u64,
    plaintext: &[u8],
    rng: &mut impl TryCryptoRng,
) -> Result<EncryptedVaultSlotV1, VaultError> {
    let nonce = random_array::<NONCE_BYTES>(rng)?;
    let aad = vault_slot_aad(vault_id, slot, generation);
    let ciphertext = encrypt(dek, &nonce, plaintext, &aad)?;
    Ok(EncryptedVaultSlotV1 {
        format: FORMAT.to_owned(),
        version: FORMAT_VERSION,
        vault_id,
        slot,
        generation,
        algorithm: AeadAlgorithm::XChaCha20Poly1305,
        nonce: EncodedBytes::new(nonce.to_vec()),
        ciphertext: EncodedBytes::new(ciphertext),
    })
}

pub(crate) fn decrypt_slot_payload(
    dek: &[u8; KEY_BYTES],
    slot: &EncryptedVaultSlotV1,
) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    let nonce: [u8; NONCE_BYTES] = slot
        .nonce
        .as_slice()
        .try_into()
        .map_err(|_| VaultError::InvalidSlot("nonce must be 24 bytes"))?;
    let aad = vault_slot_aad(slot.vault_id, slot.slot, slot.generation);
    decrypt(dek, &nonce, slot.ciphertext.as_slice(), &aad).map(Zeroizing::new)
}

fn encrypt(
    key: &[u8; KEY_BYTES],
    nonce: &[u8; NONCE_BYTES],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, VaultError> {
    let cipher =
        XChaCha20Poly1305::new_from_slice(key).map_err(|_| VaultError::EncryptionFailed)?;
    let nonce = XNonce::from(*nonce);
    cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| VaultError::EncryptionFailed)
}

fn decrypt(
    key: &[u8; KEY_BYTES],
    nonce: &[u8; NONCE_BYTES],
    ciphertext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, VaultError> {
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| VaultError::WrongPasswordOrCorruptedVault)?;
    let nonce = XNonce::from(*nonce);
    cipher
        .decrypt(
            &nonce,
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| VaultError::WrongPasswordOrCorruptedVault)
}

fn wrapped_dek_aad(vault_id: VaultId) -> Vec<u8> {
    let mut aad = Vec::with_capacity(64);
    push_aad_field(&mut aad, FORMAT.as_bytes());
    push_aad_field(&mut aad, WRAPPED_DEK_OBJECT);
    push_aad_field(&mut aad, &FORMAT_VERSION.to_be_bytes());
    push_aad_field(&mut aad, vault_id.as_bytes());
    aad
}

fn vault_slot_aad(vault_id: VaultId, slot: SlotId, generation: u64) -> Vec<u8> {
    let mut aad = Vec::with_capacity(80);
    push_aad_field(&mut aad, FORMAT.as_bytes());
    push_aad_field(&mut aad, VAULT_SLOT_OBJECT);
    push_aad_field(&mut aad, &FORMAT_VERSION.to_be_bytes());
    push_aad_field(&mut aad, vault_id.as_bytes());
    push_aad_field(&mut aad, &[slot.aad_byte()]);
    push_aad_field(&mut aad, &generation.to_be_bytes());
    aad
}

fn push_aad_field(output: &mut Vec<u8>, value: &[u8]) {
    let length = u32::try_from(value.len()).expect("AAD fields are statically bounded");
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(value);
}

#[cfg(test)]
mod tests {
    use super::*;
    use argon2::{AssociatedData, ParamsBuilder};

    #[test]
    fn aad_is_unambiguous_and_binds_slot_fields() {
        let vault_id = VaultId::from_bytes([7_u8; 16]);
        assert_ne!(
            vault_slot_aad(vault_id, SlotId::A, 1),
            vault_slot_aad(vault_id, SlotId::B, 1)
        );
        assert_ne!(
            vault_slot_aad(vault_id, SlotId::A, 1),
            vault_slot_aad(vault_id, SlotId::A, 2)
        );
        assert_ne!(
            wrapped_dek_aad(vault_id),
            vault_slot_aad(vault_id, SlotId::A, 1)
        );
    }

    /// RFC 9106, section 5.3: Argon2id version 19 test vector.
    #[test]
    fn argon2id_matches_rfc_9106_vector() {
        let params = ParamsBuilder::new()
            .m_cost(32)
            .t_cost(3)
            .p_cost(4)
            .data(AssociatedData::new(&[0x04; 12]).unwrap())
            .build()
            .unwrap();
        let argon2 =
            Argon2::new_with_secret(&[0x03; 8], Algorithm::Argon2id, Version::V0x13, params)
                .unwrap();
        let mut actual = [0_u8; 32];
        argon2
            .hash_password_into(&[0x01; 32], &[0x02; 16], &mut actual)
            .unwrap();

        let expected = [
            0x0d, 0x64, 0x0d, 0xf5, 0x8d, 0x78, 0x76, 0x6c, 0x08, 0xc0, 0x37, 0xa3, 0x4a, 0x8b,
            0x53, 0xc9, 0xd0, 0x1e, 0xf0, 0x45, 0x2d, 0x75, 0xb6, 0x5e, 0xb5, 0x25, 0x20, 0xe9,
            0x6b, 0x01, 0xe6, 0x59,
        ];
        assert_eq!(actual, expected);
    }

    /// RFC 5869, appendix A.1: HKDF-SHA-256 basic test vector.
    #[test]
    fn hkdf_sha256_matches_rfc_5869_vector() {
        let input_key_material = [0x0b; 22];
        let salt = [
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
        ];
        let info = [0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9];
        let expected = [
            0x3c, 0xb2, 0x5f, 0x25, 0xfa, 0xac, 0xd5, 0x7a, 0x90, 0x43, 0x4f, 0x64, 0xd0, 0x36,
            0x2f, 0x2a, 0x2d, 0x2d, 0x0a, 0x90, 0xcf, 0x1a, 0x5a, 0x4c, 0x5d, 0xb0, 0x2d, 0x56,
            0xec, 0xc4, 0xc5, 0xbf, 0x34, 0x00, 0x72, 0x08, 0xd5, 0xb8, 0x87, 0x18, 0x58, 0x65,
        ];

        let hkdf = Hkdf::<Sha256>::new(Some(&salt), &input_key_material);
        let mut actual = [0_u8; 42];
        hkdf.expand(&info, &mut actual).unwrap();
        assert_eq!(actual, expected);
    }
}
