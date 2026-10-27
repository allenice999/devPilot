export interface SseEvent {
  event: string;
  data: unknown;
  id?: string;
}

type EventHandler = (event: SseEvent) => void;

export function createSseParser(onEvent: EventHandler) {
  let buffer = "";
  let eventName = "message";
  let eventId: string | undefined;
  let dataLines: string[] = [];

  function dispatch() {
    if (dataLines.length === 0) {
      return;
    }

    const rawData = dataLines.join("\n");
    let data: unknown = rawData;
    try {
      data = JSON.parse(rawData);
    } catch {
      // The UI protocol uses JSON, but keeping raw text makes the parser
      // compatible with ordinary SSE endpoints too.
    }

    onEvent({ event: eventName, data, id: eventId });
    eventName = "message";
    dataLines = [];
  }

  function processLine(line: string) {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) {
      return;
    }

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "event") {
      eventName = value || "message";
    } else if (field === "data") {
      dataLines.push(value);
    } else if (field === "id") {
      eventId = value;
    }
  }

  return {
    feed(chunk: string) {
      buffer += chunk;
      while (true) {
        const lineBreak = /\r\n|\r|\n/.exec(buffer);
        if (!lineBreak || lineBreak.index === undefined) {
          return;
        }

        const line = buffer.slice(0, lineBreak.index);
        buffer = buffer.slice(lineBreak.index + lineBreak[0].length);
        processLine(line);
      }
    },
    end() {
      if (buffer) {
        processLine(buffer);
        buffer = "";
      }
      dispatch();
    },
  };
}

export async function consumeSse(
  response: Response,
  onEvent: EventHandler,
): Promise<void> {
  if (!response.body) {
    throw new Error("浏览器没有收到可读取的响应流");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser(onEvent);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.feed(decoder.decode());
    parser.end();
  } finally {
    reader.releaseLock();
  }
}

