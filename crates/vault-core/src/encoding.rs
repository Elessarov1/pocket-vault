use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

pub(crate) fn encode_base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub(crate) fn decode_base64url(value: &str) -> Result<Vec<u8>, String> {
    if value.contains('=') {
        return Err("base64url padding is not allowed".to_owned());
    }

    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| "invalid base64url value".to_owned())
}

pub(crate) fn decode_base64url_array<const N: usize>(value: &str) -> Result<[u8; N], String> {
    let bytes = decode_base64url(value)?;
    bytes
        .try_into()
        .map_err(|_| format!("expected exactly {N} decoded bytes"))
}
