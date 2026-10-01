import { ChevronDown } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

type SeeMoreButtonProps = {
  expanded: boolean;
  onToggle: () => void;
  controls: string;
  hiddenCount?: number;
  noun?: string;
  collapsedLabel?: string;
  className?: string;
};

function singularNoun(noun: string) {
  if (noun.endsWith('sses')) return noun.slice(0, -2);
  if (/(?:ches|shes|xes|zes)$/u.test(noun)) return noun.slice(0, -2);
  if (noun.endsWith('ies')) return `${noun.slice(0, -3)}y`;
  return noun.endsWith('s') ? noun.slice(0, -1) : noun;
}

/** One quiet, consistent control for bounded lists across Courtly. */
export function SeeMoreButton({
  expanded,
  onToggle,
  controls,
  hiddenCount,
  noun = 'items',
  collapsedLabel,
  className,
}: SeeMoreButtonProps) {
  const moreLabel = collapsedLabel ?? (hiddenCount && hiddenCount > 0
    ? `See ${hiddenCount} more ${hiddenCount === 1 ? singularNoun(noun) : noun}`
    : 'See more');
  return <button
    type="button"
    aria-expanded={expanded}
    aria-controls={controls}
    onClick={onToggle}
    className={cn(
      'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-semibold text-[#365c43] transition hover:bg-[#f0f4ec] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a] focus-visible:ring-offset-2',
      className,
    )}
  >
    {expanded ? 'Show less' : moreLabel}
    <ChevronDown size={14} aria-hidden="true" className={cn('transition-transform', expanded && 'rotate-180')} />
  </button>;
}

type DisclosureProps = {
  title: string;
  summary?: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  defaultOpen?: boolean;
};

/**
 * Secondary context stays one tap away without competing with the primary
 * decision. Native details preserves keyboard and screen-reader behaviour.
 */
export function Disclosure({
  title,
  summary,
  children,
  className,
  contentClassName,
  defaultOpen = false,
}: DisclosureProps) {
  const labelId = useId();
  return <details open={defaultOpen} role="region" aria-labelledby={labelId} className={cn('group rounded-xl border border-[#e2e7df] bg-[#fafbf8]', className)}>
    <summary id={labelId} className="flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-xl px-4 py-3 text-left marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a] focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold text-[#344b39]">{title}</span>
        {summary && <span className="mt-0.5 block text-[11px] leading-relaxed text-[#59675c]">{summary}</span>}
      </span>
      <span className="shrink-0 text-[11px] font-semibold text-[#45674f]">
        <span className="group-open:hidden">See more</span>
        <span className="hidden group-open:inline">Show less</span>
      </span>
      <ChevronDown size={15} aria-hidden="true" className="shrink-0 text-[#607064] transition-transform group-open:rotate-180" />
    </summary>
    <div className={cn('border-t border-[#e7ebe3] px-4 py-4', contentClassName)}>{children}</div>
  </details>;
}
