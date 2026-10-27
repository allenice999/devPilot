import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const edgePath =
  process.env.EDGE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const outputDir = process.argv[2];
const port = 9333;
const profileDir = path.join(os.tmpdir(), `devpilot-ui-smoke-${Date.now()}`);

if (!outputDir) {
  throw new Error("Usage: node scripts/verify-ui.mjs <output-directory>");
}

await mkdir(outputDir, { recursive: true });

const browser = spawn(
  edgePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ],
  { stdio: "ignore", windowsHide: true },
);

async function waitForDebugger() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        return;
      }
    } catch {
      // Browser is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Edge remote debugger did not start");
}

async function openTarget(url) {
  const response = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" },
  );
  if (!response.ok) {
    throw new Error(`Could not create browser target: HTTP ${response.status}`);
  }
  return response.json();
}

async function connect(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });

  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) {
      return;
    }
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      reject(new Error(message.error.message));
    } else {
      resolve(message.result);
    }
  };

  function send(method, params = {}) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  }

  return { socket, send };
}

async function waitForText(send, expected, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await send("Runtime.evaluate", {
      expression: "document.body?.innerText ?? ''",
      returnByValue: true,
    });
    const text = result.result?.value ?? "";
    if (expected.every((item) => text.includes(item))) {
      return text;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for UI text: ${expected.join(", ")}`);
}

const cases = [
  {
    name: "week2-empty-final",
    url: "http://127.0.0.1:3000",
    expected: ["开始一段流式对话"],
  },
  {
    name: "week2-weather-final",
    url: "http://127.0.0.1:3000/?demo=weather",
    expected: ["天气工具", "已完成", "晴间多云", "重新生成"],
  },
  {
    name: "week2-structured-final",
    url: "http://127.0.0.1:3000/?demo=structured",
    expected: ["已通过 JSON Schema 校验", "请求通过 FastAPI 建立 SSE 流"],
  },
];

try {
  await waitForDebugger();

  for (const testCase of cases) {
    const target = await openTarget(testCase.url);
    const { socket, send } = await connect(target.webSocketDebuggerUrl);

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const text = await waitForText(send, testCase.expected);
    const screenshot = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const outputPath = path.join(outputDir, `${testCase.name}.png`);
    await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));

    socket.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
    console.log(`PASS ${testCase.name}: ${text.length} rendered chars`);
  }
} finally {
  browser.kill();
}

