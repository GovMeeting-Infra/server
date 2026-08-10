-- Runtime configuration a super admin can change without a redeploy.
-- A row is an override; with no row the code keeps using the environment
-- variable it always read, so an empty table means unchanged behaviour.
CREATE TABLE "PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- SET NULL rather than CASCADE: who changed a setting is worth keeping even
-- after that account is removed, and losing the row would silently revert the
-- setting itself.
ALTER TABLE "PlatformSetting" ADD CONSTRAINT "PlatformSetting_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
