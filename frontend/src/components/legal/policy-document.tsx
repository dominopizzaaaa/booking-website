import Link from 'next/link';
import type { ReactNode } from 'react';
import policies from '@/content/policies.json';
import { loadLegalPublicationApproval } from '@/lib/legal-publication';
import { ContactBlock, PolicyCallout, PolicyPage, PolicySection, RolesTable } from './policy-page';

type PolicyKey = keyof typeof policies;
type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'roles' }
  | { kind: 'contact'; privacy?: boolean }
  | { kind: 'callout'; title: string; tone?: 'safety'; paragraphs: string[] };
type Policy = {
  key: string; title: string; summary: string; version: string; effectiveDate: string;
  sections: Array<{ id: string; title: string; blocks: Block[] }>;
};

function inlineContent(text: string) {
  const parts: Array<string | ReactNode> = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)/gu;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    const href = match[2];
    parts.push(href.startsWith('/')
      ? <Link key={`${match.index}:${href}`} href={href}>{match[1]}</Link>
      : <a key={`${match.index}:${href}`} href={href}>{match[1]}</a>);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function PolicyBlock({ block }: { block: Block }) {
  if (block.kind === 'paragraph') return <p>{inlineContent(block.text)}</p>;
  if (block.kind === 'list') return <ul>{block.items.map(item => <li key={item}>{inlineContent(item)}</li>)}</ul>;
  if (block.kind === 'roles') return <RolesTable />;
  if (block.kind === 'contact') return <ContactBlock privacy={'privacy' in block && block.privacy === true} />;
  return <PolicyCallout title={block.title} tone={'tone' in block && block.tone === 'safety' ? 'safety' : 'info'}>
    {block.paragraphs.map(paragraph => <p key={paragraph}>{inlineContent(paragraph)}</p>)}
  </PolicyCallout>;
}

export async function PolicyDocument({ policyKey }: { policyKey: PolicyKey }) {
  const policy = policies[policyKey] as Policy;
  const approved = await loadLegalPublicationApproval();
  const sections = policy.sections.map(section => ({ id: section.id, label: section.title }));
  return <PolicyPage title={policy.title} description={policy.summary} version={policy.version} approved={approved} sections={sections}>
    {policy.sections.map(section => <PolicySection key={section.id} id={section.id} title={section.title}>
      {section.blocks.map((block, index) => <PolicyBlock key={`${section.id}:${index}`} block={block} />)}
    </PolicySection>)}
  </PolicyPage>;
}
