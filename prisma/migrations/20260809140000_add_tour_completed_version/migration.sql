-- Which version of the guided tour the user has finished or dismissed.
-- Nullable, and null means "never seen": every existing user is therefore
-- offered the tour on their next sign-in, which is the intended behaviour for a
-- feature nobody has been shown yet.
ALTER TABLE "UserPreferences" ADD COLUMN "tourCompletedVersion" TEXT;
