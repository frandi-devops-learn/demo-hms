import { Controller, Get, Inject, Logger, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SsrService } from './ssr.service';

@Controller()
export class SsrController {
  private readonly logger = new Logger(SsrController.name);

  constructor(@Inject(SsrService) private readonly ssr: SsrService) {}

  @Get('{*path}')
  async page(@Req() request: Request, @Res() response: Response) {
    try {
      const { html, nonce } = await this.ssr.render(request);
      const development = process.env.NODE_ENV !== 'production';
      const scriptPolicy = development
        ? `'self' 'nonce-${nonce}' 'unsafe-eval'`
        : `'self' 'nonce-${nonce}'`;
      const stylePolicy = development ? `'self' 'unsafe-inline'` : `'self'`;
      const connectPolicy = development ? `'self' ws:` : `'self'`;

      response
        .setHeader('Cache-Control', 'no-store')
        .setHeader(
          'Content-Security-Policy',
          `default-src 'self'; img-src 'self' data:; style-src ${stylePolicy}; `
            + `script-src ${scriptPolicy}; connect-src ${connectPolicy}`,
        )
        .status(200)
        .type('html')
        .send(html);
    } catch (error) {
      const caught = error instanceof Error ? error : new Error('Unknown SSR error');
      this.ssr.fixStacktrace(caught);
      this.logger.error(`SSR request failed: ${caught.message}`, caught.stack);
      response.status(500).type('text').send('Unable to render the portal');
    }
  }
}
