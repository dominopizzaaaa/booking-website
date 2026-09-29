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
  guardianChildAccounts: boolean;
  childConsentAppendOnly: boolean;
  onePendingChildHandover: boolean;
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
          AND NOT tgisinternal
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
            AND NOT tgisinternal
        )
        AND EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass(current_schema() || '.\"ChildConsentRecord\"')
            AND tgname = 'ChildConsentRecord_account_shape_invariant'
            AND NOT tgisinternal
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
            AND NOT tgisinternal
        )
        AND EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass(current_schema() || '.\"ChildAccountHandover\"')
            AND tgname = 'ChildAccountHandover_history_delete_guard'
            AND NOT tgisinternal
        ) AS \"guardianChildAccounts\",
      EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass(current_schema() || '.\"ChildConsentRecord\"')
          AND tgname = 'ChildConsentRecord_append_only'
          AND NOT tgisinternal
      ) AND EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass(current_schema() || '.\"ChildConsentRecord\"')
          AND tgname = 'ChildConsentRecord_append_only_truncate'
          AND NOT tgisinternal
      ) AS \"childConsentAppendOnly\",
      to_regclass(current_schema() || '.\"ChildAccountHandover_one_pending_per_child\"') IS NOT NULL
        AND to_regclass(current_schema() || '.\"ChildAccountHandover_one_pending_per_destination\"') IS NOT NULL
        AS \"onePendingChildHandover\"
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
    ['guardianChildAccounts', 'guardian and child accounts'],
    ['childConsentAppendOnly', 'append-only child consent history'],
    ['onePendingChildHandover', 'pending child and destination handover guards'],
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
