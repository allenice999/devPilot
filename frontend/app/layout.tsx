import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "DevPilot · Streaming AI Lab",
  description: "Streaming AI chat demo with SSE, tool events, and schema cards",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

