import { CloudSun, LoaderCircle, Wrench } from "lucide-react";

import type { ToolCallView } from "@/lib/chat-types";

export function ToolCard({ tool }: { tool: ToolCallView }) {
  const isWeather = tool.name === "get_weather";
  const source = tool.result?.source;
  const sourceLabel =
    typeof source === "string" ? source : source == null ? "" : String(source);

  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-sky-200 bg-sky-50/80">
      <div className="flex items-center gap-2 border-b border-sky-200/80 px-3 py-2 text-xs font-medium text-sky-800">
        {isWeather ? <CloudSun size={15} /> : <Wrench size={15} />}
        <span>{isWeather ? "天气工具" : tool.name}</span>
        <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-normal">
          {tool.status === "running" ? (
            <>
              <LoaderCircle size={12} className="animate-spin" />
              调用中
            </>
          ) : (
            "已完成"
          )}
        </span>
      </div>

      <div className="space-y-2 px-3 py-3 text-xs text-slate-700">
        <div>
          <span className="text-slate-500">入参：</span>
          <code>{JSON.stringify(tool.input)}</code>
        </div>
        {tool.result && (
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(tool.result)
              .filter(([key]) => key !== "source")
              .map(([key, value]) => (
                <div key={key} className="rounded-lg bg-white/80 px-2.5 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">
                    {key}
                  </div>
                  <div className="mt-0.5 font-medium text-slate-800">
                    {String(value)}
                  </div>
                </div>
              ))}
          </div>
        )}
        {sourceLabel && (
          <p className="text-[11px] text-sky-700">{sourceLabel}</p>
        )}
      </div>
    </div>
  );
}

