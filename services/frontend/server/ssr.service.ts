import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Injectable, Logger } from '@nestjs/common';
import express, { type Express, type Request } from 'express';

type InitialData = {
  roomTypes: unknown[];
  rooms: unknown[];
  catalogLoaded: boolean;
};

type Render = (initialData: InitialData) => string | Promise<string>;

@Injectable()
export class SsrService {
  private readonly logger = new Logger(SsrService.name);
  private readonly root = process.cwd();
  private readonly production = process.env.NODE_ENV === 'production';
  private readonly apiGateway = process.env.API_GATEWAY_URL || 'http://api-gateway:3000';
  private productionTemplate = '';
  private productionRender?: Render;
  private vite?: Awaited<ReturnType<typeof import('vite')['createServer']>>;

  async initialize(app: Express) {
    if (this.production) {
      this.productionTemplate = await fs.readFile(path.join(this.root, 'dist/client/index.html'), 'utf8');
      const serverBundle = pathToFileURL(path.join(this.root, 'dist/server/entry-server.js')).href;
      ({ render: this.productionRender } = await import(serverBundle));
      app.use('/assets', express.static(path.join(this.root, 'dist/client/assets'), {
        immutable: true,
        maxAge: '1y',
      }));
      app.use('/images', express.static(path.join(this.root, 'dist/client/images'), { maxAge: '30d' }));
      return;
    }

    const { createServer } = await import('vite');
    this.vite = await createServer({
      root: this.root,
      server: { middlewareMode: true },
      appType: 'custom',
    });
    app.use(this.vite.middlewares);
  }

  async render(request: Request) {
    const initialData = await this.loadCatalogue();
    const nonce = crypto.randomBytes(18).toString('base64');
    let template: string;
    let render: Render;

    if (this.production) {
      template = this.productionTemplate;
      if (!this.productionRender) throw new Error('Production render bundle is not initialized');
      render = this.productionRender;
    } else {
      template = await fs.readFile(path.join(this.root, 'index.html'), 'utf8');
      template = await this.vite!.transformIndexHtml(request.originalUrl, template);
      ({ render } = await this.vite!.ssrLoadModule('/src/entry-server.jsx'));
    }

    const appHtml = await render(initialData);
    const serialized = JSON.stringify(initialData).replaceAll('<', '\\u003c');
    const html = template
      .replace('<!--app-html-->', appHtml)
      .replace('<!--initial-data-->', serialized)
      .replaceAll('<!--nonce-->', nonce);

    return { html, nonce };
  }

  fixStacktrace(error: Error) {
    this.vite?.ssrFixStacktrace(error);
  }

  private async loadCatalogue(): Promise<InitialData> {
    try {
      const [typesResponse, roomsResponse] = await Promise.all([
        fetch(`${this.apiGateway}/api/rooms/room-types`, { signal: AbortSignal.timeout(4000) }),
        fetch(`${this.apiGateway}/api/rooms?status=active`, { signal: AbortSignal.timeout(4000) }),
      ]);
      if (!typesResponse.ok || !roomsResponse.ok) throw new Error('Catalogue request failed');
      return {
        roomTypes: await typesResponse.json() as unknown[],
        rooms: await roomsResponse.json() as unknown[],
        catalogLoaded: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown catalogue error';
      this.logger.warn(`SSR catalogue unavailable: ${message}`);
      return { roomTypes: [], rooms: [], catalogLoaded: false };
    }
  }
}
