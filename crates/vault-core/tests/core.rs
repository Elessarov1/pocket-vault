use rand_chacha::ChaCha20Rng;
use rand_core::{SeedableRng, TryCryptoRng, TryRng};
use serde_json::Value;
use vault_core::{
    KdfConfig, NewVaultEntry, SlotId, UpdateVaultEntry, VaultError, VaultMetaV1, create_vault,
    rewrap_vault_key, unlock_vault,
};

const PASSWORD: &[u8] = b"correct horse battery staple";

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

#[test]
fn default_kdf_profile_matches_mobile_recommendation() {
    let config = KdfConfig::default();
    assert_eq!(config.memory_kib, 19_456);
    assert_eq!(config.iterations, 2);
    assert_eq!(config.parallelism, 1);
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
    let created = create_vault(PASSWORD, test_config(), 1_785_450_000, &mut source).unwrap();

    assert!(created.unlocked.entries().is_empty());
    assert_eq!(created.unlocked.generation(), 0);
    assert_eq!(created.initial_slot.slot, SlotId::A);

    let unlocked = unlock_vault(PASSWORD, &created.metadata, &created.initial_slot).unwrap();
    assert!(unlocked.entries().is_empty());
    assert_eq!(unlocked.vault_id(), created.metadata.vault_id);

    let metadata_json = serde_json::to_string(&created.metadata).unwrap();
    assert!(metadata_json.contains("\"algorithm\":\"argon2id\""));
    assert!(metadata_json.contains("\"algorithm\":\"xchacha20-poly1305\""));
}

#[test]
fn wrong_password_is_rejected() {
    let mut source = rng(2);
    let created = create_vault(PASSWORD, test_config(), 10, &mut source).unwrap();

    assert_eq!(
        unlock_vault(
            b"incorrect master password",
            &created.metadata,
            &created.initial_slot,
        )
        .unwrap_err(),
        VaultError::WrongPasswordOrCorruptedVault
    );
}

#[test]
fn master_password_change_rewraps_the_same_vault_key() {
    const NEW_PASSWORD: &[u8] = b"a different long master phrase";
    let mut source = rng(12);
    let mut created = create_vault(PASSWORD, test_config(), 42, &mut source).unwrap();
    created
        .unlocked
        .add_entry(
            NewVaultEntry {
                title: "Mail".to_owned(),
                secret: "unchanged-secret".to_owned(),
                description: None,
            },
            43,
            &mut source,
        )
        .unwrap();
    let slot = created
        .unlocked
        .encrypt_for_slot(SlotId::B, &mut source)
        .unwrap();

    let changed = rewrap_vault_key(
        PASSWORD,
        NEW_PASSWORD,
        &created.metadata,
        &created.unlocked,
        test_config(),
        &mut source,
    )
    .unwrap();

    assert_eq!(changed.vault_id, created.metadata.vault_id);
    assert_eq!(changed.created_at, created.metadata.created_at);
    assert_ne!(changed.kdf.salt, created.metadata.kdf.salt);
    assert!(unlock_vault(PASSWORD, &changed, &slot).is_err());
    let reopened = unlock_vault(NEW_PASSWORD, &changed, &slot).unwrap();
    assert_eq!(reopened.entries()[0].secret, "unchanged-secret");
}

#[test]
fn master_password_change_rejects_wrong_current_and_short_new_passwords() {
    let mut source = rng(13);
    let created = create_vault(PASSWORD, test_config(), 42, &mut source).unwrap();

    assert_eq!(
        rewrap_vault_key(
            b"wrong but sufficiently long password",
            b"a different long master phrase",
            &created.metadata,
            &created.unlocked,
            test_config(),
            &mut source,
        )
        .unwrap_err(),
        VaultError::WrongPasswordOrCorruptedVault
    );
    assert!(matches!(
        rewrap_vault_key(
            PASSWORD,
            b"too short",
            &created.metadata,
            &created.unlocked,
            test_config(),
            &mut source,
        ),
        Err(VaultError::InvalidMasterPassword(_))
    ));
}

#[test]
fn wrapped_dek_nonce_and_ciphertext_tampering_are_rejected() {
    let mut source = rng(3);
    let created = create_vault(PASSWORD, test_config(), 10, &mut source).unwrap();

    for field in ["nonce", "ciphertext"] {
        let mut value = serde_json::to_value(&created.metadata).unwrap();
        tamper_base64_field(&mut value, &["wrappedDek", field]);
        let metadata = serde_json::from_value(value).unwrap();
        assert!(unlock_vault(PASSWORD, &metadata, &created.initial_slot).is_err());
    }
}

#[test]
fn slot_ciphertext_nonce_and_aad_tampering_are_rejected() {
    let mut source = rng(4);
    let created = create_vault(PASSWORD, test_config(), 10, &mut source).unwrap();

    for field in ["nonce", "ciphertext"] {
        let mut value = serde_json::to_value(&created.initial_slot).unwrap();
        tamper_base64_field(&mut value, &[field]);
        let slot = serde_json::from_value(value).unwrap();
        assert!(unlock_vault(PASSWORD, &created.metadata, &slot).is_err());
    }

    let mut generation_tampered = created.initial_slot.clone();
    generation_tampered.generation = 1;
    assert!(unlock_vault(PASSWORD, &created.metadata, &generation_tampered,).is_err());

    let mut slot_id_tampered = created.initial_slot.clone();
    slot_id_tampered.slot = SlotId::B;
    assert!(unlock_vault(PASSWORD, &created.metadata, &slot_id_tampered,).is_err());
}

#[test]
fn kdf_memory_field_uses_documented_name() {
    let mut source = rng(11);
    let created = create_vault(PASSWORD, test_config(), 1_785_450_000, &mut source).unwrap();
    let json = serde_json::to_string(&created.metadata).unwrap();
    assert!(json.contains("\"memoryKiB\":32768"));
    assert!(!json.contains("\"memoryKib\""));
}

#[test]
fn crud_and_generation_roundtrip() {
    let mut source = rng(5);
    let mut created = create_vault(PASSWORD, test_config(), 100, &mut source).unwrap();

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
    let unlocked = unlock_vault(PASSWORD, &created.metadata, &slot_b).unwrap();
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
        KdfConfig {
            memory_kib: 1,
            iterations: 1,
            parallelism: 1,
        },
        0,
        &mut source,
    );
    assert!(matches!(result, Err(VaultError::InvalidKdfParameters(_))));

    let created = create_vault(PASSWORD, test_config(), 0, &mut source).unwrap();
    let mut metadata = created.metadata.clone();
    metadata.kdf.memory_kib = u32::MAX;
    assert!(matches!(
        unlock_vault(PASSWORD, &metadata, &created.initial_slot),
        Err(VaultError::InvalidKdfParameters(_))
    ));
}

#[test]
fn future_versions_and_invalid_entry_sizes_are_rejected() {
    let mut source = rng(7);
    let mut created = create_vault(PASSWORD, test_config(), 0, &mut source).unwrap();
    let mut metadata = created.metadata.clone();
    metadata.version = 2;
    assert_eq!(
        unlock_vault(PASSWORD, &metadata, &created.initial_slot).unwrap_err(),
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
        create_vault("короткая фраза".as_bytes(), test_config(), 0, &mut source,),
        Err(VaultError::InvalidMasterPassword(_))
    ));
    assert!(matches!(
        create_vault(&[0xff; 16], test_config(), 0, &mut source),
        Err(VaultError::InvalidMasterPassword(_))
    ));
}

#[test]
fn persistent_models_reject_unknown_fields_and_metadata_timestamp_tampering() {
    let mut source = rng(8);
    let created = create_vault(PASSWORD, test_config(), 42, &mut source).unwrap();

    let mut unknown_field = serde_json::to_value(&created.metadata).unwrap();
    unknown_field["unexpected"] = Value::Bool(true);
    assert!(serde_json::from_value::<VaultMetaV1>(unknown_field).is_err());

    let mut tampered_metadata = created.metadata.clone();
    tampered_metadata.created_at += 1;
    assert!(matches!(
        unlock_vault(PASSWORD, &tampered_metadata, &created.initial_slot,),
        Err(VaultError::InvalidMetadata(_))
    ));
}

#[test]
fn random_source_failure_is_reported_without_panicking() {
    assert!(matches!(
        create_vault(PASSWORD, test_config(), 0, &mut FailingRandom,),
        Err(VaultError::RandomGenerationFailed)
    ));
}
