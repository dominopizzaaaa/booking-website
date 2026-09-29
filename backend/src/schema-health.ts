import type { PrismaClient } from '@prisma/client';

type SchemaProbe = {
  coachInvitations: boolean;
  packageScopeColumn: boolean;
  packageScopeTrigger: boolean;
  venueUnitIdentity: boolean;
  namedClubStaff: boolean;
  bookingSeries: boolean;
  venueAllocation: boolean;
  paymentProviderEvents: boolean;
  outboundDelivery: boolean;
  activeStripeBookingCheckoutGuard: boolean;
  paymentCompliance: boolean;
  guardianChildAccounts: boolean;
  childConsentAppendOnly: boolean;
  onePendingChildHandover: boolean;
  signupEvidence: boolean;
  privacyRequests: boolean;
  chatSafeguardingTables: boolean;
  chatSafeguardingPermissions: boolean;
  chatSafeguardingIndexes: boolean;
  chatSafeguardingTriggers: boolean;
  chatSafeguardingAssigneeIdentity: boolean;
};

export type SchemaHealth = { ready: boolean; missing: string[] };

/** Keep this probe intentionally small and tied to contracts used at runtime. */
export async function inspectSchema(client: PrismaClient): Promise<SchemaHealth> {
  const [probe] = await client.$queryRawUnsafe<SchemaProbe[]>(`
    SELECT
      to_regclass(current_schema() || '.\"CoachInvitation\"') IS NOT NULL AS \"coachInvitations\",
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'LessonPackage'
          AND column_name = 'scopeSnapshotSealed'
      ) AS \"packageScopeColumn\",
      EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass(current_schema() || '.\"LessonPackage\"')
          AND tgname = 'LessonPackage_scope_snapshot_seal'
          AND tgenabled <> 'D' AND NOT tgisinternal
      ) AS \"packageScopeTrigger\",
      to_regclass(current_schema() || '.\"VenueUnit_id_locationId_businessId_key\"') IS NOT NULL
        AS \"venueUnitIdentity\",
      to_regclass(current_schema() || '.\"ClubStaffAccess\"') IS NOT NULL AS \"namedClubStaff\",
      to_regclass(current_schema() || '.\"BookingSeries\"') IS NOT NULL AS \"bookingSeries\",
      to_regclass(current_schema() || '.\"VenueUnitAllocation\"') IS NOT NULL AS \"venueAllocation\",
      to_regclass(current_schema() || '.\"PaymentProviderEvent\"') IS NOT NULL AS \"paymentProviderEvents\",
      to_regclass(current_schema() || '.\"OutboundDelivery\"') IS NOT NULL AS \"outboundDelivery\",
      to_regclass(current_schema() || '.\"PaymentIntent_one_active_stripe_booking_checkout\"') IS NOT NULL
        AS \"activeStripeBookingCheckoutGuard\",
      (
        SELECT count(*) = 7 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'Business'
          AND column_name IN ('legalName', 'registrationNumber', 'supportEmail',
            'supportAddress', 'gstRegistrationStatus', 'gstRegistrationNumber', 'pricesIncludeGst')
      ) AND (
        SELECT count(*) = 13 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'PaymentIntent'
          AND column_name IN ('acceptedAt', 'acceptedTermsVersion', 'acceptedTermsHash',
            'acceptedCancellationPolicyVersion', 'acceptedCancellationPolicyHash',
            'acceptedPackageTermsVersion', 'acceptedPackageTermsHash', 'acceptedReviewHash',
            'acceptanceSessionFingerprint', 'acceptanceRequestFingerprint',
            'acceptanceEvidenceVersion', 'providerChargeReference', 'authenticationEvidence')
      ) AND EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass(current_schema() || '.\"PaymentIntent\"')
          AND tgname = 'PaymentIntent_checkout_evidence_immutability'
          AND tgenabled <> 'D' AND NOT tgisinternal
      ) AND EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass(current_schema() || '.\"Business\"')
          AND conname = 'Business_merchant_identity_shape_check'
          AND contype = 'c' AND convalidated
      ) AND EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass(current_schema() || '.\"PaymentIntent\"')
          AND conname = 'PaymentIntent_checkout_evidence_shape_check'
          AND contype = 'c' AND convalidated
      ) AND to_regclass(current_schema() || '.\"PaymentRiskCase\"') IS NOT NULL
        AND to_regclass(current_schema() || '.\"PaymentRiskCase_businessId_status_responseDueAt_idx\"') IS NOT NULL
        AND to_regclass(current_schema() || '.\"PaymentRiskCase_provider_providerAccountReference_providerC_key\"') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass(current_schema() || '.\"PaymentRiskCase\"')
            AND conname = 'PaymentRiskCase_shape_check'
            AND contype = 'c' AND convalidated
        )
        AND EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass(current_schema() || '.\"PaymentRiskCase\"')
            AND conname = 'PaymentRiskCase_paymentIntentId_businessId_fkey'
            AND contype = 'f'
            AND confrelid = to_regclass(current_schema() || '.\"PaymentIntent\"')
            AND conkey = ARRAY[
              (SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass(current_schema() || '.\"PaymentRiskCase\"') AND attname = 'paymentIntentId' AND NOT attisdropped),
              (SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass(current_schema() || '.\"PaymentRiskCase\"') AND attname = 'businessId' AND NOT attisdropped)
            ]::SMALLINT[]
            AND confkey = ARRAY[
              (SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass(current_schema() || '.\"PaymentIntent\"') AND attname = 'id' AND NOT attisdropped),
              (SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass(current_schema() || '.\"PaymentIntent\"') AND attname = 'businessId' AND NOT attisdropped)
            ]::SMALLINT[]
        ) AS \"paymentCompliance\",
      to_regclass(current_schema() || '.\"GuardianChildLink\"') IS NOT NULL
        AND to_regclass(current_schema() || '.\"ChildConsentRecord\"') IS NOT NULL
        AND to_regclass(current_schema() || '.\"ChildAccountHandover\"') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'User'
            AND column_name = 'legalName'
            AND is_nullable = 'NO'
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'User'
            AND column_name = 'dateOfBirth'
            AND data_type = 'date'
        )
        AND (
          SELECT count(*) = 3 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'User'
            AND column_name IN ('accountControl', 'accountStatus', 'profileVisibility')
            AND is_nullable = 'NO'
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'User'
            AND column_name = 'email'
            AND is_nullable = 'YES'
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'Student'
            AND column_name = 'email'
            AND is_nullable = 'YES'
        )
        AND EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass(current_schema() || '.\"User\"')
            AND tgname = 'User_dateOfBirth_immutable'
            AND tgenabled <> 'D' AND NOT tgisinternal
        )
        AND EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass(current_schema() || '.\"ChildConsentRecord\"')
            AND tgname = 'ChildConsentRecord_account_shape_invariant'
            AND tgenabled <> 'D' AND NOT tgisinternal
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'ChildConsentRecord'
            AND column_name = 'sequence'
            AND is_nullable = 'NO'
        )
        AND to_regclass(current_schema() || '.\"ChildConsentRecord_linkId_sequence_key\"')
          IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass(current_schema() || '.\"ChildConsentRecord\"')
            AND tgname = 'ChildConsentRecord_sequence_assign'
            AND tgenabled <> 'D' AND NOT tgisinternal
        )
        AND EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass(current_schema() || '.\"ChildAccountHandover\"')
            AND tgname = 'ChildAccountHandover_history_delete_guard'
            AND tgenabled <> 'D' AND NOT tgisinternal
        ) AS \"guardianChildAccounts\",
      EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass(current_schema() || '.\"ChildConsentRecord\"')
          AND tgname = 'ChildConsentRecord_append_only'
          AND tgenabled <> 'D' AND NOT tgisinternal
      ) AND EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass(current_schema() || '.\"ChildConsentRecord\"')
          AND tgname = 'ChildConsentRecord_append_only_truncate'
          AND tgenabled <> 'D' AND NOT tgisinternal
      ) AS \"childConsentAppendOnly\",
      to_regclass(current_schema() || '.\"ChildAccountHandover_one_pending_per_child\"') IS NOT NULL
        AND to_regclass(current_schema() || '.\"ChildAccountHandover_one_pending_per_destination\"') IS NOT NULL
        AS \"onePendingChildHandover\",
      to_regclass(current_schema() || '.\"EmailVerificationClaim\"') IS NOT NULL
        AND to_regclass(current_schema() || '.\"EmailVerificationClaim_one_live_per_user\"') IS NOT NULL
        AND to_regclass(current_schema() || '.\"SignupAcceptanceEvidence\"') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'EmailVerificationClaim'
            AND column_name = 'tokenKeyId'
            AND is_nullable = 'NO'
        )
        AND (
          SELECT count(*) = 5 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'User'
            AND column_name IN ('termsAcceptedVersion', 'termsAcceptedAt',
              'privacyNoticeAcceptedVersion', 'privacyNoticeAcceptedAt', 'signupPolicySetHash')
        )
        AND EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass(current_schema() || '.\"User\"')
            AND tgname = 'User_signup_evidence_immutable'
            AND tgenabled <> 'D' AND NOT tgisinternal
        )
        AND EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass(current_schema() || '.\"SignupAcceptanceEvidence\"')
            AND tgname = 'SignupAcceptanceEvidence_append_only'
            AND tgenabled <> 'D' AND NOT tgisinternal
        )
        AND EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass(current_schema() || '.\"SignupAcceptanceEvidence\"')
            AND tgname = 'SignupAcceptanceEvidence_delete_guard'
            AND tgenabled <> 'D' AND NOT tgisinternal
        )
        AND EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass(current_schema() || '.\"SignupAcceptanceEvidence\"')
            AND tgname = 'SignupAcceptanceEvidence_append_only_truncate'
            AND tgenabled <> 'D' AND NOT tgisinternal
        ) AS \"signupEvidence\",
      to_regclass(current_schema() || '.\"PrivacyRequest\"') IS NOT NULL
        AND to_regclass(current_schema() || '.\"PrivacyRequestEvent\"') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass(current_schema() || '.\"PrivacyRequestEvent\"')
            AND tgname = 'PrivacyRequestEvent_append_only'
            AND tgenabled <> 'D' AND NOT tgisinternal
        )
        AND EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass(current_schema() || '.\"PrivacyRequestEvent\"')
            AND tgname = 'PrivacyRequestEvent_append_only_truncate'
            AND tgenabled <> 'D' AND NOT tgisinternal
        )
        AND EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass(current_schema() || '.\"PrivacyRequest\"')
            AND tgname = 'PrivacyRequest_contract_guard'
            AND tgenabled <> 'D' AND NOT tgisinternal
        ) AS \"privacyRequests\",
      to_regclass(current_schema() || '.\"ChatAccountBlock\"') IS NOT NULL
        AND to_regclass(current_schema() || '.\"ChatSafetyReport\"') IS NOT NULL
        AND to_regclass(current_schema() || '.\"ChatSafetyAuditEvent\"') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'User'
            AND column_name = 'safetyStatus'
            AND is_nullable = 'NO'
        ) AS \"chatSafeguardingTables\",
      \"_courtly_staff_permissions_valid\"(
        ARRAY['SAFEGUARDING_VIEW', 'SAFEGUARDING_REVIEW']::TEXT[]
      ) AS \"chatSafeguardingPermissions\",
      to_regclass(current_schema() || '.\"ChatAccountBlock_pkey\"') IS NOT NULL
        AND to_regclass(current_schema() || '.\"ChatAccountBlock_blockedUserId_idx\"') IS NOT NULL
        AND to_regclass(current_schema() || '.\"ChatSafetyReport_status_severity_createdAt_idx\"') IS NOT NULL
        AND to_regclass(current_schema() || '.\"ChatSafetyReport_businessId_status_createdAt_idx\"') IS NOT NULL
        AND to_regclass(current_schema() || '.\"ChatSafetyReport_assignee_status_createdAt_idx\"') IS NOT NULL
        AND to_regclass(current_schema() || '.\"ChatSafetyAuditEvent_reportId_createdAt_idx\"') IS NOT NULL
        AS \"chatSafeguardingIndexes\",
      EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass(current_schema() || '.\"ChatSafetyReport\"')
          AND tgname = 'ChatSafetyReport_contract_guard'
          AND tgenabled <> 'D' AND NOT tgisinternal
      ) AND EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass(current_schema() || '.\"ChatSafetyReport\"')
          AND tgname = 'ChatSafetyReport_decision_audit_guard'
          AND tgenabled <> 'D' AND NOT tgisinternal
      ) AND EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass(current_schema() || '.\"ChatSafetyReport\"')
          AND tgname = 'ChatSafetyReport_retained_truncate'
          AND tgenabled <> 'D' AND NOT tgisinternal
      ) AND EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass(current_schema() || '.\"ChatSafetyAuditEvent\"')
          AND tgname = 'ChatSafetyAuditEvent_append_only'
          AND tgenabled <> 'D' AND NOT tgisinternal
      ) AND EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass(current_schema() || '.\"ChatSafetyAuditEvent\"')
          AND tgname = 'ChatSafetyAuditEvent_append_only_truncate'
          AND tgenabled <> 'D' AND NOT tgisinternal
      ) AS \"chatSafeguardingTriggers\",
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'ChatSafetyReport'
          AND column_name = 'assignedClubUserId'
          AND data_type = 'text'
          AND is_nullable = 'YES'
      ) AND EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass(current_schema() || '.\"ChatSafetyReport\"')
          AND conname = 'ChatSafetyReport_assignedClubUserId_fkey'
          AND contype = 'f'
          AND confrelid = to_regclass(current_schema() || '.\"User\"')
          AND confdeltype = 'n'
          AND confupdtype = 'c'
          AND conkey = ARRAY[(
            SELECT attnum FROM pg_attribute
            WHERE attrelid = to_regclass(current_schema() || '.\"ChatSafetyReport\"')
              AND attname = 'assignedClubUserId' AND NOT attisdropped
          )]::SMALLINT[]
          AND confkey = ARRAY[(
            SELECT attnum FROM pg_attribute
            WHERE attrelid = to_regclass(current_schema() || '.\"User\"')
              AND attname = 'id' AND NOT attisdropped
          )]::SMALLINT[]
      ) AND EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass(current_schema() || '.\"ChatSafetyReport\"')
          AND conname = 'ChatSafetyReport_shape_check'
          AND contype = 'c'
          AND convalidated
      ) AND EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass(current_schema() || '.\"ChatSafetyReport\"')
          AND tgname = 'ChatSafetyReport_validate_assignee'
          AND tgenabled <> 'D' AND NOT tgisinternal
      ) AS \"chatSafeguardingAssigneeIdentity\"
  `);
  const checks: Array<[keyof SchemaProbe, string]> = [
    ['coachInvitations', 'CoachInvitation'],
    ['packageScopeColumn', 'LessonPackage.scopeSnapshotSealed'],
    ['packageScopeTrigger', 'LessonPackage scope seal'],
    ['venueUnitIdentity', 'VenueUnit composite identity'],
    ['namedClubStaff', 'named club staff access'],
    ['bookingSeries', 'booking series'],
    ['venueAllocation', 'venue unit allocation'],
    ['paymentProviderEvents', 'payment provider events'],
    ['outboundDelivery', 'outbound delivery'],
    ['activeStripeBookingCheckoutGuard', 'active Stripe booking checkout guard'],
    ['paymentCompliance', 'payment compliance schema'],
    ['guardianChildAccounts', 'guardian and child accounts'],
    ['childConsentAppendOnly', 'append-only child consent history'],
    ['onePendingChildHandover', 'pending child and destination handover guards'],
    ['signupEvidence', 'signup acceptance and email verification evidence'],
    ['privacyRequests', 'privacy request workflow'],
    ['chatSafeguardingTables', 'chat safeguarding tables'],
    ['chatSafeguardingPermissions', 'chat safeguarding staff permissions'],
    ['chatSafeguardingIndexes', 'chat safeguarding indexes'],
    ['chatSafeguardingTriggers', 'chat safeguarding retention triggers'],
    ['chatSafeguardingAssigneeIdentity', 'chat safeguarding assignee identity'],
  ];
  const missing = checks.filter(([key]) => !probe?.[key]).map(([, label]) => label);
  return { ready: missing.length === 0, missing };
}

export async function assertSchemaReady(client: PrismaClient) {
  const health = await inspectSchema(client);
  if (!health.ready) {
    throw new Error(`Database schema is out of date (${health.missing.join(', ')}). Run npm run db:migrate --prefix backend.`);
  }
}
