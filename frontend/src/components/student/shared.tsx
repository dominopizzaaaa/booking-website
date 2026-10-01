import { Info, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { panel } from './styles';

export type Conflict = { date: string; reason: string };

export function ErrorNotice({ message, conflicts = [] }: { message: string; conflicts?: Conflict[] }) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-[#eedbd5] bg-[#fff7f3] p-4 text-sm leading-relaxed text-[#925541]"
    >
      <div className="flex items-start gap-2.5">
        <Info size={17} className="mt-0.5 shrink-0" />
        <span>{message}</span>
      </div>
      {conflicts.length > 0 && (
        <ul className="mt-3 space-y-2 pl-7">
          {conflicts.map((conflict, index) => (
            <li key={`${conflict.date}-${index}`}>
              <strong>{conflict.date}</strong> — {conflict.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  headingLevel = 2,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  return (
    <section className={cn(panel, 'px-6 py-10 text-center sm:px-10')}>
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-[#eef3e8] text-[#4f6847]">
        {icon}
      </span>
      <Heading className="!mt-5 text-xl font-semibold tracking-tight text-[#263e33]">{title}</Heading>
      <p className="mx-auto !mt-2 max-w-md text-sm leading-relaxed text-[#59675c]">{children}</p>
      {action && <div className="mt-6">{action}</div>}
    </section>
  );
}

export function LoadingScreen({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <div role="status" className={cn('flex flex-col items-center justify-center gap-4', compact ? 'min-h-32' : 'min-h-[55vh]')}>
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-[#e9f0e2] text-[#174c3c]">
        <LoaderCircle size={23} className="animate-spin" />
      </span>
      <p className="text-sm text-[#59675c]">{text}</p>
    </div>
  );
}
