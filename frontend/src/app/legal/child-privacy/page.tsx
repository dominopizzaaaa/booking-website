import type { Metadata } from 'next';
import { PolicyDocument } from '@/components/legal/policy-document';

export const metadata: Metadata = { title: 'Child Privacy Notice', description: 'How Courtly handles child data, explained for children, young people, and guardians.' };
export default function ChildPrivacyPage() { return <PolicyDocument policyKey="childPrivacy" />; }
