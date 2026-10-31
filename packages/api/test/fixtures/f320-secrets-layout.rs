// Append only to secrets/src/local.rs in a disposable copy of Codex commit
// 687a119f0fcaace47e1f1abcc77cec6c813fd6da. Never uses the OS keyring.
#[cfg(test)]
mod f320_layout_tests {
    use super::*;
    use codex_keyring_store::tests::MockKeyringStore;

    #[test]
    fn separate_homes_roundtrip_and_reject_foreign_ciphertext_with_mock_keyring() -> Result<()> {
        let a = tempfile::tempdir()?;
        let b = tempfile::tempdir()?;
        let keyring = Arc::new(MockKeyringStore::default());
        let left = LocalSecretsBackend::new_with_namespace(
            a.path().to_path_buf(), keyring.clone(), LocalSecretsNamespace::CodexAuth,
        );
        let right = LocalSecretsBackend::new_with_namespace(
            b.path().to_path_buf(), keyring, LocalSecretsNamespace::CodexAuth,
        );
        let scope = SecretScope::Global;
        let name = SecretName::new("F320_FIXTURE_SECRET")?;
        left.set(&scope, &name, "fixture-account-a")?;
        right.set(&scope, &name, "fixture-account-b")?;
        assert_ne!(
            compute_keyring_account(a.path(), LocalSecretsNamespace::CodexAuth),
            compute_keyring_account(b.path(), LocalSecretsNamespace::CodexAuth),
        );
        assert_eq!(left.get(&scope, &name)?, Some("fixture-account-a".to_string()));
        assert_eq!(right.get(&scope, &name)?, Some("fixture-account-b".to_string()));
        std::fs::copy(left.secrets_path(), right.secrets_path())?;
        assert!(right.get(&scope, &name).is_err(), "foreign ciphertext must fail to decrypt");
        assert_eq!(left.get(&scope, &name)?, Some("fixture-account-a".to_string()));
        Ok(())
    }
}
