import type { PrismaClient } from '@prisma/client';

type SchemaProbe = {
  coachInvitations: boolean;
  packageScopeColumn: boolean;
  packageScopeTrigger: boolean;
  venueUnitIdentity: boolean;
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
        AS \"venueUnitIdentity\"
  `);
  const checks: Array<[keyof SchemaProbe, string]> = [
    ['coachInvitations', 'CoachInvitation'],
    ['packageScopeColumn', 'LessonPackage.scopeSnapshotSealed'],
    ['packageScopeTrigger', 'LessonPackage scope seal'],
    ['venueUnitIdentity', 'VenueUnit composite identity'],
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
