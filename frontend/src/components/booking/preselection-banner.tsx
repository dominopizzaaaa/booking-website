"use client";

import { RefreshCw, Search, X } from "lucide-react";

/** Explains what a "Book again" or search link filled in; dismissible, never blocking. */
export function PreselectionBanner({
  title,
  text,
  kind,
  onDismiss,
}: {
  title: string;
  text: string;
  kind: "REBOOK" | "SEARCH";
  onDismiss: () => void;
}) {
  const Icon = kind === "REBOOK" ? RefreshCw : Search;
  return (
    <div
      role="status"
      className="!mb-5 flex items-start gap-3 rounded-2xl border border-[#d3e0c8] bg-[#eef5e6] p-3.5 sm:!mb-7 sm:p-4"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#dfead3] text-[#3f6a35]">
        <Icon size={16} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-[#253c31]">{title}</p>
        <p className="!mt-1 break-words text-xs leading-relaxed text-[#3d5043]">{text}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={`Dismiss ${title.toLowerCase()} message`}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-[#3d5043] transition hover:bg-[#dfead3]"
      >
        <X size={17} aria-hidden="true" />
      </button>
    </div>
  );
}
