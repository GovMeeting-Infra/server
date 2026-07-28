-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."ActionItemStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."AttendeeStatus" AS ENUM ('INVITED', 'CONFIRMED', 'DECLINED', 'NO_RESPONSE');

-- CreateEnum
CREATE TYPE "public"."AuditStatus" AS ENUM ('SUCCESS', 'FAILURE', 'PARTIAL');

-- CreateEnum
CREATE TYPE "public"."BookingPurpose" AS ENUM ('MEETING', 'TRAINING', 'CONFERENCE', 'WORKSHOP', 'INTERVIEW', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."BookingStatus" AS ENUM ('CONFIRMED', 'CANCELLED', 'TENTATIVE');

-- CreateEnum
CREATE TYPE "public"."CheckInMethod" AS ENUM ('QR', 'MANUAL', 'GEO');

-- CreateEnum
CREATE TYPE "public"."EndType" AS ENUM ('COUNT', 'UNTIL', 'NEVER');

-- CreateEnum
CREATE TYPE "public"."EventClassification" AS ENUM ('PUBLIC', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "public"."EventScope" AS ENUM ('OFFICIAL', 'TEAM');

-- CreateEnum
CREATE TYPE "public"."EventStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."EventType" AS ENUM ('MEETING', 'CONFERENCE', 'APPOINTMENT', 'TRAINING', 'WORKSHOP', 'LAUNCH', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."Frequency" AS ENUM ('DAILY', 'WEEKLY', 'WEEKDAYS', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "public"."MinutesStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "public"."PointType" AS ENUM ('ACTION_POINT', 'AGREED', 'DECISION');

-- CreateEnum
CREATE TYPE "public"."SystemRole" AS ENUM ('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF');

-- CreateTable
CREATE TABLE "public"."Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "password" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "idToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ActionItem" (
    "id" TEXT NOT NULL,
    "minutesId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "ownerId" TEXT,
    "ownerName" TEXT,
    "assignedById" TEXT,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "status" "public"."ActionItemStatus" NOT NULL DEFAULT 'TODO',
    "point" "public"."PointType" NOT NULL DEFAULT 'ACTION_POINT',
    "reminderSentAt" TIMESTAMP(3),
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Attendance" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "signedName" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "checkInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkInMethod" "public"."CheckInMethod" NOT NULL,
    "lat" TEXT,
    "lng" TEXT,
    "gpsAccuracy" INTEGER,
    "withinGeofence" BOOLEAN,
    "mockLocationFlag" BOOLEAN NOT NULL DEFAULT false,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AuditLog" (
    "id" TEXT NOT NULL,
    "ministryId" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "actionCategory" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityName" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "status" "public"."AuditStatus" NOT NULL DEFAULT 'SUCCESS',
    "description" TEXT,
    "changes" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Event" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "type" "public"."EventType" NOT NULL DEFAULT 'MEETING',
    "scope" "public"."EventScope",
    "classification" "public"."EventClassification",
    "colorCategory" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "venueName" TEXT,
    "venueLat" DOUBLE PRECISION,
    "venueLng" DOUBLE PRECISION,
    "geofenceRadius" INTEGER NOT NULL DEFAULT 100,
    "status" "public"."EventStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "ministryId" TEXT NOT NULL,
    "organizerId" TEXT,
    "seriesId" TEXT,
    "roomId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "bannerImage" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "externalUrl" TEXT,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EventAttendee" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT,
    "externalName" TEXT,
    "externalEmail" TEXT,
    "status" "public"."AttendeeStatus" NOT NULL DEFAULT 'INVITED',
    "rsvpTokenHash" TEXT,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventAttendee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EventCoOrganizer" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventCoOrganizer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EventSeries" (
    "id" TEXT NOT NULL,
    "frequency" "public"."Frequency" NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "endType" "public"."EndType" NOT NULL DEFAULT 'COUNT',
    "count" INTEGER,
    "until" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventSeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Ministry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "emailDomain" TEXT NOT NULL,
    "compoundMaxGpsAccuracy" INTEGER NOT NULL DEFAULT 75,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "logoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ministry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Minutes" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "summary" TEXT,
    "status" "public"."MinutesStatus" NOT NULL DEFAULT 'DRAFT',
    "draftedById" TEXT,
    "draftedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Minutes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ministryId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "entityType" TEXT,
    "entityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT (now() + '30 days'::interval),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."QRToken" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QRToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Room" (
    "id" TEXT NOT NULL,
    "ministryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "amenities" TEXT[],
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RoomBooking" (
    "id" TEXT NOT NULL,
    "ministryId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "purpose" "public"."BookingPurpose" NOT NULL,
    "attendeeCount" INTEGER NOT NULL,
    "notes" TEXT,
    "status" "public"."BookingStatus" NOT NULL DEFAULT 'CONFIRMED',
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "image" TEXT,
    "jobTitle" TEXT,
    "systemRole" "public"."SystemRole" NOT NULL DEFAULT 'STAFF',
    "ministryId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "loginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."UserPreferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailNotifications" BOOLEAN NOT NULL DEFAULT true,
    "minutesNotifications" BOOLEAN NOT NULL DEFAULT true,
    "meetingReminders" BOOLEAN NOT NULL DEFAULT true,
    "actionItemNotifications" BOOLEAN NOT NULL DEFAULT true,
    "theme" TEXT NOT NULL DEFAULT 'light',
    "compactMode" BOOLEAN NOT NULL DEFAULT false,
    "sessionTimeout" INTEGER NOT NULL DEFAULT 1800,
    "consentTimestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consentVersion" TEXT NOT NULL DEFAULT '1.0',
    "geoLocationConsent" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPreferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."_EventInvitedMinistries" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_EventInvitedMinistries_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "public"."Account"("userId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Account_userId_providerId_accountId_key" ON "public"."Account"("userId" ASC, "providerId" ASC, "accountId" ASC);

-- CreateIndex
CREATE INDEX "ActionItem_dueDate_idx" ON "public"."ActionItem"("dueDate" ASC);

-- CreateIndex
CREATE INDEX "ActionItem_minutesId_idx" ON "public"."ActionItem"("minutesId" ASC);

-- CreateIndex
CREATE INDEX "ActionItem_ownerId_idx" ON "public"."ActionItem"("ownerId" ASC);

-- CreateIndex
CREATE INDEX "ActionItem_status_idx" ON "public"."ActionItem"("status" ASC);

-- CreateIndex
CREATE INDEX "Attendance_checkInAt_idx" ON "public"."Attendance"("checkInAt" ASC);

-- CreateIndex
CREATE INDEX "Attendance_eventId_idx" ON "public"."Attendance"("eventId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_eventId_userId_key" ON "public"."Attendance"("eventId" ASC, "userId" ASC);

-- CreateIndex
CREATE INDEX "Attendance_userId_idx" ON "public"."Attendance"("userId" ASC);

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "public"."AuditLog"("action" ASC);

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "public"."AuditLog"("actorId" ASC);

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "public"."AuditLog"("createdAt" ASC);

-- CreateIndex
CREATE INDEX "AuditLog_ministryId_idx" ON "public"."AuditLog"("ministryId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_requestId_key" ON "public"."AuditLog"("requestId" ASC);

-- CreateIndex
CREATE INDEX "Event_isPublic_idx" ON "public"."Event"("isPublic" ASC);

-- CreateIndex
CREATE INDEX "Event_ministryId_idx" ON "public"."Event"("ministryId" ASC);

-- CreateIndex
CREATE INDEX "Event_startAt_idx" ON "public"."Event"("startAt" ASC);

-- CreateIndex
CREATE INDEX "Event_status_idx" ON "public"."Event"("status" ASC);

-- CreateIndex
CREATE INDEX "EventAttendee_eventId_idx" ON "public"."EventAttendee"("eventId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "EventAttendee_eventId_userId_key" ON "public"."EventAttendee"("eventId" ASC, "userId" ASC);

-- CreateIndex
CREATE INDEX "EventAttendee_rsvpTokenHash_idx" ON "public"."EventAttendee"("rsvpTokenHash" ASC);

-- CreateIndex
CREATE INDEX "EventCoOrganizer_eventId_idx" ON "public"."EventCoOrganizer"("eventId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "EventCoOrganizer_eventId_userId_key" ON "public"."EventCoOrganizer"("eventId" ASC, "userId" ASC);

-- CreateIndex
CREATE INDEX "EventCoOrganizer_userId_idx" ON "public"."EventCoOrganizer"("userId" ASC);

-- CreateIndex
CREATE INDEX "Ministry_active_idx" ON "public"."Ministry"("active" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Ministry_code_key" ON "public"."Ministry"("code" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Ministry_name_key" ON "public"."Ministry"("name" ASC);

-- CreateIndex
CREATE INDEX "Minutes_eventId_idx" ON "public"."Minutes"("eventId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Minutes_eventId_key" ON "public"."Minutes"("eventId" ASC);

-- CreateIndex
CREATE INDEX "Minutes_status_idx" ON "public"."Minutes"("status" ASC);

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "public"."Notification"("createdAt" ASC);

-- CreateIndex
CREATE INDEX "Notification_read_idx" ON "public"."Notification"("read" ASC);

-- CreateIndex
CREATE INDEX "Notification_userId_idx" ON "public"."Notification"("userId" ASC);

-- CreateIndex
CREATE INDEX "QRToken_eventId_idx" ON "public"."QRToken"("eventId" ASC);

-- CreateIndex
CREATE INDEX "QRToken_expiresAt_idx" ON "public"."QRToken"("expiresAt" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "QRToken_token_key" ON "public"."QRToken"("token" ASC);

-- CreateIndex
CREATE INDEX "Room_ministryId_idx" ON "public"."Room"("ministryId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Room_ministryId_name_key" ON "public"."Room"("ministryId" ASC, "name" ASC);

-- CreateIndex
CREATE INDEX "RoomBooking_ministryId_idx" ON "public"."RoomBooking"("ministryId" ASC);

-- CreateIndex
CREATE INDEX "RoomBooking_roomId_idx" ON "public"."RoomBooking"("roomId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "RoomBooking_roomId_startTime_endTime_key" ON "public"."RoomBooking"("roomId" ASC, "startTime" ASC, "endTime" ASC);

-- CreateIndex
CREATE INDEX "RoomBooking_startTime_idx" ON "public"."RoomBooking"("startTime" ASC);

-- CreateIndex
CREATE INDEX "RoomBooking_userId_idx" ON "public"."RoomBooking"("userId" ASC);

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "public"."Session"("expiresAt" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "public"."Session"("token" ASC);

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "public"."Session"("userId" ASC);

-- CreateIndex
CREATE INDEX "User_active_idx" ON "public"."User"("active" ASC);

-- CreateIndex
CREATE INDEX "User_deletedAt_idx" ON "public"."User"("deletedAt" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email" ASC);

-- CreateIndex
CREATE INDEX "User_ministryId_idx" ON "public"."User"("ministryId" ASC);

-- CreateIndex
CREATE INDEX "User_systemRole_idx" ON "public"."User"("systemRole" ASC);

-- CreateIndex
CREATE INDEX "UserPreferences_userId_idx" ON "public"."UserPreferences"("userId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "UserPreferences_userId_key" ON "public"."UserPreferences"("userId" ASC);

-- CreateIndex
CREATE INDEX "Verification_identifier_idx" ON "public"."Verification"("identifier" ASC);

-- CreateIndex
CREATE INDEX "_EventInvitedMinistries_B_index" ON "public"."_EventInvitedMinistries"("B" ASC);

-- AddForeignKey
ALTER TABLE "public"."Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ActionItem" ADD CONSTRAINT "ActionItem_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ActionItem" ADD CONSTRAINT "ActionItem_minutesId_fkey" FOREIGN KEY ("minutesId") REFERENCES "public"."Minutes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ActionItem" ADD CONSTRAINT "ActionItem_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Attendance" ADD CONSTRAINT "Attendance_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Attendance" ADD CONSTRAINT "Attendance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AuditLog" ADD CONSTRAINT "AuditLog_ministryId_fkey" FOREIGN KEY ("ministryId") REFERENCES "public"."Ministry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_ministryId_fkey" FOREIGN KEY ("ministryId") REFERENCES "public"."Ministry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "public"."Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "public"."EventSeries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EventAttendee" ADD CONSTRAINT "EventAttendee_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EventAttendee" ADD CONSTRAINT "EventAttendee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EventCoOrganizer" ADD CONSTRAINT "EventCoOrganizer_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EventCoOrganizer" ADD CONSTRAINT "EventCoOrganizer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Minutes" ADD CONSTRAINT "Minutes_draftedById_fkey" FOREIGN KEY ("draftedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Minutes" ADD CONSTRAINT "Minutes_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Minutes" ADD CONSTRAINT "Minutes_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Notification" ADD CONSTRAINT "Notification_ministryId_fkey" FOREIGN KEY ("ministryId") REFERENCES "public"."Ministry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."QRToken" ADD CONSTRAINT "QRToken_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Room" ADD CONSTRAINT "Room_ministryId_fkey" FOREIGN KEY ("ministryId") REFERENCES "public"."Ministry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RoomBooking" ADD CONSTRAINT "RoomBooking_ministryId_fkey" FOREIGN KEY ("ministryId") REFERENCES "public"."Ministry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RoomBooking" ADD CONSTRAINT "RoomBooking_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "public"."Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RoomBooking" ADD CONSTRAINT "RoomBooking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."User" ADD CONSTRAINT "User_ministryId_fkey" FOREIGN KEY ("ministryId") REFERENCES "public"."Ministry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserPreferences" ADD CONSTRAINT "UserPreferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_EventInvitedMinistries" ADD CONSTRAINT "_EventInvitedMinistries_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_EventInvitedMinistries" ADD CONSTRAINT "_EventInvitedMinistries_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."Ministry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

