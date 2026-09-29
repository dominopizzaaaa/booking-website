import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import policies from '../src/content/policies.json';
import {
  COURTLY_CONTACT_EMAIL,
  CURRENT_CHILD_PRIVACY_NOTICE_VERSION,
  CURRENT_PRIVACY_NOTICE_VERSION,
  CURRENT_TERMS_VERSION,
  POLICY_CONTENT_HASHES,
  POLICY_DOCUMENTS,
  POLICY_EFFECTIVE_DATE,
  CURRENT_LEGAL_POLICY_SET_HASH,
} from '../src/lib/policies';
import { isExactLegalPublicationApproval } from '../src/lib/legal-publication';

describe('public policy contract', () => {
  it('publishes one complete, versioned policy set at stable paths', () => {
    expect(POLICY_DOCUMENTS.map(document => document.path)).toEqual([
      '/legal/privacy', '/legal/child-privacy', '/legal/terms',
      '/legal/acceptable-use', '/legal/cancellation-refunds', '/legal/package-terms',
    ]);
    expect(new Set(POLICY_DOCUMENTS.map(document => document.path)).size).toBe(POLICY_DOCUMENTS.length);
    expect(Object.keys(policies).sort()).toEqual(POLICY_DOCUMENTS.map(document => document.key).sort());
    for (const document of POLICY_DOCUMENTS) {
      expect(policies[document.key]).toMatchObject({
        key: document.key, title: document.title, version: document.version, effectiveDate: POLICY_EFFECTIVE_DATE,
      });
      expect(policies[document.key].sections.length).toBeGreaterThan(0);
    }
  });

  it('keeps signup and guardian-facing versions aligned with their notices', () => {
    expect(CURRENT_TERMS_VERSION).toBe(policies.terms.version);
    expect(CURRENT_PRIVACY_NOTICE_VERSION).toBe(policies.privacy.version);
    expect(CURRENT_CHILD_PRIVACY_NOTICE_VERSION).toBe(policies.childPrivacy.version);
  });

  it('pins every canonical document to its content-derived SHA-256 hash', () => {
    for (const document of POLICY_DOCUMENTS) {
      const actual = createHash('sha256').update(JSON.stringify(policies[document.key])).digest('hex');
      expect(POLICY_CONTENT_HASHES[document.key]).toBe(actual);
    }
    const policySet = Object.fromEntries(Object.entries(policies).map(([key, policy]) => [
      key, { version: policy.version, hash: createHash('sha256').update(JSON.stringify(policy)).digest('hex') },
    ]));
    expect(CURRENT_LEGAL_POLICY_SET_HASH).toBe(
      createHash('sha256').update(JSON.stringify(policySet)).digest('hex'),
    );
  });

  it('qualifies unresolved commercial roles and labels age thresholds as product rules', () => {
    const content = JSON.stringify(policies);
    expect(content).toContain('one-year period before the request');
    expect(content).toContain('Under Courtly’s current product rules');
    expect(content).toContain('Under Courtly’s product rules');
    expect(content).toContain('do not by themselves decide the contracting seller');
    expect(content).toContain('does not decide who legally owes a refund');
    expect(content).not.toContain('The identified club—not Courtly—offers and delivers');
    expect(content).not.toContain('Ask the selling club');
    expect(content).not.toContain('is responsible for service delivery and any money refund owed');
  });

  it('keeps legal pages in review-draft language until exact backend approval', () => {
    const indexSource = readFileSync(join(process.cwd(), 'src', 'app', 'legal', 'page.tsx'), 'utf8');
    const pageSource = readFileSync(
      join(process.cwd(), 'src', 'components', 'legal', 'policy-page.tsx'), 'utf8',
    );
    expect(indexSource).toContain('Policy set under review');
    expect(indexSource).toContain('exact version and content hash');
    expect(pageSource).toContain(`approved ? 'Effective' : 'Proposed effective date'`);
    expect(pageSource).toContain(`approved ? 'Approved current policy' : 'Review draft; production acceptance is closed'`);
    expect(pageSource).not.toContain('Offers and delivers the Class');
  });

  it('accepts publication state only for an exact approved version and set hash', () => {
    expect(isExactLegalPublicationApproval({ legalPublication: {
      approved: true, version: POLICY_EFFECTIVE_DATE, contentHash: CURRENT_LEGAL_POLICY_SET_HASH,
    } })).toBe(true);
    expect(isExactLegalPublicationApproval({ legalPublication: {
      approved: true, version: POLICY_EFFECTIVE_DATE, contentHash: '0'.repeat(64),
    } })).toBe(false);
    expect(isExactLegalPublicationApproval({ legalPublication: {
      approved: false, version: POLICY_EFFECTIVE_DATE, contentHash: CURRENT_LEGAL_POLICY_SET_HASH,
    } })).toBe(false);
  });

  it('includes the supplied Data Protection contact and no placeholder legal identity', () => {
    const content = JSON.stringify(policies);
    expect(COURTLY_CONTACT_EMAIL).toBe('domksj23@gmail.com');
    expect(content).toContain(COURTLY_CONTACT_EMAIL);
    expect(content).not.toMatch(/\b(?:TBD|TODO|INSERT|PLACEHOLDER)\b/i);
  });

  it('keeps every internal policy link on a published route', () => {
    const published = new Set(POLICY_DOCUMENTS.map(document => document.path));
    const links = JSON.stringify(policies).match(/\]\((\/legal\/[^)]+)\)/g) ?? [];
    for (const link of links) expect(published.has(link.slice(2, -1) as never)).toBe(true);
  });

  it('keeps the canonical source server-safe and policy pages free of client directives', () => {
    const policyDir = join(process.cwd(), 'src', 'app', 'legal');
    const routeSources = POLICY_DOCUMENTS.map(document =>
      readFileSync(join(policyDir, document.path.replace('/legal/', ''), 'page.tsx'), 'utf8'),
    );
    expect(routeSources.every(source => !source.includes(`'use client'`) && !source.includes(`"use client"`))).toBe(true);
  });

  it('does not make an exclusive coach-only contact-data promise during embedded signup', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'components', 'public-booking.tsx'), 'utf8');
    expect(source).not.toContain('shared only with the coaches you book');
    expect(source).toContain('handled as described in the Privacy Notice');
  });
});
