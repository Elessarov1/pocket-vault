use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use serde_json::Value;
use vault_core::{
    ACTIVE_SLOT_KEY, KdfConfig, META_KEY, MemoryStorage, NewVaultEntry, SLOT_A_KEY, SLOT_B_KEY,
    SlotId, StorageError, TwoSlotRepository, VaultError, create_vault,
};

const PASSWORD: &[u8] = b"correct horse battery staple";
const DEVICE_SECRET: [u8; 32] = [0x5a; 32];

fn config() -> KdfConfig {
    KdfConfig {
        memory_kib: 32_768,
        iterations: 1,
        parallelism: 1,
    }
}

fn rng(seed: u8) -> ChaCha20Rng {
    ChaCha20Rng::from_seed([seed; 32])
}

fn add_demo_entry(vault: &mut vault_core::UnlockedVault, source: &mut ChaCha20Rng) {
    vault
        .add_entry(
            NewVaultEntry {
                title: "GitHub".to_owned(),
                secret: "test-token".to_owned(),
                description: Some("Рабочий профиль".to_owned()),
            },
            20,
            source,
        )
        .unwrap();
}

fn tamper_ciphertext(encoded_slot: &str) -> String {
    let mut value: Value = serde_json::from_str(encoded_slot).unwrap();
    let ciphertext = value["ciphertext"].as_str().unwrap();
    let replacement = if ciphertext.starts_with('A') {
        'B'
    } else {
        'A'
    };
    let mut tampered = ciphertext.to_owned();
    tampered.replace_range(..1, &replacement.to_string());
    value["ciphertext"] = Value::String(tampered);
    serde_json::to_string(&value).unwrap()
}

#[test]
fn initialize_open_and_alternating_save_roundtrip() {
    let mut source = rng(10);
    let mut created = create_vault(PASSWORD, &DEVICE_SECRET, config(), 10, &mut source).unwrap();
    let mut repository = TwoSlotRepository::new(MemoryStorage::default());
    repository.initialize(&created).unwrap();

    assert!(repository.storage().raw(META_KEY).is_some());
    assert!(repository.storage().raw(SLOT_A_KEY).is_some());
    assert!(repository.storage().raw(SLOT_B_KEY).is_none());

    add_demo_entry(&mut created.unlocked, &mut source);
    repository.save(&mut created.unlocked, &mut source).unwrap();
    assert_eq!(created.unlocked.persisted_slot(), SlotId::B);
    assert_eq!(created.unlocked.generation(), 1);

    repository.save(&mut created.unlocked, &mut source).unwrap();
    assert_eq!(created.unlocked.persisted_slot(), SlotId::A);
    assert_eq!(created.unlocked.generation(), 2);

    let opened = repository.open(PASSWORD, &DEVICE_SECRET).unwrap();
    assert!(!opened.active_pointer_repaired);
    assert_eq!(opened.vault.generation(), 2);
    assert_eq!(opened.vault.entries().len(), 1);
    assert_eq!(opened.vault.entries()[0].title, "GitHub");
}

#[test]
fn initialize_refuses_to_overwrite_an_existing_vault() {
    let mut source = rng(16);
    let created = create_vault(PASSWORD, &DEVICE_SECRET, config(), 10, &mut source).unwrap();
    let mut repository = TwoSlotRepository::new(MemoryStorage::default());
    repository.initialize(&created).unwrap();
    let original_metadata = repository.storage().raw(META_KEY).unwrap().to_owned();

    assert_eq!(
        repository.initialize(&created),
        Err(VaultError::AlreadyInitialized)
    );
    assert_eq!(
        repository.storage().raw(META_KEY),
        Some(original_metadata.as_str())
    );
}

#[test]
fn corrupt_active_slot_falls_back_and_repairs_pointer() {
    let mut source = rng(11);
    let mut created = create_vault(PASSWORD, &DEVICE_SECRET, config(), 10, &mut source).unwrap();
    let mut repository = TwoSlotRepository::new(MemoryStorage::default());
    repository.initialize(&created).unwrap();
    add_demo_entry(&mut created.unlocked, &mut source);
    repository.save(&mut created.unlocked, &mut source).unwrap();

    let slot_b = repository.storage().raw(SLOT_B_KEY).unwrap().to_owned();
    repository
        .storage_mut()
        .insert_raw(SLOT_B_KEY, tamper_ciphertext(&slot_b));

    let opened = repository.open(PASSWORD, &DEVICE_SECRET).unwrap();
    assert!(opened.active_pointer_repaired);
    assert_eq!(opened.vault.persisted_slot(), SlotId::A);
    assert_eq!(opened.vault.generation(), 0);
    assert!(opened.vault.entries().is_empty());

    let pointer: Value =
        serde_json::from_str(repository.storage().raw(ACTIVE_SLOT_KEY).unwrap()).unwrap();
    assert_eq!(pointer["slot"], "a");
    assert_eq!(pointer["generation"], 0);
}

#[test]
fn completed_slot_is_recovered_when_pointer_write_was_interrupted() {
    let mut source = rng(12);
    let mut created = create_vault(PASSWORD, &DEVICE_SECRET, config(), 10, &mut source).unwrap();
    let mut repository = TwoSlotRepository::new(MemoryStorage::default());
    repository.initialize(&created).unwrap();
    add_demo_entry(&mut created.unlocked, &mut source);

    repository.storage_mut().fail_next_set(ACTIVE_SLOT_KEY);
    assert_eq!(
        repository.save(&mut created.unlocked, &mut source),
        Err(VaultError::Storage(StorageError::WriteFailed))
    );
    assert_eq!(created.unlocked.generation(), 0);

    let opened = repository.open(PASSWORD, &DEVICE_SECRET).unwrap();
    assert!(opened.active_pointer_repaired);
    assert_eq!(opened.vault.persisted_slot(), SlotId::B);
    assert_eq!(opened.vault.generation(), 1);
    assert_eq!(opened.vault.entries().len(), 1);
}

#[test]
fn slot_write_failure_preserves_previous_slot() {
    let mut source = rng(13);
    let mut created = create_vault(PASSWORD, &DEVICE_SECRET, config(), 10, &mut source).unwrap();
    let mut repository = TwoSlotRepository::new(MemoryStorage::default());
    repository.initialize(&created).unwrap();
    add_demo_entry(&mut created.unlocked, &mut source);

    repository.storage_mut().fail_next_set(SLOT_B_KEY);
    assert_eq!(
        repository.save(&mut created.unlocked, &mut source),
        Err(VaultError::Storage(StorageError::WriteFailed))
    );
    let opened = repository.open(PASSWORD, &DEVICE_SECRET).unwrap();
    assert!(!opened.active_pointer_repaired);
    assert_eq!(opened.vault.generation(), 0);
    assert!(opened.vault.entries().is_empty());
}

#[test]
fn clear_removes_all_pocket_vault_keys() {
    let mut source = rng(14);
    let created = create_vault(PASSWORD, &DEVICE_SECRET, config(), 10, &mut source).unwrap();
    let mut repository = TwoSlotRepository::new(MemoryStorage::default());
    repository.initialize(&created).unwrap();
    repository.clear_device_storage().unwrap();

    for key in [META_KEY, SLOT_A_KEY, SLOT_B_KEY, ACTIVE_SLOT_KEY] {
        assert!(repository.storage().raw(key).is_none());
    }
}

#[test]
fn initialization_does_not_publish_metadata_before_the_first_slot() {
    let mut source = rng(15);
    let created = create_vault(PASSWORD, &DEVICE_SECRET, config(), 10, &mut source).unwrap();
    let mut storage = MemoryStorage::default();
    storage.fail_next_set(META_KEY);
    let mut repository = TwoSlotRepository::new(storage);

    assert_eq!(
        repository.initialize(&created),
        Err(VaultError::Storage(StorageError::WriteFailed))
    );
    assert!(repository.storage().raw(SLOT_A_KEY).is_some());
    assert!(repository.storage().raw(META_KEY).is_none());
    assert!(matches!(
        repository.open(PASSWORD, &DEVICE_SECRET),
        Err(VaultError::Uninitialized)
    ));
}
