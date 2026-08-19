import React from "react";

export const metadata = {
  title: "Universal Zalo Web Client (PWA)",
  description: "Multi-Device Concurrent Zalo Client",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="vi">
      <body style={{ margin: 0, padding: 0, fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif", backgroundColor: "#f0f2f5" }}>
        {children}
      </body>
    </html>
  );
}
