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
});
