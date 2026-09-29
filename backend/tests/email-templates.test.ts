import { describe, expect, it } from 'vitest';
import { renderTransactionalEmail } from '../src/email-templates.js';

describe('transactional email templates', () => {
  it('renders accessible text and HTML while escaping user content', () => {
    const result = renderTransactionalEmail({ eventType: 'BOOKING_CONFIRMED', recipientName: '<Avery>', title: 'Booking <confirmed>', message: 'Court & coach', actionUrl: 'https://courtly.test/manage?tab=home&x=1', actionLabel: 'View booking' });
    expect(result.text).toContain('View booking: https://courtly.test/manage?tab=home&x=1');
    expect(result.html).toContain('Hi &lt;Avery&gt;,');
    expect(result.html).toContain('Booking &lt;confirmed&gt;');
    expect(result.html).toContain('Court &amp; coach');
    expect(result.html).not.toContain('<Avery>');
  });

  it('renders a security-specific family handover with its claim URL and expiry', () => {
    const result = renderTransactionalEmail({
      eventType: 'FAMILY_HANDOVER_SECURITY', recipientName: 'Rowan & Casey',
      claimUrl: 'https://courtly.test/family/claim?token=one&next=two',
      expiresAt: '2026-10-02T09:30:00.000Z',
    });
    expect(result.subject).toBe('Complete your Courtly family profile handover');
    expect(result.text).toContain('2 Oct 2026');
    expect(result.text).toContain('Review family handover: https://courtly.test/family/claim?token=one&next=two');
    expect(result.text).toContain('This is a security message');
    expect(result.html).toContain('Hi Rowan &amp; Casey,');
    expect(result.html).toContain('token=one&amp;next=two');
    expect(result.html).toContain('Never share this claim link.');
    expect(result.html).not.toContain('This is a transactional message');
  });
});
