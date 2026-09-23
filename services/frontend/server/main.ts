import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import compression from 'compression';
import type { Express } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { AppModule } from './app.module';
import { SsrService } from './ssr.service';

async function bootstrap() {
  const port = Number(process.env.PORT || 8080);
  const production = process.env.NODE_ENV === 'production';
  const apiGateway = process.env.API_GATEWAY_URL || 'http://api-gateway:3000';
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const expressApp = app.getHttpAdapter().getInstance<Express>();

  expressApp.disable('x-powered-by');
  expressApp.set('trust proxy', 1);
  app.use(compression());
  app.use((request, response, next) => {
    const suppliedId = String(request.headers['x-request-id'] || '');
    const requestId = /^[a-zA-Z0-9._:-]{1,128}$/.test(suppliedId) ? suppliedId : randomUUID();
    const started = process.hrtime.bigint();
    request.headers['x-request-id'] = requestId;
    response.setHeader('x-request-id', requestId);
    response.on('finish', () => {
      const path = String(request.originalUrl || request.url || '/').split('?')[0];
      if (path === '/health' && response.statusCode < 400 && process.env.LOG_HEALTH_REQUESTS !== 'true') return;
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const level = response.statusCode >= 500 ? 'error'
        : response.statusCode >= 400 || durationMs >= Number(process.env.SLOW_REQUEST_MS || 1000) ? 'warn' : 'info';
      console.log(JSON.stringify({
        ts: new Date().toISOString(), level, service: 'frontend', logType: 'access',
        msg: 'http request completed', requestId, method: request.method, path,
        statusCode: response.statusCode, durationMs: Number(durationMs.toFixed(2)),
      }));
    });
    next();
  });
  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use(createProxyMiddleware({
    target: apiGateway,
    changeOrigin: true,
    xfwd: true,
    pathFilter: '/api/**',
    on: {
      error(error, _request, response) {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          message: 'API gateway unavailable',
          detail: production ? undefined : error.message,
        }));
      },
    },
  }));

  await app.get(SsrService).initialize(expressApp);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`NestJS SSR frontend listening on port ${port}`);
}

bootstrap().catch((error) => {
  new Logger('Bootstrap').error('NestJS SSR frontend failed to start', error);
  process.exitCode = 1;
});
