// First import on purpose: modules pulled in below can read process.env while
// they are being evaluated, which is well before ConfigModule.forRoot() loads
// .env. auth.config.ts did exactly that and connected to the wrong database.
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import * as promClient from 'prom-client';
import { AppModule } from './app.module';

async function bootstrap() {
  console.log('[Bootstrap] Starting...');
  const app = await NestFactory.create(AppModule, {
    bodyParser: true,
  });
  console.log('[Bootstrap] AppModule created');

  app.use(helmet());

  // nginx terminates TLS and forwards X-Forwarded-For; without this req.ip is
  // the proxy, and the IP recorded against every check-in would be useless.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.enableVersioning({
    type: VersioningType.URI,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors({
    origin: (process.env.CORS_ORIGIN || '').split(',').filter(Boolean),
    credentials: process.env.CORS_CREDENTIALS === 'true',
  });

  // Setup Prometheus metrics
  const httpRequestDuration = new promClient.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.1, 0.5, 1, 2, 5],
  });

  const httpRequestTotal = new promClient.Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status_code'],
  });

  const dbQueryDuration = new promClient.Histogram({
    name: 'db_query_duration_seconds',
    help: 'Duration of database queries in seconds',
    labelNames: ['query_type', 'table'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1],
  });

  // Metrics middleware
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = (Date.now() - start) / 1000;
      const route = req.route?.path || req.url;
      httpRequestDuration
        .labels(req.method, route, res.statusCode)
        .observe(duration);
      httpRequestTotal.labels(req.method, route, res.statusCode).inc();
    });
    next();
  });

  // Metrics endpoint
  app.use('/api/v1/metrics', (req, res) => {
    res.set('Content-Type', promClient.register.contentType);
    res.end(promClient.register.metrics());
  });

  const config = new DocumentBuilder()
    .setTitle('GovMeeting API')
    .setDescription('Smart Meeting & Attendance Logger API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api-docs', app, document);

  const port = parseInt(process.env.APP_PORT || '3000', 10);
  console.log(`[Bootstrap] About to listen on port ${port}...`);
  await app.listen(port);
  console.log(`✅ API running on http://localhost:${port}`);
  console.log(
    `📊 Prometheus metrics available at http://localhost:${port}/api/v1/metrics`,
  );
}

bootstrap().catch((err) => {
  console.error('❌ Failed to bootstrap:', err);
  process.exit(1);
});
