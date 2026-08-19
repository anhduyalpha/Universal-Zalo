"use client";

import React, { useState } from "react";
import { STICKER_COLLECTIONS, StickerItem } from "../lib/stickers_data";
import { X, Search } from "lucide-react";

interface StickerPickerProps {
  onSelect: (sticker: StickerItem, categoryId: string) => void;
  onClose: () => void;
}

export const StickerPicker: React.FC<StickerPickerProps> = ({ onSelect, onClose }) => {
  const [activeCategory, setActiveCategory] = useState<string>(STICKER_COLLECTIONS[0].id);
  const [searchQuery, setSearchQuery] = useState("");

  const currentCategory = STICKER_COLLECTIONS.find((c) => c.id === activeCategory) || STICKER_COLLECTIONS[0];

  const filteredStickers = searchQuery.trim()
    ? STICKER_COLLECTIONS.flatMap((c) => c.stickers).filter((s) =>
        s.name.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : currentCategory.stickers;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 70,
        left: 12,
        right: 12,
        maxWidth: 380,
        backgroundColor: "#ffffff",
        borderRadius: 16,
        boxShadow: "0 8px 30px rgba(0,0,0,0.15)",
        border: "1px solid #e5e7eb",
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
        height: 320,
        overflow: "hidden",
      }}
    >
      {/* Header & Search */}
      <div style={{ padding: "10px 12px", borderBottom: "1px solid #f1f5f9", display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", background: "#f8fafc", borderRadius: 20, padding: "4px 10px", border: "1px solid #e2e8f0" }}>
          <Search size={14} color="#94a3b8" />
          <input
            type="text"
            placeholder="Tìm kiếm sticker Zalo..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ border: "none", background: "transparent", outline: "none", fontSize: 12, paddingLeft: 6, width: "100%" }}
          />
        </div>
        <button onClick={onClose} style={{ border: "none", background: "none", color: "#64748b", cursor: "pointer", padding: 4 }}>
          <X size={18} />
        </button>
      </div>

      {/* Stickers Grid */}
      <div style={{ flex: 1, padding: 12, overflowY: "auto", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, alignContent: "start" }}>
        {filteredStickers.map((sticker) => (
          <button
            key={sticker.id}
            onClick={() => onSelect(sticker, currentCategory.id)}
            style={{
              border: "1px solid transparent",
              background: "#f8fafc",
              borderRadius: 12,
              padding: 6,
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              transition: "transform 0.1s, background 0.1s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "scale(1.05)";
              e.currentTarget.style.backgroundColor = "#e0f2fe";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "scale(1)";
              e.currentTarget.style.backgroundColor = "#f8fafc";
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={sticker.url} alt={sticker.name} style={{ width: 68, height: 68, objectFit: "contain" }} loading="lazy" />
            <span style={{ fontSize: 10, color: "#64748b", marginTop: 4, textAlign: "center" }}>{sticker.name}</span>
          </button>
        ))}
      </div>

      {/* Category Tabs Footer */}
      {!searchQuery && (
        <div style={{ display: "flex", borderTop: "1px solid #f1f5f9", background: "#f8fafc", padding: "4px 8px", gap: 4, overflowX: "auto" }}>
          {STICKER_COLLECTIONS.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              style={{
                border: "none",
                background: activeCategory === cat.id ? "#e0f2fe" : "transparent",
                borderRadius: 8,
                padding: "6px 10px",
                fontSize: 16,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
              title={cat.name}
            >
              <span>{cat.icon}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
