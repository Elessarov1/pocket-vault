use rand_chacha::ChaCha20Rng;
use rand_core::{SeedableRng, TryCryptoRng, TryRng};
use serde_json::Value;
use vault_core::{
    KdfConfig, NewVaultEntry, SlotId, UpdateVaultEntry, VaultError, VaultMetaV1, create_vault,
    unlock_vault,
};

const PASSWORD: &[u8] = b"correct horse battery staple";
const DEVICE_SECRET: [u8; 32] = [0x42; 32];

fn test_config() -> KdfConfig {
    KdfConfig {
        memory_kib: 32_768,
        iterations: 1,
        parallelism: 1,
    }
}

fn rng(seed: u8) -> ChaCha20Rng {
    ChaCha20Rng::from_seed([seed; 32])
}

#[derive(Debug)]
struct FailingRandom;

impl std::fmt::Display for FailingRandom {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("random source failed")
    }
}

impl std::error::Error for FailingRandom {}

impl TryRng for FailingRandom {
    type Error = Self;

    fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
        Err(Self)
    }

    fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
        Err(Self)
    }

    fn try_fill_bytes(&mut self, _dst: &mut [u8]) -> Result<(), Self::Error> {
        Err(Self)
    }
}

impl TryCryptoRng for FailingRandom {}

fn tamper_base64_field(value: &mut Value, path: &[&str]) {
    let mut current = value;
    for key in &path[..path.len() - 1] {
        current = &mut current[*key];
    }
    let field = current[path[path.len() - 1]].as_str().unwrap();
    let replacement = if field.starts_with('A') { 'B' } else { 'A' };
    let mut tampered = field.to_owned();
    tampered.replace_range(..1, &replacement.to_string());
    current[path[path.len() - 1]] = Value::String(tampered);
}

#[test]
fn create_and_unlock_empty_vault_roundtrip() {
    let mut source = rng(1);
    let created = create_vault(
        PASSWORD,
        &DEVICE_SECRET,
        test_config(),
        1_785_450_000,
        &mut source,
    )
    .unwrap();

    assert!(created.unlocked.entries().is_empty());
    assert_eq!(created.unlocked.generation(), 0);
    assert_eq!(created.initial_slot.slot, SlotId::A);

    let unlocked = unlock_vault(
        PASSWORD,
        &DEVICE_SECRET,
        &created.metadata,
        &created.initial_slot,
    )
    .unwrap();
    assert!(unlocked.entries().is_empty());
    assert_eq!(unlocked.vault_id(), created.metadata.vault_id);

    let metadata_json = serde_json::to_string(&created.metadata).unwrap();
    assert!(metadata_json.contains("\"algorithm\":\"argon2id\""));
    assert!(metadata_json.contains("\"algorithm\":\"xchacha20-poly1305\""));
}

#[test]
fn wrong_password_and_wrong_device_secret_are_rejected() {
    let mut source = rng(2);
    let created = create_vault(PASSWORD, &DEVICE_SECRET, test_config(), 10, &mut source).unwrap();

    assert_eq!(
        unlock_vault(
            b"incorrect master password",
            &DEVICE_SECRET,
            &created.metadata,
            &created.initial_slot,
        )
        .unwrap_err(),
        VaultError::WrongPasswordOrCorruptedVault
    );
    assert_eq!(
        unlock_vault(
            PASSWORD,
            &[0x24; 32],
            &created.metadata,
            &created.initial_slot,
        )
        .unwrap_err(),
        VaultError::WrongPasswordOrCorruptedVault
    );
}

#[test]
fn wrapped_dek_nonce_and_ciphertext_tampering_are_rejected() {
    let mut source = rng(3);
    let created = create_vault(PASSWORD, &DEVICE_SECRET, test_config(), 10, &mut source).unwrap();

    for field in ["nonce", "ciphertext"] {
        let mut value = serde_json::to_value(&created.metadata).unwrap();
        tamper_base64_field(&mut value, &["wrappedDek", field]);
        let metadata = serde_json::from_value(value).unwrap();
        assert!(unlock_vault(PASSWORD, &DEVICE_SECRET, &metadata, &created.initial_slot,).is_err());
    }
}

#[test]
fn slot_ciphertext_nonce_and_aad_tampering_are_rejected() {
    let mut source = rng(4);
    let created = create_vault(PASSWORD, &DEVICE_SECRET, test_config(), 10, &mut source).unwrap();

    for field in ["nonce", "ciphertext"] {
        let mut value = serde_json::to_value(&created.initial_slot).unwrap();
        tamper_base64_field(&mut value, &[field]);
        let slot = serde_json::from_value(value).unwrap();
        assert!(unlock_vault(PASSWORD, &DEVICE_SECRET, &created.metadata, &slot).is_err());
    }

    let mut generation_tampered = created.initial_slot.clone();
    generation_tampered.generation = 1;
    assert!(
        unlock_vault(
            PASSWORD,
            &DEVICE_SECRET,
            &created.metadata,
            &generation_tampered,
        )
        .is_err()
    );

    let mut slot_id_tampered = created.initial_slot.clone();
    slot_id_tampered.slot = SlotId::B;
    assert!(
        unlock_vault(
            PASSWORD,
            &DEVICE_SECRET,
            &created.metadata,
            &slot_id_tampered,
        )
        .is_err()
    );
}

#[test]
fn kdf_memory_field_uses_documented_name() {
    let mut source = rng(11);
    let created = create_vault(
        PASSWORD,
        &DEVICE_SECRET,
        test_config(),
        1_785_450_000,
        &mut source,
    )
    .unwrap();
    let json = serde_json::to_string(&created.metadata).unwrap();
    assert!(json.contains("\"memoryKiB\":32768"));
    assert!(!json.contains("\"memoryKib\""));
}

#[test]
fn crud_and_generation_roundtrip() {
    let mut source = rng(5);
    let mut created =
        create_vault(PASSWORD, &DEVICE_SECRET, test_config(), 100, &mut source).unwrap();

    let id = created
        .unlocked
        .add_entry(
            NewVaultEntry {
                title: "Личная почта".to_owned(),
                secret: "example-password".to_owned(),
                description: Some("Основной аккаунт".to_owned()),
            },
            110,
            &mut source,
        )
        .unwrap();
    created
        .unlocked
        .update_entry(
            UpdateVaultEntry {
                id,
                title: "Рабочая почта".to_owned(),
                secret: "updated-password".to_owned(),
                description: None,
            },
            120,
        )
        .unwrap();

    let slot_b = created
        .unlocked
        .encrypt_for_slot(SlotId::B, &mut source)
        .unwrap();
    assert_eq!(slot_b.generation, 1);
    let unlocked = unlock_vault(PASSWORD, &DEVICE_SECRET, &created.metadata, &slot_b).unwrap();
    assert_eq!(unlocked.entries().len(), 1);
    assert_eq!(unlocked.entries()[0].title, "Рабочая почта");
    assert_eq!(unlocked.entries()[0].secret, "updated-password");

    created.unlocked.delete_entry(id, 130).unwrap();
    assert!(created.unlocked.entries().is_empty());
}

#[test]
fn kdf_bounds_are_checked_before_derivation() {
    let mut source = rng(6);
    let result = create_vault(
        PASSWORD,
        &DEVICE_SECRET,
        KdfConfig {
            memory_kib: 1,
            iterations: 1,
            parallelism: 1,
        },
        0,
        &mut source,
    );
    assert!(matches!(result, Err(VaultError::InvalidKdfParameters(_))));

    let created = create_vault(PASSWORD, &DEVICE_SECRET, test_config(), 0, &mut source).unwrap();
    let mut metadata = created.metadata.clone();
    metadata.kdf.memory_kib = u32::MAX;
    assert!(matches!(
        unlock_vault(PASSWORD, &DEVICE_SECRET, &metadata, &created.initial_slot,),
        Err(VaultError::InvalidKdfParameters(_))
    ));
}

#[test]
fn future_versions_and_invalid_entry_sizes_are_rejected() {
    let mut source = rng(7);
    let mut created =
        create_vault(PASSWORD, &DEVICE_SECRET, test_config(), 0, &mut source).unwrap();
    let mut metadata = created.metadata.clone();
    metadata.version = 2;
    assert_eq!(
        unlock_vault(PASSWORD, &DEVICE_SECRET, &metadata, &created.initial_slot,).unwrap_err(),
        VaultError::UnsupportedFormatVersion
    );

    let result = created.unlocked.add_entry(
        NewVaultEntry {
            title: String::new(),
            secret: "secret".to_owned(),
            description: None,
        },
        1,
        &mut source,
    );
    assert!(matches!(result, Err(VaultError::InvalidContainer(_))));

    let result = created.unlocked.add_entry(
        NewVaultEntry {
            title: "title".to_owned(),
            secret: "x".repeat(4097),
            description: None,
        },
        1,
        &mut source,
    );
    assert!(matches!(result, Err(VaultError::InvalidContainer(_))));
}

#[test]
fn new_vault_requires_a_unicode_master_phrase_of_at_least_16_characters() {
    let mut source = rng(9);
    assert!(matches!(
        create_vault(
            "короткая фраза".as_bytes(),
            &DEVICE_SECRET,
            test_config(),
            0,
            &mut source,
        ),
        Err(VaultError::InvalidMasterPassword(_))
    ));
    assert!(matches!(
        create_vault(&[0xff; 16], &DEVICE_SECRET, test_config(), 0, &mut source,),
        Err(VaultError::InvalidMasterPassword(_))
    ));
}

#[test]
fn persistent_models_reject_unknown_fields_and_metadata_timestamp_tampering() {
    let mut source = rng(8);
    let created = create_vault(PASSWORD, &DEVICE_SECRET, test_config(), 42, &mut source).unwrap();

    let mut unknown_field = serde_json::to_value(&created.metadata).unwrap();
    unknown_field["unexpected"] = Value::Bool(true);
    assert!(serde_json::from_value::<VaultMetaV1>(unknown_field).is_err());

    let mut tampered_metadata = created.metadata.clone();
    tampered_metadata.created_at += 1;
    assert!(matches!(
        unlock_vault(
            PASSWORD,
            &DEVICE_SECRET,
            &tampered_metadata,
            &created.initial_slot,
        ),
        Err(VaultError::InvalidMetadata(_))
    ));
}

#[test]
fn random_source_failure_is_reported_without_panicking() {
    assert!(matches!(
        create_vault(
            PASSWORD,
            &DEVICE_SECRET,
            test_config(),
            0,
            &mut FailingRandom,
        ),
        Err(VaultError::RandomGenerationFailed)
    ));
}
