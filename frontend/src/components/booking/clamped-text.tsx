"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Long free text (a club description, a coach bio) clamped to a few lines with
 * a See more/Show less toggle. The toggle appears only when the text really overflows,
 * so short bios never offer a button that does nothing.
 */
export function ClampedText({
  text,
  className,
  describedBy,
}: {
  text: string;
  className?: string;
  /** Element naming whose text this is, so repeated "More" buttons keep their context. */
  describedBy?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, text]);
  return (
    <div>
      <p
        id={id}
        ref={ref}
        className={cn("whitespace-pre-line break-words", !expanded && "line-clamp-3", className)}
      >
        {text}
      </p>
      {(overflows || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          aria-describedby={describedBy}
          onClick={() => setExpanded((value) => !value)}
          className="!mt-1 inline-flex min-h-9 items-center rounded-md px-0.5 text-xs font-semibold text-[#2f5a43] underline underline-offset-2 hover:text-[#174c3c]"
        >
          {expanded ? "Show less" : "See more"}
        </button>
      )}
    </div>
  );
}
