import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { ApiRateLimitMiddleware } from './security/rate-limit.middleware';
import { securityHeaders } from './security/security-headers.middleware';
import { originCheck } from './security/origin-check.middleware';

async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env);
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  app.setGlobalPrefix('api');
  app.getHttpAdapter().getInstance().set('trust proxy', config.trustProxyHops);
  app.use(securityHeaders(config.isProduction));
  app.use(json({ limit: config.bodyLimit }));
  app.use(urlencoded({ extended: false, limit: config.bodyLimit }));
  app.use(originCheck(config.frontendOrigins));
  app.use(
    new ApiRateLimitMiddleware(
      config.rateLimitMax,
      config.rateLimitWindowMs,
      config.authRateLimitMax,
      config.authRateLimitWindowMs,
    ).use,
  );
  app.enableCors({
    origin: config.frontendOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-App-Name', 'X-App-Version', 'X-App-Device'],
    credentials: true,
    maxAge: 600,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }),
  );

  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
}

void bootstrap();
