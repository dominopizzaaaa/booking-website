export type TransactionalEmailEvent =
  | 'BOOKING_CREATED' | 'BOOKING_REQUESTED' | 'BOOKING_PENDING' | 'BOOKING_CONFIRMED'
  | 'BOOKING_COMPLETED' | 'BOOKING_CANCELLED' | 'BOOKING_ASSIGNED'
  | 'BOOKING_RESCHEDULED' | 'RESCHEDULE_REQUESTED' | 'RESCHEDULE_ACCEPTED'
  | 'RESCHEDULE_DECLINED' | 'RESCHEDULE_WITHDRAWN' | 'BOOKING_REMINDER'
  | 'COACH_ASSIGNED' | 'COACH_DECLINED' | 'PAYMENT_RECORDED' | 'PAYMENT_REVERSED'
  | 'PACKAGE_PURCHASED' | 'RENTAL_CONFIRMED' | 'RENTAL_CANCELLED' | 'COACH_INVITED';

export type EmailTemplatePayload = {
  eventType: TransactionalEmailEvent;
  recipientName: string;
  title: string;
  message: string;
  actionUrl?: string;
  actionLabel?: string;
};

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));

export function renderTransactionalEmail(payload: EmailTemplatePayload) {
  const greeting = payload.recipientName.trim() ? `Hi ${payload.recipientName.trim()},` : 'Hello,';
  const actionText = payload.actionLabel?.trim() || 'Open Courtly';
  const text = [greeting, '', payload.title, payload.message, payload.actionUrl ? '' : null]
    .filter((line): line is string => line !== null);
  if (payload.actionUrl) text.push(`${actionText}: ${payload.actionUrl}`);
  text.push('', 'This is a transactional message about your Courtly account.');
  const action = payload.actionUrl
    ? `<p><a href="${escapeHtml(payload.actionUrl)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#174c3c;color:#fff;text-decoration:none;font-weight:600">${escapeHtml(actionText)}</a></p>`
    : '';
  return {
    subject: payload.title,
    text: text.join('\n'),
    html: `<!doctype html><html lang="en"><body style="margin:0;background:#f6f7f4;color:#1c3029;font-family:Arial,sans-serif"><main style="max-width:600px;margin:auto;padding:32px 20px"><p>${escapeHtml(greeting)}</p><h1 style="font-size:24px;line-height:1.3">${escapeHtml(payload.title)}</h1><p style="font-size:16px;line-height:1.6">${escapeHtml(payload.message)}</p>${action}<p style="margin-top:32px;font-size:14px;color:#59675c">This is a transactional message about your Courtly account.</p></main></body></html>`,
  };
}
