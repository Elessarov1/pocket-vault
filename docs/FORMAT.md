# Формат Pocket Vault V1

Этот документ фиксирует persistent-формат, криптографические контексты и порядок
записи, реализованные в `vault-core`. Несовместимые изменения требуют новой
версии. JSON использует UTF-8, `camelCase` и Base64URL без `=`; неизвестные поля
отклоняются.

## Ключи хранилища

| Device Storage key | Значение |
| --- | --- |
| `vault_meta_v1` | `VaultMetaV1` |
| `vault_slot_a_v1` | `EncryptedVaultSlotV1`, слот `a` |
| `vault_slot_b_v1` | `EncryptedVaultSlotV1`, слот `b` |
| `active_slot_v1` | `ActiveSlotV1` |

Случайный `device_secret` длиной 32 байта хранится отдельно в Telegram Secure
Storage и никогда не попадает в Device Storage.

Значение `device_secret_v1` — строгий versioned envelope:

```json
{
  "format": "pocket-vault-device-secret",
  "version": 1,
  "value": "<32 bytes base64url>"
}
```

## JSON-объекты

Метаданные:

```json
{
  "format": "pocket-vault",
  "version": 1,
  "vaultId": "<16 bytes base64url>",
  "createdAt": 1785450000,
  "kdf": {
    "algorithm": "argon2id",
    "salt": "<16..64 bytes base64url>",
    "memoryKiB": 65536,
    "iterations": 3,
    "parallelism": 1,
    "outputBytes": 32
  },
  "wrappedDek": {
    "algorithm": "xchacha20-poly1305",
    "nonce": "<24 bytes base64url>",
    "ciphertext": "<48 bytes base64url>"
  }
}
```

Зашифрованный слот:

```json
{
  "format": "pocket-vault",
  "version": 1,
  "vaultId": "<16 bytes base64url>",
  "slot": "a",
  "generation": 0,
  "algorithm": "xchacha20-poly1305",
  "nonce": "<24 bytes base64url>",
  "ciphertext": "<base64url>"
}
```

Активный указатель:

```json
{ "version": 1, "slot": "a", "generation": 0 }
```

Plaintext слота — сериализованный `VaultContainerV1`; он существует только в
памяти разблокированной сессии и перед AEAD-шифрованием:

```json
{
  "format": "pocket-vault",
  "version": 1,
  "vaultId": "<16 bytes base64url>",
  "generation": 0,
  "createdAt": 1785450000,
  "updatedAt": 1785450000,
  "entries": [
    {
      "id": "<16 bytes base64url>",
      "title": "GitHub",
      "secret": "correct horse battery staple",
      "description": "Рабочий аккаунт",
      "createdAt": 1785450000,
      "updatedAt": 1785450000
    }
  ]
}
```

`description` может отсутствовать. Заголовок, секрет, описание, идентификатор и
временные метки записи всегда шифруются вместе.

## Получение ключей

1. `password_key = Argon2id(master_password, kdf.salt, m, t, p, 32)` с версией
   Argon2 `0x13`.
2. `IKM = password_key || device_secret`.
3. `KEK = HKDF-SHA-256(IKM, salt=vault_id,
   info="pocket-vault/local-kek/v1", L=32)`.
4. Случайный 32-байтовый DEK зашифрован KEK и хранится в `wrappedDek`.
5. Контейнеры обоих слотов шифруются DEK.

Защитные границы входных KDF-параметров: память 32–256 MiB, итерации 1–10,
параллелизм 1–4, соль 16–64 байта, результат ровно 32 байта. Они проверяются до
дорогого вычисления.

## AAD

Каждое поле кодируется как `u32_be(length) || bytes`, после чего поля
конкатенируются. Числа внутри полей имеют big-endian encoding; `vault_id`
используется как 16 сырых байтов.

Для обёрнутого DEK:

```text
field("pocket-vault")
|| field("wrapped-dek")
|| field(u32_be(1))
|| field(vault_id)
```

Для слота:

```text
field("pocket-vault")
|| field("vault-slot")
|| field(u32_be(1))
|| field(vault_id)
|| field("a" | "b")
|| field(u64_be(generation))
```

Таким образом аутентификация связывает шифротекст с форматом, объектом,
версией, хранилищем, слотом и поколением.

## Двухслотовая запись и восстановление

Создание записывает первый слот, затем метаданные, затем активный указатель.
Обычное сохранение выполняется так:

1. зашифровать следующее поколение в неактивный слот;
2. записать слот и проверить точное чтение назад;
3. расшифровать прочитанное значение и сравнить контейнер;
4. записать и проверить активный указатель;
5. только после этого отметить поколение сохранённым в текущей сессии.

При открытии оба слота рассматриваются как недоверенные. Ядро выбирает слот с
наибольшим поколением среди успешно аутентифицированных и валидных контейнеров;
указатель разрешает только ничью. Повреждённый, устаревший или отсутствующий
указатель восстанавливается из выбранного слота.

## Ограничения V1

- максимум 10 000 записей;
- заголовок: 1–200 Unicode scalar values;
- секрет: 1–4096 байт UTF-8;
- описание: не более 2000 Unicode scalar values;
- JSON метаданных: не более 16 KiB;
- JSON слота и расшифрованный контейнер: не более 5 MiB;
- nonce XChaCha20-Poly1305 никогда не повторяется с тем же ключом и создаётся
  переданным вызывающей стороной CSPRNG.

Буферы ключей и расшифрованного JSON обнуляются при освобождении настолько,
насколько это позволяет Rust/WASM. Ошибка пароля и ошибка аутентификации
шифротекста намеренно не различаются.
