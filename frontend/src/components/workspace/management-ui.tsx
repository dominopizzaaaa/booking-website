'use client';

import { useId, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { Loader2, Plus, Sprout, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { mutate } from '@/lib/api';
import type { Workspace } from '@/lib/types';
import { cn } from '@/lib/utils';

export type ManagementProps = { data: Workspace; refresh: () => Promise<void> };
export const text = (form: FormData, key: string) => String(form.get(key) || '').trim();
export const numeric = (form: FormData, key: string) => Number(form.get(key));
export function cents(value: string | number) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(Math.round(amount * 100))) throw new Error('Enter a valid non-negative amount in SGD.');
  return Math.round(amount * 100);
}
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Unable to save. Please try again.';

export function PageHeading({ title, description, action, actionLabel }: { title: string; description: string; action?: () => void; actionLabel?: string }) {
  return <header className="section-heading flex-wrap border-b border-[#e7ebe2] pb-5 sm:pb-6"><div className="min-w-0"><p className="eyebrow mb-2.5">A little more organised</p><h1 className="text-balance text-[#173f2f]">{title}</h1><p className="muted mt-2.5 max-w-2xl text-[13px] leading-relaxed">{description}</p></div>{action && <Button onClick={action} className="shrink-0 shadow-sm max-sm:w-full"><Plus size={15} />{actionLabel || 'Add new'}</Button>}</header>;
}

export function Empty({ title, children, icon: Icon = Sprout, action }: { title: string; children: ReactNode; icon?: LucideIcon; action?: ReactNode }) {
  return <div className="empty-state flex min-h-48 flex-col items-center justify-center"><span className="mb-3 grid h-11 w-11 place-items-center rounded-2xl bg-[#f0f4ea] text-[#819477]"><Icon size={23} strokeWidth={1.5} /></span><h3 className="mb-1.5 text-sm text-[#405941]">{title}</h3><div className="mx-auto max-w-md text-pretty">{children}</div>{action && <div className="mt-5">{action}</div>}</div>;
}

export function Field({ label, name, wide, hint, children, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; name: string; wide?: boolean; hint?: string; children?: ReactNode }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return <div className={wide ? 'field-wide' : undefined}><label htmlFor={children ? name : id}>{label}{props.required && <span className="ml-1 text-[#88957e]" aria-hidden="true">*</span>}</label>{children || <input id={id} name={name} aria-describedby={hintId} {...props} />}{hint && <p id={hintId} className="mt-2 text-[11px] leading-relaxed text-stone-500">{hint}</p>}</div>;
}

export function CheckField({ label, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const id = useId();
  return <label htmlFor={id} className="mb-0 flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-[#e1e7dc] bg-[#fafbf8] p-3.5 transition-colors hover:bg-[#f6f8f2]"><input id={id} type="checkbox" className="mt-0.5 shrink-0" {...props} /><span className="text-xs font-medium text-[#344b39]">{label}{hint && <span className="mt-1 block text-[11px] font-normal leading-relaxed text-stone-500">{hint}</span>}</span></label>;
}

export function Editor({ title, description, children, onClose, onSubmit, refresh, submitLabel = 'Save changes', success = 'Changes saved', disabled = false, wide = false }: { title: string; description: string; children: ReactNode; onClose: () => void; onSubmit: (form: FormData) => Promise<unknown>; refresh: () => Promise<void>; submitLabel?: string; success?: string; disabled?: boolean; wide?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true); setError('');
    try {
      await onSubmit(form);
      toast.success(success);
      try { await refresh(); } catch (cause) { toast.error(`Saved, but the workspace could not refresh. Reload before making another change. ${errorMessage(cause)}`); }
      onClose();
    } catch (cause) { const message = errorMessage(cause); setError(message); toast.error(message); }
    finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className={cn('p-0 max-sm:top-auto max-sm:bottom-0 max-sm:max-h-[92dvh] max-sm:w-full max-sm:translate-y-0 max-sm:rounded-b-none', wide && 'max-w-2xl')} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}><div className="px-5 pt-5 sm:px-6 sm:pt-6"><DialogTitle className="pr-8 text-xl font-semibold tracking-tight text-[#173f2f]">{title}</DialogTitle><DialogDescription className="mt-2 text-xs leading-relaxed text-stone-500">{description}</DialogDescription></div><form onSubmit={submit} className="mt-5"><div className="px-5 sm:px-6"><fieldset disabled={busy} className="min-w-0 space-y-5">{children}</fieldset>{error && <p role="alert" aria-live="polite" className="mt-4 rounded-lg bg-red-50 p-3 text-xs leading-relaxed text-red-700">{error}</p>}</div><div className="sticky bottom-0 mt-6 flex justify-end gap-2 border-t border-[#e7ebe2] bg-white/95 px-5 py-4 backdrop-blur sm:px-6"><Button type="button" variant="outline" onClick={onClose} disabled={busy} className="max-sm:flex-1">Cancel</Button><Button type="submit" disabled={busy || disabled} className="max-sm:flex-1">{busy && <Loader2 size={15} className="animate-spin" />}{busy ? 'Saving…' : submitLabel}</Button></div></form></DialogContent></Dialog>;
}

export function Stat({ label, value, detail, icon: Icon }: { label: string; value: ReactNode; detail: string; icon: LucideIcon }) {
  return <article className="stat-card flex min-h-36 flex-col"><div className="flex items-start justify-between gap-2"><p className="text-[11px] font-medium leading-snug text-[#69766c]">{label}</p><span className="stat-icon shrink-0"><Icon size={15} /></span></div><div className="stat-value text-[#254b38]">{value}</div><p className="mt-auto text-[10px] leading-relaxed text-[#8a9482]">{detail}</p></article>;
}

export function useManagementAction(refresh: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  async function run(path: string, method: 'POST' | 'PATCH' | 'DELETE', values: unknown, success: string) {
    if (busy) return;
    setBusy(true);
    try { await mutate(path, method, values); await refresh(); toast.success(success); }
    catch (error) { toast.error(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return { busy, run };
}

export function StateBadge({ active }: { active: boolean }) { return <span className={cn('badge gap-1.5', !active && 'bg-stone-100! text-stone-500!')}><i className={cn('h-1.5 w-1.5 rounded-full bg-[#789568]', !active && 'bg-stone-400')} aria-hidden="true" />{active ? 'Active' : 'Archived'}</span>; }
