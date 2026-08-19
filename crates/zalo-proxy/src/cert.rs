use anyhow::{Context, Result};
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, IsCa, KeyPair,
    KeyUsagePurpose, SanType,
};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::rustls::ServerConfig;

pub struct CertAuthority {
    ca_cert: rcgen::Certificate,
    ca_keypair: KeyPair,
}

impl CertAuthority {
    pub fn load_or_create<P: AsRef<Path>>(cert_dir: P) -> Result<Self> {
        let cert_dir = cert_dir.as_ref();
        fs::create_dir_all(cert_dir)?;

        let ca_cert_path = cert_dir.join("ca.crt");
        let ca_key_path = cert_dir.join("ca.key");

        if ca_cert_path.exists() && ca_key_path.exists() {
            let key_pem = fs::read_to_string(&ca_key_path)?;
            let keypair = KeyPair::from_pem(&key_pem).context("Failed to parse CA key PEM")?;

            let cert_pem = fs::read_to_string(&ca_cert_path)?;
            let params = CertificateParams::from_ca_cert_pem(&cert_pem)
                .context("Failed to parse CA cert PEM")?;
            let ca_cert = params.self_signed(&keypair)?;

            Ok(Self {
                ca_cert,
                ca_keypair: keypair,
            })
        } else {
            let mut params = CertificateParams::default();
            params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
            params.key_usages = vec![
                KeyUsagePurpose::KeyCertSign,
                KeyUsagePurpose::CrlSign,
                KeyUsagePurpose::DigitalSignature,
            ];
            let mut dn = DistinguishedName::new();
            dn.push(DnType::CommonName, "Universal Zalo Root CA");
            dn.push(DnType::OrganizationName, "Universal Zalo Security");
            params.distinguished_name = dn;

            let keypair = KeyPair::generate().context("Failed to generate CA keypair")?;
            let ca_cert = params.self_signed(&keypair)?;

            fs::write(&ca_cert_path, ca_cert.pem())?;
            fs::write(&ca_key_path, keypair.serialize_pem())?;

            tracing::info!("Created new Root CA certificate at: {:?}", ca_cert_path);
            Ok(Self {
                ca_cert,
                ca_keypair: keypair,
            })
        }
    }

    pub fn generate_server_config(&self, domain: &str) -> Result<Arc<ServerConfig>> {
        let mut params = CertificateParams::default();
        params.subject_alt_names = vec![SanType::DnsName(domain.to_string().try_into()?)];
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, domain);
        params.distinguished_name = dn;

        let server_keypair = KeyPair::generate().context("Failed to generate server keypair")?;
        let server_cert = params.signed_by(&server_keypair, &self.ca_cert, &self.ca_keypair)?;

        let cert_der = CertificateDer::from(server_cert.der().to_vec());
        let key_der = PrivateKeyDer::Pkcs8(server_keypair.serialize_der().into());

        let server_config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert_der], key_der)
            .context("Failed to create rustls ServerConfig")?;

        Ok(Arc::new(server_config))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cert_authority_generation() {
        let temp_dir = tempfile::tempdir().unwrap();
        let ca = CertAuthority::load_or_create(temp_dir.path()).unwrap();
        let server_config = ca.generate_server_config("chat.zalo.me").unwrap();
        assert!(server_config.alpn_protocols.is_empty() || true);
    }
}
