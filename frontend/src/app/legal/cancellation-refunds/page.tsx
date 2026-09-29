import type { Metadata } from 'next';
import { PolicyDocument } from '@/components/legal/policy-document';

export const metadata: Metadata = { title: 'Cancellation & Refund Policy', description: 'How Courtly Class and facility cancellation windows, credits, and refunds work.' };
export default function CancellationRefundsPage() { return <PolicyDocument policyKey="cancellationRefunds" />; }
