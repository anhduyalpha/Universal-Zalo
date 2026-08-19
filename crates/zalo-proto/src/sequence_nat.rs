use anyhow::Result;
use parking_lot::RwLock;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

/// Stateful Sequence NAT quản lý việc ghi đè số tuần tự hai chiều
/// Đảm bảo tính toán delta offset Δ = S_wire - S_browser
#[derive(Debug)]
pub struct SequenceNat {
    delta_offset: AtomicU32,
    highest_wire_seq: AtomicU32,
    highest_browser_seq: AtomicU32,
}

impl SequenceNat {
    pub fn new() -> Self {
        Self {
            delta_offset: AtomicU32::new(0),
            highest_wire_seq: AtomicU32::new(0),
            highest_browser_seq: AtomicU32::new(0),
        }
    }

    /// Xử lý gói tin xuất phát từ Chromium Browser
    /// Ghi đè Seq_wire = Seq_browser + Δ
    pub fn transform_browser_outbound(&self, browser_seq: u32) -> u32 {
        self.highest_browser_seq.fetch_max(browser_seq, Ordering::SeqCst);
        let delta = self.delta_offset.load(Ordering::SeqCst);
        let wire_seq = browser_seq + delta;
        self.highest_wire_seq.fetch_max(wire_seq, Ordering::SeqCst);
        wire_seq
    }

    /// Cấp phát số tuần tự khi inject tin nhắn từ Sub-Client
    /// Tăng Δ lên 1 và trả về số wire_seq mới
    pub fn allocate_injected_outbound(&self) -> u32 {
        let prev_delta = self.delta_offset.fetch_add(1, Ordering::SeqCst);
        let current_browser = self.highest_browser_seq.load(Ordering::SeqCst);
        let wire_seq = current_browser + prev_delta + 1;
        self.highest_wire_seq.fetch_max(wire_seq, Ordering::SeqCst);
        wire_seq
    }

    /// Dịch ngược số tuần tự từ Zalo Cloud về cho Chromium Browser
    /// Seq_browser = Seq_wire - Δ
    pub fn translate_wire_to_browser(&self, wire_seq: u32) -> Option<u32> {
        let delta = self.delta_offset.load(Ordering::SeqCst);
        if wire_seq >= delta {
            Some(wire_seq - delta)
        } else {
            None
        }
    }

    pub fn get_current_delta(&self) -> u32 {
        self.delta_offset.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sequence_nat_lifecycle() {
        let nat = SequenceNat::new();

        // 1. Browser gửi gói tin seq = 10 (Δ = 0)
        let wire_10 = nat.transform_browser_outbound(10);
        assert_eq!(wire_10, 10);

        // 2. Sub-Client A inject 1 tin nhắn
        let inject_seq_1 = nat.allocate_injected_outbound();
        assert_eq!(inject_seq_1, 11);
        assert_eq!(nat.get_current_delta(), 1);

        // 3. Sub-Client B inject thêm 1 tin nhắn
        let inject_seq_2 = nat.allocate_injected_outbound();
        assert_eq!(inject_seq_2, 12);
        assert_eq!(nat.get_current_delta(), 2);

        // 4. Browser tiếp tục gửi gói tin tiếp theo seq = 11
        // Wire phải tự động nâng lên 11 + 2 = 13 (Không bị đè vào 11 hay 12)
        let wire_11 = nat.transform_browser_outbound(11);
        assert_eq!(wire_11, 13);

        // 5. Zalo Server trả về ACK cho gói tin 13
        // Dịch ngược về cho Browser nhận 11
        let browser_ack = nat.translate_wire_to_browser(13);
        assert_eq!(browser_ack, Some(11));
    }
}
