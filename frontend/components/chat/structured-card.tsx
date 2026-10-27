import { Braces } from "lucide-react";

import type { StructuredCardData } from "@/lib/chat-types";

export function StructuredCard({ data }: { data: StructuredCardData }) {
  return (
    <div className="my-3 overflow-hidden rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 to-white">
      <div className="flex items-center gap-2 border-b border-violet-100 px-4 py-3">
        <span className="grid size-8 place-items-center rounded-lg bg-violet-600 text-white">
          <Braces size={16} />
        </span>
        <div>
          <p className="text-sm font-semibold text-violet-950">{data.title}</p>
          <p className="text-[11px] text-violet-600">已通过 JSON Schema 校验</p>
        </div>
        <span className="ml-auto rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-violet-700 shadow-sm">
          置信度 {Math.round(data.confidence * 100)}%
        </span>
      </div>
      <div className="space-y-3 p-4 text-sm text-slate-700">
        <p>{data.summary}</p>
        <ul className="space-y-1.5">
          {data.key_points.map((point) => (
            <li key={point} className="flex gap-2">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-violet-500" />
              <span>{point}</span>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-1.5">
          {data.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700"
            >
              #{tag}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

