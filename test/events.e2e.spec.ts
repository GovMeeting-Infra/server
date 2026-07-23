import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Events API (e2e)', () => {
  let app: INestApplication;
  let authToken: string;
  let eventId: string;
  let roomId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();

    // TODO: Setup test database and seed data
    // TODO: Authenticate to get token
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/v1/events', () => {
    it('should create an event with valid data', async () => {
      const createEventDto = {
        title: 'Test Event',
        description: 'Test Description',
        startAt: new Date('2026-08-01T10:00:00').toISOString(),
        endAt: new Date('2026-08-01T12:00:00').toISOString(),
        venueName: 'Test Venue',
        type: 'MEETING',
      };

      const response = await request(app.getHttpServer())
        .post('/api/v1/events')
        .set('Authorization', `Bearer ${authToken}`)
        .send(createEventDto)
        .expect(201);

      expect(response.body.id).toBeDefined();
      expect(response.body.title).toBe(createEventDto.title);
      eventId = response.body.id;
    });

    it('should reject invalid start/end times', async () => {
      const createEventDto = {
        title: 'Invalid Event',
        startAt: new Date('2026-08-01T12:00:00').toISOString(),
        endAt: new Date('2026-08-01T10:00:00').toISOString(),
      };

      await request(app.getHttpServer())
        .post('/api/v1/events')
        .set('Authorization', `Bearer ${authToken}`)
        .send(createEventDto)
        .expect(400);
    });

    it('should reject when missing required fields', async () => {
      const createEventDto = {
        title: 'Incomplete Event',
        // missing startAt and endAt
      };

      await request(app.getHttpServer())
        .post('/api/v1/events')
        .set('Authorization', `Bearer ${authToken}`)
        .send(createEventDto)
        .expect(400);
    });

    it('should detect room conflicts', async () => {
      // Create first event
      const firstEvent = {
        title: 'Event 1',
        startAt: new Date('2026-08-01T10:00:00').toISOString(),
        endAt: new Date('2026-08-01T11:00:00').toISOString(),
        roomId: roomId,
      };

      await request(app.getHttpServer())
        .post('/api/v1/events')
        .set('Authorization', `Bearer ${authToken}`)
        .send(firstEvent)
        .expect(201);

      // Attempt overlapping event in same room
      const conflictingEvent = {
        title: 'Event 2 - Conflict',
        startAt: new Date('2026-08-01T10:30:00').toISOString(),
        endAt: new Date('2026-08-01T11:30:00').toISOString(),
        roomId: roomId,
      };

      await request(app.getHttpServer())
        .post('/api/v1/events')
        .set('Authorization', `Bearer ${authToken}`)
        .send(conflictingEvent)
        .expect(400);
    });
  });

  describe('GET /api/v1/events', () => {
    it('should list events with pagination', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/events?page=1&limit=10')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.pagination).toBeDefined();
    });

    it('should filter events by date range', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/events?startDate=2026-08-01&endDate=2026-08-31')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe('GET /api/v1/events/:id', () => {
    it('should get event by id', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/events/${eventId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.id).toBe(eventId);
    });

    it('should return 404 for nonexistent event', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/events/nonexistent-id')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(404);
    });
  });

  describe('PATCH /api/v1/events/:id', () => {
    it('should update event', async () => {
      const updateDto = {
        title: 'Updated Title',
        description: 'Updated Description',
      };

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/events/${eventId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(updateDto)
        .expect(200);

      expect(response.body.title).toBe(updateDto.title);
    });

    it('should reject unauthorized updates', async () => {
      const updateDto = {
        title: 'Unauthorized Update',
      };

      await request(app.getHttpServer())
        .patch(`/api/v1/events/${eventId}`)
        .set('Authorization', `Bearer invalid-token`)
        .send(updateDto)
        .expect(401);
    });
  });

  describe('DELETE /api/v1/events/:id', () => {
    it('should delete event', async () => {
      // Create an event to delete
      const createDto = {
        title: 'Event to Delete',
        startAt: new Date('2026-09-01T10:00:00').toISOString(),
        endAt: new Date('2026-09-01T12:00:00').toISOString(),
      };

      const createResponse = await request(app.getHttpServer())
        .post('/api/v1/events')
        .set('Authorization', `Bearer ${authToken}`)
        .send(createDto)
        .expect(201);

      const idToDelete = createResponse.body.id;

      // Delete the event
      await request(app.getHttpServer())
        .delete(`/api/v1/events/${idToDelete}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(204);

      // Verify deletion
      await request(app.getHttpServer())
        .get(`/api/v1/events/${idToDelete}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(404);
    });
  });
});
