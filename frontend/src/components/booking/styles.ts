// Shared visual language of the public booking page (/book/[slug]) and the
// components it is composed from.
export const button =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#174c3c] px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#103d2f] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none";
export const secondary =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#dce3da] bg-white px-4 py-2.5 text-sm font-medium text-[#344d40] transition hover:border-[#bdcbbb] hover:bg-[#f3f6f1] disabled:cursor-not-allowed disabled:opacity-40";
export const field =
  "!min-h-12 !rounded-xl !border-[#dfe5df] !px-3.5 !text-base sm:!text-sm";
export const panel =
  "min-w-0 rounded-2xl border border-[#e5e9e4] bg-white [&_*]:min-w-0 [&_p]:break-words [&_a]:min-h-11";
/** Secondary copy that keeps WCAG AA contrast on white and the pale greens. */
export const quietText = "text-[#59675c]";
