import type { Metadata } from 'next';
import { PolicyDocument } from '@/components/legal/policy-document';

export const metadata: Metadata = { title: 'Terms of Service', description: 'The terms for accounts and use of the Courtly platform.' };
export default function TermsPage() { return <PolicyDocument policyKey="terms" />; }
