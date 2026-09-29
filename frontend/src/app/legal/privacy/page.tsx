import type { Metadata } from 'next';
import { PolicyDocument } from '@/components/legal/policy-document';

export const metadata: Metadata = { title: 'Privacy Notice', description: 'How Courtly handles personal data and the choices available to you.' };
export default function PrivacyPage() { return <PolicyDocument policyKey="privacy" />; }
