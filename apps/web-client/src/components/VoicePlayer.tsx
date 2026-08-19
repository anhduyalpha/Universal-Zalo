"use client";

import React, { useState, useRef, useEffect } from "react";
import { Play, Pause } from "lucide-react";

interface VoicePlayerProps {
  src?: string;
  duration?: number; // duration in seconds
  isMe?: boolean;
}

export const VoicePlayer: React.FC<VoicePlayerProps> = ({ src, duration = 12, isMe = false }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };

    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("ended", handleEnded);

    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("ended", handleEnded);
    };
  }, []);

  const togglePlay = () => {
    if (!audioRef.current && src) {
      const audio = new Audio(src);
      audioRef.current = audio;
    }

    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
        setIsPlaying(false);
      } else {
        audioRef.current.play().catch(() => {});
        setIsPlaying(true);
      }
    } else {
      // Simulate playback if simulated voice note
      setIsPlaying(!isPlaying);
    }
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  // Mock wave bars heights
  const bars = [4, 8, 14, 18, 12, 6, 16, 20, 15, 8, 18, 14, 10, 16, 8, 12, 18, 10, 6, 4];

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        minWidth: 180,
        padding: "4px 0",
      }}
    >
      <button
        onClick={togglePlay}
        style={{
          width: 36,
          height: 36,
          borderRadius: "50%",
          backgroundColor: isMe ? "#0068ff" : "#3b82f6",
          border: "none",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          flexShrink: 0,
          boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
        }}
      >
        {isPlaying ? <Pause size={18} /> : <Play size={18} style={{ marginLeft: 2 }} />}
      </button>

      {/* Waveform visualizer */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 2, height: 24, cursor: "pointer" }}>
        {bars.map((h, i) => {
          const progress = currentTime / (duration || 1);
          const isPlayed = i / bars.length <= progress;
          return (
            <div
              key={i}
              style={{
                width: 3,
                height: `${h}px`,
                backgroundColor: isPlayed ? (isMe ? "#0068ff" : "#1e40af") : (isMe ? "#93c5fd" : "#cbd5e1"),
                borderRadius: 2,
                transition: "height 0.15s ease",
              }}
            />
          );
        })}
      </div>

      {/* Duration */}
      <span style={{ fontSize: 11, color: isMe ? "#1e3a8a" : "#64748b", fontVariantNumeric: "tabular-nums" }}>
        {isPlaying ? formatTime(currentTime) : formatTime(duration)}
      </span>
    </div>
  );
};
