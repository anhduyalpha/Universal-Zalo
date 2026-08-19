use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct CanaryDriftDetector {
    circuit_broken: Arc<AtomicBool>,
    error_threshold: usize,
}

impl CanaryDriftDetector {
    pub fn new(error_threshold: usize) -> Self {
        Self {
            circuit_broken: Arc::new(AtomicBool::new(false)),
            error_threshold,
        }
    }

    pub fn is_circuit_broken(&self) -> bool {
        self.circuit_broken.load(Ordering::SeqCst)
    }

    pub fn compare_outputs(&self, rust_output: &[u8], browser_output: &[u8]) -> bool {
        if rust_output == browser_output {
            true
        } else {
            tracing::error!(
                rust_len = rust_output.len(),
                browser_len = browser_output.len(),
                "🚨 PROTOCOL SCHEMA DRIFT DETECTED between Rust engine and Chromium native context!"
            );
            self.circuit_broken.store(true, Ordering::SeqCst);
            false
        }
    }

    pub fn reset_circuit(&self) {
        self.circuit_broken.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_canary_drift_and_circuit_breaker() {
        let canary = CanaryDriftDetector::new(1);
        assert!(!canary.is_circuit_broken());

        let payload_a = b"exact_protobuf_binary_123";
        let payload_b = b"exact_protobuf_binary_123";
        assert!(canary.compare_outputs(payload_a, payload_b));
        assert!(!canary.is_circuit_broken());

        let payload_drift = b"zalo_updated_unexpected_field_456";
        assert!(!canary.compare_outputs(payload_a, payload_drift));
        assert!(canary.is_circuit_broken());

        canary.reset_circuit();
        assert!(!canary.is_circuit_broken());
    }
}
