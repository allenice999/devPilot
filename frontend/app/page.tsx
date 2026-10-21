"use client";

import { useEffect, useState } from "react";

type ConnectionState = "loading" | "connected" | "error";

const backendUrl = (
  process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000"
).replace(/\/$/, "");

export default function Home() {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("loading");

  useEffect(() => {
    const controller = new AbortController();

    async function checkBackend() {
      try {
        const response = await fetch(`${backendUrl}/health`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = (await response.json()) as { status?: string };

        if (response.ok && data.status === "ok") {
          setConnectionState("connected");
          return;
        }

        setConnectionState("error");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setConnectionState("error");
      }
    }

    void checkBackend();
    return () => controller.abort();
  }, []);

  const statusText = {
    loading: "正在连接后端…",
    connected: "后端已连接 ✅",
    error: "后端连接失败 ❌",
  }[connectionState];

  return (
    <main className="flex min-h-screen items-center justify-center bg-background text-foreground">
      <p
        aria-live="polite"
        className={
          connectionState === "error"
            ? "text-sm text-red-600"
            : "text-sm text-muted-foreground"
        }
      >
        {statusText}
      </p>
    </main>
  );
}

