import React from "react";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Universal Zalo Web Client (PWA)",
  description: "Multi-Device Concurrent Zalo Client",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Universal Zalo",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#0068ff",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="vi">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="theme-color" content="#0068ff" />
      </head>
      <body
        style={{
          margin: 0,
          padding: 0,
          fontFamily:
            "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif",
          backgroundColor: "#f0f2f5",
          height: "100dvh",
          overflow: "hidden",
        }}
      >
        {children}
      </body>
    </html>
  );
}
