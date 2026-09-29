import type { Metadata } from 'next';
import { PolicyDocument } from '@/components/legal/policy-document';

export const metadata: Metadata = { title: 'Package Terms', description: 'How club Packages and credits work in Courtly.' };
export default function PackageTermsPage() { return <PolicyDocument policyKey="packageTerms" />; }
