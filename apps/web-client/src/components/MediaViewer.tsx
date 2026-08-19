"use client";

import React, { useState } from "react";
import { X, ZoomIn, ZoomOut, RotateCw, Download } from "lucide-react";

interface MediaViewerProps {
  type: "IMAGE" | "VIDEO";
  src: string;
  name?: string;
  onClose: () => void;
}

export const MediaViewer: React.FC<MediaViewerProps> = ({ type, src, name, onClose }) => {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);

  const handleZoomIn = () => setZoom((prev) => Math.min(prev + 0.25, 3));
  const handleZoomOut = () => setZoom((prev) => Math.max(prev - 0.25, 0.5));
  const handleRotate = () => setRotation((prev) => (prev + 90) % 360);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.85)",
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(6px)",
      }}
      onClick={onClose}
    >
      {/* Top Toolbar */}
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          right: 16,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          color: "#fff",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <span style={{ fontSize: 14, opacity: 0.9, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name || (type === "IMAGE" ? "Hình ảnh" : "Video")}
        </span>

        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {type === "IMAGE" && (
            <>
              <button
                onClick={handleZoomIn}
                style={{ background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", padding: 8, borderRadius: 8, cursor: "pointer", display: "flex" }}
                title="Phóng to"
              >
                <ZoomIn size={18} />
              </button>
              <button
                onClick={handleZoomOut}
                style={{ background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", padding: 8, borderRadius: 8, cursor: "pointer", display: "flex" }}
                title="Thu nhỏ"
              >
                <ZoomOut size={18} />
              </button>
              <button
                onClick={handleRotate}
                style={{ background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", padding: 8, borderRadius: 8, cursor: "pointer", display: "flex" }}
                title="Xoay ảnh"
              >
                <RotateCw size={18} />
              </button>
            </>
          )}

          <a
            href={src}
            download={name || (type === "IMAGE" ? "zalo_image.jpg" : "zalo_video.mp4")}
            style={{ background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", padding: 8, borderRadius: 8, cursor: "pointer", display: "flex", textDecoration: "none" }}
            title="Tải về"
          >
            <Download size={18} />
          </a>

          <button
            onClick={onClose}
            style={{ background: "#ef4444", border: "none", color: "#fff", padding: 8, borderRadius: 8, cursor: "pointer", display: "flex" }}
            title="Đóng"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Media Content */}
      <div
        style={{
          maxWidth: "90vw",
          maxHeight: "80vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {type === "IMAGE" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={name || "Preview"}
            style={{
              maxWidth: "100%",
              maxHeight: "80vh",
              objectFit: "contain",
              transform: `scale(${zoom}) rotate(${rotation}deg)`,
              transition: "transform 0.2s ease-out",
              borderRadius: 8,
              boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            }}
          />
        ) : (
          <video
            src={src}
            controls
            autoPlay
            style={{
              maxWidth: "100%",
              maxHeight: "80vh",
              borderRadius: 8,
              boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            }}
          />
        )}
      </div>
    </div>
  );
};
