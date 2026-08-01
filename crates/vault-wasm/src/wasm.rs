use getrandom::Error as RandomError;
use rand_core::{TryCryptoRng, TryRng};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

use crate::bridge::{
    BridgeError, CreateBundle, OpenBundle, SaveBundle, StorageSnapshot, VaultBridge,
};

struct BrowserCryptoRng;

impl TryRng for BrowserCryptoRng {
    type Error = RandomError;

    fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
        getrandom::u32()
    }

    fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
        getrandom::u64()
    }

    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
        getrandom::fill(dst)
    }
}

impl TryCryptoRng for BrowserCryptoRng {}

#[wasm_bindgen(js_name = VaultSession)]
pub struct WasmVaultSession {
    inner: VaultBridge,
}

#[wasm_bindgen(js_class = VaultSession)]
impl WasmVaultSession {
    #[wasm_bindgen(js_name = create)]
    pub fn create(master_password: String, now: f64) -> Result<WasmCreateBundle, JsValue> {
        let master_password = Zeroizing::new(master_password);
        let mut rng = BrowserCryptoRng;
        VaultBridge::create(master_password.as_bytes(), parse_timestamp(now)?, &mut rng)
            .map(WasmCreateBundle::new)
            .map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = open)]
    #[allow(clippy::similar_names, clippy::too_many_arguments)]
    pub fn open(
        master_password: String,
        metadata_json: Option<String>,
        slot_a_json: Option<String>,
        slot_b_json: Option<String>,
        active_pointer_json: Option<String>,
    ) -> Result<WasmOpenBundle, JsValue> {
        let master_password = Zeroizing::new(master_password);
        VaultBridge::open(
            master_password.as_bytes(),
            StorageSnapshot {
                metadata_json,
                slot_a_json,
                slot_b_json,
                active_pointer_json,
            },
        )
        .map(WasmOpenBundle::new)
        .map_err(to_js_error)
    }

    #[wasm_bindgen(getter, js_name = isLocked)]
    pub fn is_locked(&self) -> bool {
        self.inner.is_locked()
    }

    #[wasm_bindgen(getter)]
    pub fn generation(&self) -> Option<String> {
        self.inner.generation().map(|value| value.to_string())
    }

    #[wasm_bindgen(getter, js_name = persistedSlot)]
    pub fn persisted_slot(&self) -> Option<String> {
        self.inner.persisted_slot().map(|slot| match slot {
            vault_core::SlotId::A => "a".to_owned(),
            vault_core::SlotId::B => "b".to_owned(),
        })
    }

    #[wasm_bindgen(js_name = listEntriesJson)]
    pub fn list_entries_json(&self) -> Result<String, JsValue> {
        self.inner.list_entries_json().map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = getEntryJson)]
    pub fn get_entry_json(&self, id: &str) -> Result<String, JsValue> {
        self.inner.get_entry_json(id).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = getEntryDetailsJson)]
    pub fn get_entry_details_json(&self, id: &str) -> Result<String, JsValue> {
        self.inner.get_entry_details_json(id).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = getEntrySecret)]
    pub fn get_entry_secret(&self, id: &str) -> Result<String, JsValue> {
        self.inner.get_entry_secret(id).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = addEntry)]
    pub fn add_entry(
        &mut self,
        title: String,
        secret: String,
        description: Option<String>,
        now: f64,
    ) -> Result<String, JsValue> {
        let mut rng = BrowserCryptoRng;
        self.inner
            .add_entry(title, secret, description, parse_timestamp(now)?, &mut rng)
            .map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = updateEntry)]
    pub fn update_entry(
        &mut self,
        id: &str,
        title: String,
        secret: String,
        description: Option<String>,
        now: f64,
    ) -> Result<(), JsValue> {
        self.inner
            .update_entry(id, title, secret, description, parse_timestamp(now)?)
            .map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = deleteEntry)]
    pub fn delete_entry(&mut self, id: &str, now: f64) -> Result<(), JsValue> {
        self.inner
            .delete_entry(id, parse_timestamp(now)?)
            .map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = prepareSave)]
    pub fn prepare_save(&mut self) -> Result<WasmSaveBundle, JsValue> {
        let mut rng = BrowserCryptoRng;
        self.inner
            .prepare_save(&mut rng)
            .map(WasmSaveBundle::new)
            .map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = verifyPendingSlot)]
    pub fn verify_pending_slot(&mut self, readback_json: &str) -> Result<(), JsValue> {
        self.inner
            .verify_pending_slot(readback_json)
            .map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = commitPendingSave)]
    pub fn commit_pending_save(&mut self, readback_json: &str) -> Result<(), JsValue> {
        self.inner
            .commit_pending_save(readback_json)
            .map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = cancelPendingSave)]
    pub fn cancel_pending_save(&mut self) {
        self.inner.cancel_pending_save();
    }

    pub fn lock(&mut self) {
        self.inner.lock();
    }
}

#[wasm_bindgen(js_name = CreateBundle)]
pub struct WasmCreateBundle {
    inner: Option<CreateBundle>,
}

impl WasmCreateBundle {
    fn new(inner: CreateBundle) -> Self {
        Self { inner: Some(inner) }
    }

    fn inner(&self) -> Result<&CreateBundle, JsValue> {
        self.inner
            .as_ref()
            .ok_or_else(|| JsValue::from_str("bundle_consumed"))
    }
}

#[wasm_bindgen(js_class = CreateBundle)]
impl WasmCreateBundle {
    #[wasm_bindgen(getter, js_name = metadataJson)]
    pub fn metadata_json(&self) -> Result<String, JsValue> {
        Ok(self.inner()?.metadata_json.clone())
    }

    #[wasm_bindgen(getter, js_name = slotKey)]
    pub fn slot_key(&self) -> Result<String, JsValue> {
        Ok(self.inner()?.slot_key.to_owned())
    }

    #[wasm_bindgen(getter, js_name = slotJson)]
    pub fn slot_json(&self) -> Result<String, JsValue> {
        Ok(self.inner()?.slot_json.clone())
    }

    #[wasm_bindgen(getter, js_name = activePointerJson)]
    pub fn active_pointer_json(&self) -> Result<String, JsValue> {
        Ok(self.inner()?.active_pointer_json.clone())
    }

    #[wasm_bindgen(js_name = takeSession)]
    pub fn take_session(mut self) -> Result<WasmVaultSession, JsValue> {
        let inner = self
            .inner
            .take()
            .ok_or_else(|| JsValue::from_str("bundle_consumed"))?;
        Ok(WasmVaultSession {
            inner: inner.session,
        })
    }
}

#[wasm_bindgen(js_name = OpenBundle)]
pub struct WasmOpenBundle {
    inner: Option<OpenBundle>,
}

impl WasmOpenBundle {
    fn new(inner: OpenBundle) -> Self {
        Self { inner: Some(inner) }
    }
}

#[wasm_bindgen(js_class = OpenBundle)]
impl WasmOpenBundle {
    #[wasm_bindgen(getter, js_name = repairedPointerJson)]
    pub fn repaired_pointer_json(&self) -> Option<String> {
        self.inner
            .as_ref()
            .and_then(|inner| inner.repaired_pointer_json.clone())
    }

    #[wasm_bindgen(js_name = takeSession)]
    pub fn take_session(mut self) -> Result<WasmVaultSession, JsValue> {
        let inner = self
            .inner
            .take()
            .ok_or_else(|| JsValue::from_str("bundle_consumed"))?;
        Ok(WasmVaultSession {
            inner: inner.session,
        })
    }
}

#[wasm_bindgen(js_name = SaveBundle)]
pub struct WasmSaveBundle {
    inner: SaveBundle,
}

impl WasmSaveBundle {
    fn new(inner: SaveBundle) -> Self {
        Self { inner }
    }
}

#[wasm_bindgen(js_class = SaveBundle)]
impl WasmSaveBundle {
    #[wasm_bindgen(getter, js_name = slotKey)]
    pub fn slot_key(&self) -> String {
        self.inner.slot_key.to_owned()
    }

    #[wasm_bindgen(getter, js_name = slotJson)]
    pub fn slot_json(&self) -> String {
        self.inner.slot_json.clone()
    }

    #[wasm_bindgen(getter, js_name = activePointerJson)]
    pub fn active_pointer_json(&self) -> String {
        self.inner.active_pointer_json.clone()
    }
}

fn parse_timestamp(value: f64) -> Result<u64, JsValue> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > 9_007_199_254_740_991.0
    {
        return Err(JsValue::from_str("invalid_timestamp"));
    }
    value
        .to_string()
        .parse()
        .map_err(|_| JsValue::from_str("invalid_timestamp"))
}

#[allow(clippy::needless_pass_by_value)]
fn to_js_error(error: BridgeError) -> JsValue {
    JsValue::from_str(error.code())
}
