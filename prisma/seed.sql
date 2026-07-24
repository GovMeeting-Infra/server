  -- Insert ministries
  INSERT INTO "Ministry" (id, code, name, "emailDomain", "gpsToleranceMeters", "createdAt", "updatedAt")
  VALUES
    ('moh-001', 'MOH', 'Ministry of Health', 'moh.gov.sl', 100, NOW(), NOW()),
    ('med-001', 'MED', 'Ministry of Education', 'med.gov.sl', 100, NOW(), NOW())
  ON CONFLICT DO NOTHING;

  -- Insert users (Note: passwords are stored in Account table)
  INSERT INTO "User" (id, email, name, "systemRole", "ministryId", "emailVerified", "createdAt", "updatedAt")
  VALUES
    ('usr-super-001', 'super@gov.sl', 'Super Admin', 'SUPER_ADMIN', 'moh-001', true, NOW(), NOW()),
    ('usr-admin-001', 'admin@med.gov.sl', 'Admin User', 'MINISTRY_ADMIN', 'med-001', true, NOW(), NOW()),
    ('usr-staff-001', 'staff@moh.gov.sl', 'Staff User', 'STAFF', 'moh-001', true, NOW(), NOW())
  ON CONFLICT DO NOTHING;

  -- Insert test room
  INSERT INTO "Room" (id, name, location, capacity, "ministryId", "createdAt", "updatedAt")
  VALUES ('room-001', 'Conference Room A', 'Building 1, Floor 2', 50, 'moh-001', NOW(), NOW())
  ON CONFLICT DO NOTHING;