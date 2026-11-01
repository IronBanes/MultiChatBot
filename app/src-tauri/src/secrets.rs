//! API keys live in the OS keychain (Windows Credential Manager, macOS Keychain,
//! Secret Service on Linux), keyed by profile id.

const SERVICE: &str = "multichat-bot";

fn entry(profile_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &format!("profile:{profile_id}"))
        .map_err(|e| format!("Keychain unavailable: {e}"))
}

pub fn get_key(profile_id: &str) -> Result<Option<String>, String> {
    match entry(profile_id)?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Could not read API key from keychain: {e}")),
    }
}

pub fn set_key(profile_id: &str, key: &str) -> Result<(), String> {
    entry(profile_id)?
        .set_password(key)
        .map_err(|e| format!("Could not store API key in keychain: {e}"))
}

pub fn delete_key(profile_id: &str) -> Result<(), String> {
    match entry(profile_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not delete API key from keychain: {e}")),
    }
}
