import type { Metadata } from 'next';
import { PolicyDocument } from '@/components/legal/policy-document';

export const metadata: Metadata = { title: 'Acceptable Use & Safeguarding Policy', description: 'Courtly community conduct, child-safety expectations, prohibited use, and reporting.' };
export default function AcceptableUsePage() { return <PolicyDocument policyKey="acceptableUse" />; }
