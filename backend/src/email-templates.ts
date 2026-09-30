export type TransactionalEmailEvent =
  | 'BOOKING_CREATED' | 'BOOKING_REQUESTED' | 'BOOKING_PENDING' | 'BOOKING_CONFIRMED'
  | 'BOOKING_COMPLETED' | 'BOOKING_CANCELLED' | 'BOOKING_ASSIGNED'
  | 'BOOKING_RESCHEDULED' | 'RESCHEDULE_REQUESTED' | 'RESCHEDULE_ACCEPTED'
  | 'RESCHEDULE_DECLINED' | 'RESCHEDULE_WITHDRAWN' | 'BOOKING_REMINDER'
  | 'COACH_ASSIGNED' | 'COACH_DECLINED' | 'PAYMENT_RECORDED' | 'PAYMENT_REVERSED'
  | 'PACKAGE_PURCHASED' | 'RENTAL_CONFIRMED' | 'RENTAL_CANCELLED' | 'COACH_INVITED'
  | 'PAYMENT_RECEIPT' | 'FAMILY_HANDOVER_SECURITY' | 'EMAIL_VERIFICATION' | 'PASSWORD_RESET'
  | 'EMAIL_CHANGE_VERIFICATION' | 'ACCOUNT_SECURITY_NOTICE';

type TransactionalEmailTemplatePayload = {
  eventType: TransactionalEmailEvent;
  recipientName: string;
  title: string;
  message: string;
  actionUrl?: string;
  actionLabel?: string;
};

export type FamilyHandoverSecurityEmailTemplatePayload = {
  eventType: 'FAMILY_HANDOVER_SECURITY';
  recipientName: string;
  claimUrl: string;
  expiresAt: Date | string;
};

export type EmailVerificationSecurityEmailTemplatePayload = {
  eventType: 'EMAIL_VERIFICATION';
  recipientName: string;
  verificationUrl: string;
  expiresAt: Date | string;
};

export type PasswordResetSecurityEmailTemplatePayload = {
  eventType: 'PASSWORD_RESET'; recipientName: string; resetUrl: string; expiresAt: Date | string;
};

export type EmailChangeSecurityEmailTemplatePayload = {
  eventType: 'EMAIL_CHANGE_VERIFICATION'; recipientName: string; confirmationUrl: string; expiresAt: Date | string;
};

// The generic member remains worker-compatible with already persisted
// deliveries. New family handovers can instead use the security-specific
// member so the claim URL and expiry are required at the template boundary.
export type EmailTemplatePayload = TransactionalEmailTemplatePayload
  | FamilyHandoverSecurityEmailTemplatePayload
  | EmailVerificationSecurityEmailTemplatePayload
  | PasswordResetSecurityEmailTemplatePayload
  | EmailChangeSecurityEmailTemplatePayload;

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));

function securityExpiry(value: Date | string, label: string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} expiry must be a valid date`);
  return `${new Intl.DateTimeFormat('en-SG', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
  }).format(date)} UTC`;
}

export function renderTransactionalEmail(payload: EmailTemplatePayload) {
  const securityPayload = payload.eventType === 'FAMILY_HANDOVER_SECURITY' && 'claimUrl' in payload;
  const verificationPayload = payload.eventType === 'EMAIL_VERIFICATION' && 'verificationUrl' in payload;
  const passwordResetPayload = payload.eventType === 'PASSWORD_RESET' && 'resetUrl' in payload;
  const emailChangePayload = payload.eventType === 'EMAIL_CHANGE_VERIFICATION' && 'confirmationUrl' in payload;
  const content = securityPayload
    ? {
      title: 'Complete your Courtly family profile handover',
      message: `You have been invited to take over management of a child profile. This secure claim link expires ${securityExpiry(payload.expiresAt, 'Family handover')}. If you did not expect this handover, ignore this email.`,
      actionUrl: payload.claimUrl,
      actionLabel: 'Review family handover',
    }
    : verificationPayload
      ? {
        title: 'Verify your Courtly email',
        message: `Confirm this address to use privacy-sensitive account features. This secure link expires ${securityExpiry(payload.expiresAt, 'Email verification')}. If you did not create this account, ignore this email.`,
        actionUrl: payload.verificationUrl,
        actionLabel: 'Verify email',
      }
      : passwordResetPayload
        ? {
          title: 'Reset your Courtly password',
          message: `Use this secure link to choose a new password. It expires ${securityExpiry(payload.expiresAt, 'Password reset')}. If you did not request this, ignore this email.`,
          actionUrl: payload.resetUrl, actionLabel: 'Reset password',
        }
        : emailChangePayload
          ? {
            title: 'Confirm your new Courtly email',
            message: `Verify this address to finish changing your Courtly sign-in email. This secure link expires ${securityExpiry(payload.expiresAt, 'Email change')}. If you did not request this, ignore this email.`,
            actionUrl: payload.confirmationUrl, actionLabel: 'Confirm new email',
          }
          : payload;
  const greeting = payload.recipientName.trim() ? `Hi ${payload.recipientName.trim()},` : 'Hello,';
  const actionText = content.actionLabel?.trim() || 'Open Courtly';
  const text = [greeting, '', content.title, content.message, content.actionUrl ? '' : null]
    .filter((line): line is string => line !== null);
  if (content.actionUrl) text.push(`${actionText}: ${content.actionUrl}`);
  const footer = payload.eventType === 'FAMILY_HANDOVER_SECURITY'
    ? 'This is a security message about access to a Courtly family profile. Never share this claim link.'
    : ['EMAIL_VERIFICATION', 'PASSWORD_RESET', 'EMAIL_CHANGE_VERIFICATION'].includes(payload.eventType)
      ? 'This is a security message about your Courtly account. Never share this secure link.'
      : 'This is a transactional message about your Courtly account.';
  text.push('', footer);
  const action = content.actionUrl
    ? `<p><a href="${escapeHtml(content.actionUrl)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#174c3c;color:#fff;text-decoration:none;font-weight:600">${escapeHtml(actionText)}</a></p>`
    : '';
  return {
    subject: content.title,
    text: text.join('\n'),
    html: `<!doctype html><html lang="en"><body style="margin:0;background:#f6f7f4;color:#1c3029;font-family:Arial,sans-serif"><main style="max-width:600px;margin:auto;padding:32px 20px"><p>${escapeHtml(greeting)}</p><h1 style="font-size:24px;line-height:1.3">${escapeHtml(content.title)}</h1><p style="font-size:16px;line-height:1.6">${escapeHtml(content.message)}</p>${action}<p style="margin-top:32px;font-size:14px;color:#59675c">${escapeHtml(footer)}</p></main></body></html>`,
  };
}
