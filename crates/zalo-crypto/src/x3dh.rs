use crate::identity_vault::IdentityKeyPair;
use anyhow::Result;
use hkdf::Hkdf;
use sha2::Sha256;

pub struct PreKeyBundle {
    pub identity_key: [u8; 32],
    pub signed_prekey: [u8; 32],
    pub one_time_prekey: Option<[u8; 32]>,
}

pub struct X3dhEngine;

impl X3dhEngine {
    /// Tính toán X3DH với cơ chế 3-Way DH Fallback khi OTPK cạn kiệt
    pub fn derive_shared_key(
        alice_ik: &IdentityKeyPair,
        alice_ek: &IdentityKeyPair,
        bob_bundle: &PreKeyBundle,
    ) -> Result<[u8; 32]> {
        // DH1 = DH(IK_A, SPK_B)
        let dh1 = alice_ik.diffie_hellman(&bob_bundle.signed_prekey);
        // DH2 = DH(EK_A, IK_B)
        let dh2 = alice_ek.diffie_hellman(&bob_bundle.identity_key);
        // DH3 = DH(EK_A, SPK_B)
        let dh3 = alice_ek.diffie_hellman(&bob_bundle.signed_prekey);

        let mut ikm = Vec::with_capacity(128);
        ikm.extend_from_slice(&dh1);
        ikm.extend_from_slice(&dh2);
        ikm.extend_from_slice(&dh3);

        if let Some(opk) = bob_bundle.one_time_prekey {
            // 4-Way DH: DH4 = DH(EK_A, OPK_B)
            let dh4 = alice_ek.diffie_hellman(&opk);
            ikm.extend_from_slice(&dh4);
        } else {
            tracing::info!("⚠️ OTPK Pool empty: Fallback to 3-Way DH standard!");
        }

        let hk = Hkdf::<Sha256>::new(None, &ikm);
        let mut okm = [0u8; 32];
        hk.expand(b"ZaloX3DHMiniProtocol", &mut okm)
            .map_err(|_| anyhow::anyhow!("HKDF expansion failed"))?;

        Ok(okm)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_x3dh_3way_and_4way_fallback() {
        let alice_ik = IdentityKeyPair::generate();
        let alice_ek = IdentityKeyPair::generate();

        let bob_ik = IdentityKeyPair::generate();
        let bob_spk = IdentityKeyPair::generate();
        let bob_opk = IdentityKeyPair::generate();

        // 1. Thử 4-Way DH (Có OTPK)
        let bundle_with_opk = PreKeyBundle {
            identity_key: bob_ik.public_key_bytes(),
            signed_prekey: bob_spk.public_key_bytes(),
            one_time_prekey: Some(bob_opk.public_key_bytes()),
        };
        let key_4way =
            X3dhEngine::derive_shared_key(&alice_ik, &alice_ek, &bundle_with_opk).unwrap();
        assert_ne!(key_4way, [0u8; 32]);

        // 2. Thử 3-Way Fallback DH (Không có OTPK)
        let bundle_empty_opk = PreKeyBundle {
            identity_key: bob_ik.public_key_bytes(),
            signed_prekey: bob_spk.public_key_bytes(),
            one_time_prekey: None,
        };
        let key_3way =
            X3dhEngine::derive_shared_key(&alice_ik, &alice_ek, &bundle_empty_opk).unwrap();
        assert_ne!(key_3way, [0u8; 32]);
        assert_ne!(key_4way, key_3way);
    }
}
